/**
 * Registration store for hosted mode.
 *
 * A "registration" pairs a token (256-bit random hex) with an elabftw
 * API key + base URL. Registrations are durable — they survive process
 * restart, unlike MCP protocol sessions, which are ephemeral.
 *
 * Persistence is a single JSON file with atomic write (tmp + rename).
 * This is fine for institutional scale (tens to low hundreds of tokens).
 * Swap to SQLite when scale demands; the public surface is the
 * `RegistrationStore` class only.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface Registration {
  token: string;
  apiKey: string;
  baseUrl: string;
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface PersistedShape {
  version: 1;
  registrations: Registration[];
}

/**
 * Generate a 256-bit token rendered as 64 hex chars. Cryptographically
 * random; used as a bearer secret.
 */
export function mintToken(): string {
  return randomBytes(32).toString('hex');
}

export class RegistrationStore {
  private readonly path: string;
  private readonly registrations: Map<string, Registration>;
  private writeChain: Promise<void>;

  private constructor(path: string, initial: Registration[]) {
    this.path = path;
    this.registrations = new Map(initial.map((r) => [r.token, r]));
    this.writeChain = Promise.resolve();
  }

  static async open(path: string): Promise<RegistrationStore> {
    const absPath = resolve(path);
    if (!existsSync(absPath)) {
      await mkdir(dirname(absPath), { recursive: true });
      const empty: PersistedShape = { version: 1, registrations: [] };
      await writeFile(absPath, JSON.stringify(empty, null, 2), {
        mode: 0o600,
      });
      return new RegistrationStore(absPath, []);
    }

    const raw = await readFile(absPath, 'utf8');
    let parsed: PersistedShape;
    try {
      parsed = JSON.parse(raw) as PersistedShape;
    } catch (err) {
      throw new Error(
        `Failed to parse ${absPath}. Expected JSON of shape ` +
          `{"version":1,"registrations":[...]}. Original error: ${
            err instanceof Error ? err.message : String(err)
          }`
      );
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.registrations)) {
      throw new Error(
        `${absPath} has unexpected shape — expected {"version":1,"registrations":[...]}.`
      );
    }
    return new RegistrationStore(absPath, parsed.registrations);
  }

  get(token: string): Registration | undefined {
    return this.registrations.get(token);
  }

  list(): Registration[] {
    return [...this.registrations.values()];
  }

  async create(input: {
    apiKey: string;
    baseUrl: string;
    label?: string;
  }): Promise<Registration> {
    const reg: Registration = {
      token: mintToken(),
      apiKey: input.apiKey,
      baseUrl: input.baseUrl.replace(/\/+$/, ''),
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
    const payload: PersistedShape = {
      version: 1,
      registrations: this.list(),
    };
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
