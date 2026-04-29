/**
 * JSON-file backend for the registration store.
 *
 * One file, atomic write (tmp + rename), in-memory map for reads. Fine
 * to ~hundreds of tokens; every mutation rewrites the whole file, so
 * heavier deployments should pick the SQLite backend.
 *
 * Schema is versioned. v1 (pre-userid) entries are dropped on load
 * with a startup warning — there are no production deployments to
 * migrate, and silently re-using v1 rows would leave the userid join
 * key empty. Operators who hit this can re-register in a few seconds.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  type CreateInput,
  type Registration,
  type RegistrationStore,
  mintToken,
  normaliseBaseUrl,
} from './index';

const SCHEMA_VERSION = 2;

interface PersistedShapeV2 {
  version: 2;
  registrations: Registration[];
}

interface PersistedShapeAny {
  version: number;
  registrations?: unknown;
}

export class JsonRegistrationStore implements RegistrationStore {
  private readonly path: string;
  private readonly registrations: Map<string, Registration>;
  private writeChain: Promise<void>;

  private constructor(path: string, initial: Registration[]) {
    this.path = path;
    this.registrations = new Map(initial.map((r) => [r.token, r]));
    this.writeChain = Promise.resolve();
  }

  static async open(path: string): Promise<JsonRegistrationStore> {
    const absPath = resolve(path);
    if (!existsSync(absPath)) {
      await mkdir(dirname(absPath), { recursive: true });
      const empty: PersistedShapeV2 = {
        version: SCHEMA_VERSION,
        registrations: [],
      };
      await writeFile(absPath, JSON.stringify(empty, null, 2), {
        mode: 0o600,
      });
      return new JsonRegistrationStore(absPath, []);
    }

    const raw = await readFile(absPath, 'utf8');
    let parsed: PersistedShapeAny;
    try {
      parsed = JSON.parse(raw) as PersistedShapeAny;
    } catch (err) {
      throw new Error(
        `Failed to parse ${absPath}. Expected JSON of shape ` +
          `{"version":${SCHEMA_VERSION},"registrations":[...]}. Original error: ${
            err instanceof Error ? err.message : String(err)
          }`
      );
    }

    if (parsed.version === 1) {
      // biome-ignore lint/suspicious/noConsole: startup migration notice
      console.error(
        `[elabftw-mcp] ${absPath} is schema v1 (pre-userid). All entries ` +
          `dropped — re-register tokens via /register. Writing a fresh v${SCHEMA_VERSION} file.`
      );
      const empty: PersistedShapeV2 = {
        version: SCHEMA_VERSION,
        registrations: [],
      };
      await writeFile(absPath, JSON.stringify(empty, null, 2), {
        mode: 0o600,
      });
      return new JsonRegistrationStore(absPath, []);
    }

    if (
      parsed.version !== SCHEMA_VERSION ||
      !Array.isArray(parsed.registrations)
    ) {
      throw new Error(
        `${absPath} has unexpected shape — expected {"version":${SCHEMA_VERSION},"registrations":[...]}.`
      );
    }

    return new JsonRegistrationStore(absPath, parsed.registrations as Registration[]);
  }

  get(token: string): Registration | undefined {
    return this.registrations.get(token);
  }

  list(): Registration[] {
    return [...this.registrations.values()];
  }

  listForUser(userid: number, baseUrl: string): Registration[] {
    const normalised = normaliseBaseUrl(baseUrl);
    return this.list().filter(
      (r) => r.userid === userid && r.baseUrl === normalised
    );
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
    this.registrations.set(reg.token, reg);
    await this.flush();
    return reg;
  }

  async revoke(token: string): Promise<boolean> {
    const existed = this.registrations.delete(token);
    if (existed) await this.flush();
    return existed;
  }

  async revokeForUser(
    userid: number,
    baseUrl: string,
    token: string
  ): Promise<boolean> {
    const reg = this.registrations.get(token);
    if (!reg) return false;
    if (reg.userid !== userid || reg.baseUrl !== normaliseBaseUrl(baseUrl)) {
      // Don't reveal that the token exists under a different identity —
      // treat as a not-found from this user's perspective.
      return false;
    }
    this.registrations.delete(token);
    await this.flush();
    return true;
  }

  /**
   * Mark a registration as used. Touches `lastUsedAt` and best-effort
   * persists. Persistence failures are logged but not fatal — losing the
   * timestamp is harmless.
   */
  async touch(token: string): Promise<void> {
    const reg = this.registrations.get(token);
    if (!reg) return;
    reg.lastUsedAt = new Date().toISOString();
    try {
      await this.flush();
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: non-fatal diagnostic
      console.error(
        `[elabftw-mcp] Failed to persist lastUsedAt for token: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async close(): Promise<void> {
    // Drain any pending writes so the file ends up consistent on shutdown.
    await this.writeChain;
  }

  /**
   * Serialize the in-memory map and atomically rename onto the live
   * file. Concurrent writes are queued via a promise chain so we never
   * interleave two writers.
   */
  private flush(): Promise<void> {
    const next = this.writeChain.then(() => this.flushNow());
    this.writeChain = next.catch(() => {
      // Swallow errors from the chain so one failure doesn't poison
      // every subsequent flush; the original promise still rejects to
      // its caller.
    });
    return next;
  }

  private async flushNow(): Promise<void> {
    const payload: PersistedShapeV2 = {
      version: SCHEMA_VERSION,
      registrations: this.list(),
    };
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
