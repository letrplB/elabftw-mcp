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
  type CreateInput,
  type Registration,
  type RegistrationStore,
  mintToken,
  normaliseBaseUrl,
} from './index';

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS registrations (
    token        TEXT PRIMARY KEY,
    api_key      TEXT NOT NULL,
    base_url     TEXT NOT NULL,
    userid       INTEGER NOT NULL,
    team         INTEGER NOT NULL,
    label        TEXT,
    created_at   TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_registrations_user
    ON registrations (userid, base_url);
`;

interface RegistrationRow {
  token: string;
  api_key: string;
  base_url: string;
  userid: number;
  team: number;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

function rowToRegistration(row: RegistrationRow): Registration {
  return {
    token: row.token,
    apiKey: row.api_key,
    baseUrl: row.base_url,
    userid: row.userid,
    team: row.team,
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
      apiKey: input.apiKey,
      baseUrl: normaliseBaseUrl(input.baseUrl),
      userid: input.userid,
      team: input.team,
      label: input.label,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO registrations
           (token, api_key, base_url, userid, team, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        reg.token,
        reg.apiKey,
        reg.baseUrl,
        reg.userid,
        reg.team,
        reg.label ?? null,
        reg.createdAt
      );
    return reg;
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
