/**
 * JSON-file backend for the registration store.
 *
 * One file, atomic write (tmp + rename), in-memory map for reads. Fine
 * to ~hundreds of tokens; every mutation rewrites the whole file, so
 * heavier deployments should pick the SQLite backend.
 *
 * Schema is versioned. v1 (pre-userid) and v2 (single-key, no per-token
 * flags) entries are dropped on load with a startup warning — there are
 * no production deployments to migrate, and silently re-using older
 * rows would leave the new fields empty. Operators who hit this can
 * re-register in a few seconds.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  type AddTeamInput,
  type CreateInput,
  type Registration,
  type RegistrationStore,
  mintToken,
  normaliseBaseUrl,
} from './index';

const SCHEMA_VERSION = 3;

interface PersistedShapeV3 {
  version: 3;
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
      const empty: PersistedShapeV3 = {
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

    if (parsed.version === 1 || parsed.version === 2) {
      // biome-ignore lint/suspicious/noConsole: startup migration notice
      console.error(
        `[elabftw-mcp] ${absPath} is schema v${parsed.version} (pre-multi-team / pre-flags). ` +
          `All entries dropped — re-register tokens via /register. ` +
          `Writing a fresh v${SCHEMA_VERSION} file.`
      );
      const empty: PersistedShapeV3 = {
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
    this.registrations.set(reg.token, reg);
    await this.flush();
    return reg;
  }

  async addKey(
    userid: number,
    baseUrl: string,
    input: AddTeamInput
  ): Promise<Registration | undefined> {
    const reg = this.registrations.get(input.token);
    if (!reg) return undefined;
    if (reg.userid !== userid || reg.baseUrl !== normaliseBaseUrl(baseUrl)) {
      return undefined;
    }
    if (reg.keys.some((k) => k.team === input.team)) {
      // Caller should have caught this; if it slips through we keep
      // the registration unchanged rather than create a duplicate row.
      return reg;
    }
    reg.keys.push({
      apiKey: input.apiKey,
      team: input.team,
      label: input.label,
    });
    await this.flush();
    return reg;
  }

  async removeKey(
    userid: number,
    baseUrl: string,
    token: string,
    team: number
  ): Promise<Registration | undefined> {
    const reg = this.registrations.get(token);
    if (!reg) return undefined;
    if (reg.userid !== userid || reg.baseUrl !== normaliseBaseUrl(baseUrl)) {
      return undefined;
    }
    if (reg.keys.length <= 1) {
      // Last team: caller should have used revoke. No-op for safety.
      return reg;
    }
    const next = reg.keys.filter((k) => k.team !== team);
    if (next.length === reg.keys.length) {
      // Team not found on this token — no-op.
      return reg;
    }
    reg.keys = next;
    if (reg.defaultTeam === team) {
      // Smallest remaining team becomes the new default.
      reg.defaultTeam = next.reduce(
        (lo, k) => (k.team < lo ? k.team : lo),
        next[0]!.team
      );
    }
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
    const payload: PersistedShapeV3 = {
      version: SCHEMA_VERSION,
      registrations: this.list(),
    };
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
