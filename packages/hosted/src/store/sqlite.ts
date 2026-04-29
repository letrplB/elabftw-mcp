/**
 * SQLite-file backend for the registration store.
 *
 * Uses `better-sqlite3` — the boring, stable Node binding for SQLite
 * (vs `node:sqlite`, which is still flagged experimental in Node 22
 * LTS). Prebuilt binaries cover macOS (arm64/x64) and Linux glibc
 * (x64/arm64), so no native compile is needed on either dev machines or
 * the Docker image. Alpine images would need build tools — we use
 * `node:22-slim` (debian-slim) instead.
 *
 * WAL journal mode for safe concurrent readers; the file itself is
 * chmodded to 0o600 on first creation.
 *
 * Same `RegistrationStore` contract as the JSON backend. Pick at
 * startup with `MCP_STORE_BACKEND=sqlite`. The path env var
 * (`MCP_REGISTRATIONS_PATH`) becomes the database file.
 *
 * Why this exists alongside JSON: every JSON write rewrites the whole
 * file. At a few hundred tokens — or once `lastUsedAt` updates fire on
 * every MCP tool call — that's wasted I/O. SQLite gives row-level
 * updates and indexed `(userid, base_url)` lookups for the manage
 * page.
 */

import { existsSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import Database, { type Database as DatabaseInstance } from 'better-sqlite3';
import {
  type AddTeamInput,
  type CreateInput,
  type Registration,
  type RegistrationKey,
  type RegistrationStore,
  mintToken,
  normaliseBaseUrl,
} from './index';

const SCHEMA_VERSION = 2;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS registrations (
    token                  TEXT PRIMARY KEY,
    base_url               TEXT NOT NULL,
    userid                 INTEGER NOT NULL,
    keys_json              TEXT NOT NULL,
    default_team           INTEGER NOT NULL,
    allow_writes           INTEGER NOT NULL DEFAULT 0,
    allow_destructive      INTEGER NOT NULL DEFAULT 0,
    reveal_user_identities INTEGER NOT NULL DEFAULT 0,
    label                  TEXT,
    created_at             TEXT NOT NULL,
    last_used_at           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_registrations_user
    ON registrations (userid, base_url);
`;

interface RegistrationRow {
  token: string;
  base_url: string;
  userid: number;
  keys_json: string;
  default_team: number;
  allow_writes: number;
  allow_destructive: number;
  reveal_user_identities: number;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

function rowToRegistration(row: RegistrationRow): Registration {
  let keys: RegistrationKey[];
  try {
    keys = JSON.parse(row.keys_json) as RegistrationKey[];
  } catch {
    keys = [];
  }
  return {
    token: row.token,
    baseUrl: row.base_url,
    userid: row.userid,
    keys,
    defaultTeam: row.default_team,
    allowWrites: row.allow_writes !== 0,
    allowDestructive: row.allow_destructive !== 0,
    revealUserIdentities: row.reveal_user_identities !== 0,
    label: row.label ?? undefined,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
  };
}

export class SqliteRegistrationStore implements RegistrationStore {
  private readonly db: DatabaseInstance;

  private constructor(db: DatabaseInstance) {
    this.db = db;
  }

  static async open(path: string): Promise<SqliteRegistrationStore> {
    const absPath = resolve(path);
    const isNew = !existsSync(absPath);
    if (isNew) {
      await mkdir(dirname(absPath), { recursive: true });
    }

    const db = new Database(absPath);

    // WAL: lets readers and writers coexist without blocking each
    // other. Recommended for any non-trivial workload.
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Pin schema version for future migrations. SQLite's `user_version`
    // is a single integer in the file header.
    const currentVersion = db.pragma('user_version', { simple: true }) as number;

    if (currentVersion === 0) {
      db.exec(SCHEMA_SQL);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else if (currentVersion === 1) {
      // biome-ignore lint/suspicious/noConsole: startup migration notice
      console.error(
        `[elabftw-mcp] ${absPath} is SQLite schema v1 (single-key, no flags). ` +
          `Dropping the old table and recreating empty — re-register tokens via /register.`
      );
      db.exec('DROP TABLE IF EXISTS registrations');
      db.exec(SCHEMA_SQL);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else if (currentVersion !== SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `${absPath} is SQLite schema v${currentVersion}; this build expects ` +
          `v${SCHEMA_VERSION}. No migration path is implemented yet.`
      );
    }

    if (isNew) {
      // Tighten file mode the same way the JSON store does. SQLite
      // creates the file with default umask; chmod after the fact is
      // safe because no rows have been written yet.
      try {
        await chmod(absPath, 0o600);
      } catch {
        // Non-fatal. The volume mount in the Docker image is already
        // owned by the elabftw user; bare-metal deployments inherit
        // umask. Operators who care should set umask 077 in the
        // service unit.
      }
    }

    return new SqliteRegistrationStore(db);
  }

  get(token: string): Registration | undefined {
    const row = this.db
      .prepare('SELECT * FROM registrations WHERE token = ?')
      .get(token) as RegistrationRow | undefined;
    return row ? rowToRegistration(row) : undefined;
  }

  list(): Registration[] {
    const rows = this.db
      .prepare('SELECT * FROM registrations ORDER BY created_at')
      .all() as RegistrationRow[];
    return rows.map(rowToRegistration);
  }

  listForUser(userid: number, baseUrl: string): Registration[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM registrations WHERE userid = ? AND base_url = ? ORDER BY created_at'
      )
      .all(userid, normaliseBaseUrl(baseUrl)) as RegistrationRow[];
    return rows.map(rowToRegistration);
  }

  async create(input: CreateInput): Promise<Registration> {
    const reg: Registration = {
      token: mintToken(),
      baseUrl: normaliseBaseUrl(input.baseUrl),
      userid: input.userid,
      keys: [
        {
          apiKey: input.apiKey,
          team: input.team,
          label: input.keyLabel,
        },
      ],
      defaultTeam: input.team,
      allowWrites: input.allowWrites ?? false,
      allowDestructive: input.allowDestructive ?? false,
      revealUserIdentities: input.revealUserIdentities ?? false,
      label: input.label,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO registrations
           (token, base_url, userid, keys_json, default_team,
            allow_writes, allow_destructive, reveal_user_identities,
            label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        reg.token,
        reg.baseUrl,
        reg.userid,
        JSON.stringify(reg.keys),
        reg.defaultTeam,
        reg.allowWrites ? 1 : 0,
        reg.allowDestructive ? 1 : 0,
        reg.revealUserIdentities ? 1 : 0,
        reg.label ?? null,
        reg.createdAt
      );
    return reg;
  }

  async updateLabel(
    userid: number,
    baseUrl: string,
    token: string,
    label: string | undefined
  ): Promise<Registration | undefined> {
    const existing = this.assertOwned(userid, baseUrl, token);
    if (!existing) return undefined;
    this.db
      .prepare('UPDATE registrations SET label = ? WHERE token = ?')
      .run(label ?? null, token);
    return { ...existing, label };
  }

  async updateFlags(
    userid: number,
    baseUrl: string,
    token: string,
    flags: {
      allowWrites: boolean;
      allowDestructive: boolean;
      revealUserIdentities: boolean;
    }
  ): Promise<Registration | undefined> {
    const existing = this.assertOwned(userid, baseUrl, token);
    if (!existing) return undefined;
    const allowDestructive = flags.allowDestructive && flags.allowWrites;
    this.db
      .prepare(
        `UPDATE registrations
         SET allow_writes = ?, allow_destructive = ?, reveal_user_identities = ?
         WHERE token = ?`
      )
      .run(
        flags.allowWrites ? 1 : 0,
        allowDestructive ? 1 : 0,
        flags.revealUserIdentities ? 1 : 0,
        token
      );
    return {
      ...existing,
      allowWrites: flags.allowWrites,
      allowDestructive,
      revealUserIdentities: flags.revealUserIdentities,
    };
  }

  async updateDefaultTeam(
    userid: number,
    baseUrl: string,
    token: string,
    team: number
  ): Promise<Registration | undefined> {
    const existing = this.assertOwned(userid, baseUrl, token);
    if (!existing) return undefined;
    if (!existing.keys.some((k) => k.team === team)) return existing;
    this.db
      .prepare('UPDATE registrations SET default_team = ? WHERE token = ?')
      .run(team, token);
    return { ...existing, defaultTeam: team };
  }

  /**
   * Mirror of the JSON store's `assertOwned` — fetches a registration
   * and rejects if it doesn't belong to the calling user.
   */
  private assertOwned(
    userid: number,
    baseUrl: string,
    token: string
  ): Registration | undefined {
    const reg = this.get(token);
    if (!reg) return undefined;
    if (reg.userid !== userid || reg.baseUrl !== normaliseBaseUrl(baseUrl)) {
      return undefined;
    }
    return reg;
  }

  async addKey(
    userid: number,
    baseUrl: string,
    input: AddTeamInput
  ): Promise<Registration | undefined> {
    const existing = this.get(input.token);
    if (!existing) return undefined;
    if (
      existing.userid !== userid ||
      existing.baseUrl !== normaliseBaseUrl(baseUrl)
    ) {
      return undefined;
    }
    if (existing.keys.some((k) => k.team === input.team)) {
      return existing;
    }
    const nextKeys = [
      ...existing.keys,
      { apiKey: input.apiKey, team: input.team, label: input.label },
    ];
    this.db
      .prepare('UPDATE registrations SET keys_json = ? WHERE token = ?')
      .run(JSON.stringify(nextKeys), input.token);
    return { ...existing, keys: nextKeys };
  }

  async removeKey(
    userid: number,
    baseUrl: string,
    token: string,
    team: number
  ): Promise<Registration | undefined> {
    const existing = this.get(token);
    if (!existing) return undefined;
    if (
      existing.userid !== userid ||
      existing.baseUrl !== normaliseBaseUrl(baseUrl)
    ) {
      return undefined;
    }
    if (existing.keys.length <= 1) return existing;
    const nextKeys = existing.keys.filter((k) => k.team !== team);
    if (nextKeys.length === existing.keys.length) return existing;
    let nextDefault = existing.defaultTeam;
    if (nextDefault === team) {
      nextDefault = nextKeys.reduce(
        (lo, k) => (k.team < lo ? k.team : lo),
        nextKeys[0]!.team
      );
    }
    this.db
      .prepare(
        'UPDATE registrations SET keys_json = ?, default_team = ? WHERE token = ?'
      )
      .run(JSON.stringify(nextKeys), nextDefault, token);
    return { ...existing, keys: nextKeys, defaultTeam: nextDefault };
  }

  async revoke(token: string): Promise<boolean> {
    const result = this.db
      .prepare('DELETE FROM registrations WHERE token = ?')
      .run(token);
    return result.changes > 0;
  }

  async revokeForUser(
    userid: number,
    baseUrl: string,
    token: string
  ): Promise<boolean> {
    const result = this.db
      .prepare(
        'DELETE FROM registrations WHERE token = ? AND userid = ? AND base_url = ?'
      )
      .run(token, userid, normaliseBaseUrl(baseUrl));
    return result.changes > 0;
  }

  /**
   * Best-effort `lastUsedAt` update. Single-row UPDATE rather than
   * full-file rewrite — the whole reason this backend exists.
   */
  async touch(token: string): Promise<void> {
    try {
      this.db
        .prepare('UPDATE registrations SET last_used_at = ? WHERE token = ?')
        .run(new Date().toISOString(), token);
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: non-fatal diagnostic
      console.error(
        `[elabftw-mcp] Failed to update lastUsedAt: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
