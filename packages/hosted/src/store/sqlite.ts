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
 * WAL journal mode for safe concurrent readers. File modes: the server
 * runs with umask 077, so the db and its `-wal` / `-shm` side files are
 * created 0600; pre-existing files are chmodded on open.
 * `secure_delete` is on so revoked rows are zeroed rather than left in
 * free pages.
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
 *
 * Schema versions (`PRAGMA user_version`):
 *   - v1: single-key, no flags — dropped on open, as before.
 *   - v2: plaintext `token` primary key + plaintext API keys — migrated
 *     in place to v3 (token → sha256, keys → AES-256-GCM), then VACUUMed
 *     so the plaintext doesn't survive in free pages.
 *   - v3: current.
 */

import { existsSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import Database, { type Database as DatabaseInstance } from 'better-sqlite3';
import { hashToken, isEncrypted, type SecretBox } from './crypto';
import {
  type AddTeamInput,
  type CreateInput,
  type CreateResult,
  type Registration,
  type RegistrationKey,
  type RegistrationStore,
  TokenLimitError,
  type UpdatePatch,
  applyPatch,
  applyRemoveKey,
  buildRegistration,
  normaliseBaseUrl,
} from './index';

const SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS registrations (
    token_hash             TEXT PRIMARY KEY,
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
  token_hash: string;
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

/** v2 rows: same columns, but keyed by the plaintext token. */
type LegacyRowV2 = Omit<RegistrationRow, 'token_hash'> & { token: string };

const INSERT_SQL = `INSERT INTO registrations
  (token_hash, base_url, userid, keys_json, default_team,
   allow_writes, allow_destructive, reveal_user_identities,
   label, created_at, last_used_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export class SqliteRegistrationStore implements RegistrationStore {
  private readonly db: DatabaseInstance;
  private readonly secrets: SecretBox;

  private constructor(db: DatabaseInstance, secrets: SecretBox) {
    this.db = db;
    this.secrets = secrets;
  }

  static async open(
    path: string,
    secrets: SecretBox
  ): Promise<SqliteRegistrationStore> {
    const absPath = resolve(path);
    if (!existsSync(absPath)) {
      await mkdir(dirname(absPath), { recursive: true, mode: 0o700 });
    }

    const db = new Database(absPath);
    // Tighten modes on files left behind by older versions (the process
    // umask covers anything created from here on).
    for (const p of [absPath, `${absPath}-wal`, `${absPath}-shm`]) {
      if (existsSync(p)) await chmod(p, 0o600).catch(() => {});
    }

    // WAL: lets readers and writers coexist without blocking each
    // other. Recommended for any non-trivial workload.
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('secure_delete = ON');

    const store = new SqliteRegistrationStore(db, secrets);

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
    } else if (currentVersion === 2) {
      const n = store.migrateFromV2();
      // biome-ignore lint/suspicious/noConsole: startup migration notice
      console.error(
        `[elabftw-mcp] Migrated ${n} registration(s) in ${absPath} from SQLite ` +
          `schema v2 to v${SCHEMA_VERSION} (hashed tokens, encrypted API keys). ` +
          'Existing tokens keep working. Older backups of this database still ' +
          'contain plaintext secrets — rotate or destroy them.'
      );
    } else if (currentVersion !== SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `${absPath} is SQLite schema v${currentVersion}; this build expects ` +
          `v${SCHEMA_VERSION}. No migration path is implemented yet.`
      );
    }

    store.encryptStrayPlaintextKeys(absPath);
    return store;
  }

  /**
   * v2 → v3 in one transaction: rebuild the table keyed by token hash
   * with encrypted keys, then VACUUM + truncate the WAL so no page with
   * a plaintext token or key survives on disk.
   */
  private migrateFromV2(): number {
    const migrate = this.db.transaction(() => {
      const rows = this.db
        .prepare('SELECT * FROM registrations')
        .all() as LegacyRowV2[];
      this.db.exec('DROP TABLE registrations');
      this.db.exec('DROP INDEX IF EXISTS idx_registrations_user');
      this.db.exec(SCHEMA_SQL);
      const insert = this.db.prepare(INSERT_SQL);
      for (const row of rows) {
        const keys = parseKeys(row.keys_json).map((k) => ({
          ...k,
          apiKey: this.secrets.ensureEncrypted(k.apiKey),
        }));
        insert.run(
          hashToken(row.token),
          normaliseBaseUrl(row.base_url),
          row.userid,
          JSON.stringify(keys),
          row.default_team,
          row.allow_writes,
          row.allow_destructive,
          row.reveal_user_identities,
          row.label,
          row.created_at,
          row.last_used_at
        );
      }
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      return rows.length;
    });
    const n = migrate();
    this.db.exec('VACUUM');
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    return n;
  }

  /** Encrypt any plaintext API key that got into a v3 db (hand edits). */
  private encryptStrayPlaintextKeys(absPath: string): void {
    const rows = this.db
      .prepare('SELECT token_hash, keys_json FROM registrations')
      .all() as Array<Pick<RegistrationRow, 'token_hash' | 'keys_json'>>;
    const update = this.db.prepare(
      'UPDATE registrations SET keys_json = ? WHERE token_hash = ?'
    );
    let fixed = 0;
    for (const row of rows) {
      const keys = parseKeys(row.keys_json);
      if (keys.every((k) => isEncrypted(k.apiKey))) continue;
      update.run(
        JSON.stringify(
          keys.map((k) => ({ ...k, apiKey: this.secrets.ensureEncrypted(k.apiKey) }))
        ),
        row.token_hash
      );
      fixed++;
    }
    if (fixed > 0) {
      // biome-ignore lint/suspicious/noConsole: startup migration notice
      console.error(
        `[elabftw-mcp] Encrypted plaintext API keys on ${fixed} registration(s) in ${absPath}.`
      );
    }
  }

  get(tokenHash: string): Registration | undefined {
    const row = this.db
      .prepare('SELECT * FROM registrations WHERE token_hash = ?')
      .get(tokenHash) as RegistrationRow | undefined;
    return row ? this.rowToRegistration(row) : undefined;
  }

  list(): Registration[] {
    const rows = this.db
      .prepare('SELECT * FROM registrations ORDER BY created_at')
      .all() as RegistrationRow[];
    return rows.map((r) => this.rowToRegistration(r));
  }

  listForUser(userid: number, baseUrl: string): Registration[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM registrations WHERE userid = ? AND base_url = ? ORDER BY created_at'
      )
      .all(userid, normaliseBaseUrl(baseUrl)) as RegistrationRow[];
    return rows.map((r) => this.rowToRegistration(r));
  }

  async create(input: CreateInput): Promise<CreateResult> {
    const created = buildRegistration(input);
    const reg = created.registration;
    // better-sqlite3 is synchronous, so count + insert in one
    // transaction can't race another mint.
    this.db.transaction(() => {
      if (input.maxTokensPerUser !== undefined) {
        const { n } = this.db
          .prepare(
            'SELECT COUNT(*) AS n FROM registrations WHERE userid = ? AND base_url = ?'
          )
          .get(reg.userid, reg.baseUrl) as { n: number };
        if (n >= input.maxTokensPerUser) {
          throw new TokenLimitError(input.maxTokensPerUser);
        }
      }
      this.db
        .prepare(INSERT_SQL)
        .run(
          reg.tokenHash,
          reg.baseUrl,
          reg.userid,
          this.encryptKeys(reg.keys),
          reg.defaultTeam,
          reg.allowWrites ? 1 : 0,
          reg.allowDestructive ? 1 : 0,
          reg.revealUserIdentities ? 1 : 0,
          reg.label ?? null,
          reg.createdAt,
          null
        );
    })();
    return created;
  }

  async update(
    userid: number,
    baseUrl: string,
    tokenHash: string,
    patch: UpdatePatch
  ): Promise<Registration | undefined> {
    return this.mutateOwned(userid, baseUrl, tokenHash, (reg) =>
      applyPatch(reg, patch)
    );
  }

  async addKey(
    userid: number,
    baseUrl: string,
    input: AddTeamInput
  ): Promise<Registration | undefined> {
    return this.mutateOwned(userid, baseUrl, input.tokenHash, (reg) => {
      if (reg.keys.some((k) => k.team === input.team)) return false;
      reg.keys.push({ apiKey: input.apiKey, team: input.team, label: input.label });
      return true;
    });
  }

  async removeKey(
    userid: number,
    baseUrl: string,
    tokenHash: string,
    team: number
  ): Promise<Registration | undefined> {
    return this.mutateOwned(userid, baseUrl, tokenHash, (reg) =>
      applyRemoveKey(reg, team)
    );
  }

  async revokeForUser(
    userid: number,
    baseUrl: string,
    tokenHash: string
  ): Promise<boolean> {
    const result = this.db
      .prepare(
        'DELETE FROM registrations WHERE token_hash = ? AND userid = ? AND base_url = ?'
      )
      .run(tokenHash, userid, normaliseBaseUrl(baseUrl));
    return result.changes > 0;
  }

  /**
   * Best-effort `lastUsedAt` update. Single-row UPDATE rather than
   * full-file rewrite — the whole reason this backend exists.
   */
  async touch(tokenHash: string): Promise<void> {
    try {
      this.db
        .prepare('UPDATE registrations SET last_used_at = ? WHERE token_hash = ?')
        .run(new Date().toISOString(), tokenHash);
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

  /**
   * Read-modify-write one owned row inside a transaction. `apply`
   * mutates a decrypted copy and reports whether anything changed; the
   * row is rewritten only then.
   */
  private mutateOwned(
    userid: number,
    baseUrl: string,
    tokenHash: string,
    apply: (reg: Registration) => boolean
  ): Registration | undefined {
    return this.db.transaction(() => {
      const reg = this.get(tokenHash);
      if (!reg || reg.userid !== userid || reg.baseUrl !== normaliseBaseUrl(baseUrl)) {
        return undefined;
      }
      if (!apply(reg)) return reg;
      this.db
        .prepare(
          `UPDATE registrations
           SET keys_json = ?, default_team = ?, allow_writes = ?,
               allow_destructive = ?, reveal_user_identities = ?, label = ?
           WHERE token_hash = ?`
        )
        .run(
          this.encryptKeys(reg.keys),
          reg.defaultTeam,
          reg.allowWrites ? 1 : 0,
          reg.allowDestructive ? 1 : 0,
          reg.revealUserIdentities ? 1 : 0,
          reg.label ?? null,
          tokenHash
        );
      return reg;
    })();
  }

  private encryptKeys(keys: RegistrationKey[]): string {
    return JSON.stringify(
      keys.map((k) => ({ ...k, apiKey: this.secrets.encrypt(k.apiKey) }))
    );
  }

  private rowToRegistration(row: RegistrationRow): Registration {
    const keys = parseKeys(row.keys_json).map((k) => ({
      ...k,
      apiKey: isEncrypted(k.apiKey) ? this.secrets.decrypt(k.apiKey) : k.apiKey,
    }));
    return {
      tokenHash: row.token_hash,
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
}

function parseKeys(json: string): RegistrationKey[] {
  try {
    const parsed = JSON.parse(json) as RegistrationKey[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
