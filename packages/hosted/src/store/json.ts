/**
 * JSON-file backend for the registration store.
 *
 * One file, in-memory map for reads. Every mutation builds the next
 * state off to the side, persists it (write tmp → fsync → rename), and
 * only then swaps it into memory — a failed write never leaves memory
 * ahead of disk. Fine to ~hundreds of tokens; every mutation rewrites
 * the whole file, so heavier deployments should pick the SQLite backend.
 *
 * Single-instance only: the file is read once at startup and the
 * in-memory map is authoritative afterwards. Two processes pointed at
 * the same file will silently overwrite each other's writes.
 *
 * Schema is versioned:
 *   - v1 (pre-userid) / v2 (single-key, no per-token flags) are dropped
 *     on load with a startup warning, as before.
 *   - v3 (plaintext `token` + plaintext `apiKey`) is migrated in place
 *     to v4: token → `tokenHash`, API keys → AES-256-GCM envelopes.
 *     Existing bearer tokens keep working.
 *   - v4 is the current shape. Any plaintext key that sneaks in (hand
 *     edits) is encrypted on the next load.
 */

import { existsSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { hashToken, isEncrypted, type SecretBox } from './crypto';
import {
  type AddTeamInput,
  type CreateInput,
  type CreateResult,
  type Registration,
  type RegistrationStore,
  TokenLimitError,
  type UpdatePatch,
  applyPatch,
  applyRemoveKey,
  buildRegistration,
  cloneRegistration,
  normaliseBaseUrl,
} from './index';

const SCHEMA_VERSION = 4;

/** Don't rewrite the whole file for `lastUsedAt` more than once a minute per token. */
const TOUCH_THROTTLE_MS = 60_000;

/** On-disk shape: identical to `Registration`, but `apiKey` is an envelope. */
interface PersistedShapeV4 {
  version: 4;
  registrations: Registration[];
}

interface PersistedShapeAny {
  version: number;
  registrations?: unknown;
}

/** Outcome of a mutation callback: the value to return, and whether to persist. */
interface MutationResult<T> {
  value: T;
  changed: boolean;
}

export class JsonRegistrationStore implements RegistrationStore {
  private readonly path: string;
  private readonly secrets: SecretBox;
  private registrations: Map<string, Registration>;
  private writeChain: Promise<void>;

  private constructor(
    path: string,
    secrets: SecretBox,
    initial: Registration[]
  ) {
    this.path = path;
    this.secrets = secrets;
    this.registrations = new Map(initial.map((r) => [r.tokenHash, r]));
    this.writeChain = Promise.resolve();
  }

  static async open(
    path: string,
    secrets: SecretBox
  ): Promise<JsonRegistrationStore> {
    const absPath = resolve(path);
    // A crashed write can leave a stale tmp file behind; it's never read.
    await rm(`${absPath}.tmp`, { force: true }).catch(() => {});

    if (!existsSync(absPath)) {
      await mkdir(dirname(absPath), { recursive: true, mode: 0o700 });
      const store = new JsonRegistrationStore(absPath, secrets, []);
      await store.persist(store.registrations);
      return store;
    }
    await chmod(absPath, 0o600).catch(() => {});

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
      const store = new JsonRegistrationStore(absPath, secrets, []);
      await store.persist(store.registrations);
      return store;
    }

    if (
      (parsed.version !== 3 && parsed.version !== SCHEMA_VERSION) ||
      !Array.isArray(parsed.registrations)
    ) {
      throw new Error(
        `${absPath} has unexpected shape — expected {"version":${SCHEMA_VERSION},"registrations":[...]}.`
      );
    }

    let migrated = 0;
    const loaded: Registration[] = [];
    for (const entry of parsed.registrations) {
      const { reg, dirty } = JsonRegistrationStore.loadEntry(entry, secrets, absPath);
      if (dirty) migrated++;
      loaded.push(reg);
    }

    const store = new JsonRegistrationStore(absPath, secrets, loaded);
    if (migrated > 0 || parsed.version !== SCHEMA_VERSION) {
      // Rewrite immediately so plaintext tokens / keys don't linger on
      // disk any longer than this startup.
      await store.persist(store.registrations);
      // biome-ignore lint/suspicious/noConsole: startup migration notice
      console.error(
        `[elabftw-mcp] Migrated ${migrated} registration(s) in ${absPath} to ` +
          `schema v${SCHEMA_VERSION} (hashed tokens, encrypted API keys). ` +
          'Existing tokens keep working. Older backups of this file still ' +
          'contain plaintext secrets — rotate or destroy them.'
      );
    }
    return store;
  }

  /**
   * Turn one persisted row (v3 or v4) into an in-memory registration
   * with decrypted keys. `dirty` means the on-disk form needs rewriting.
   */
  private static loadEntry(
    entry: unknown,
    secrets: SecretBox,
    absPath: string
  ): { reg: Registration; dirty: boolean } {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`${absPath}: registration entry is not an object.`);
    }
    const row = { ...(entry as Record<string, unknown>) };
    let dirty = false;

    if (typeof row.token === 'string' && typeof row.tokenHash !== 'string') {
      row.tokenHash = hashToken(row.token);
      dirty = true;
    }
    delete row.token;
    if (typeof row.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(row.tokenHash)) {
      throw new Error(`${absPath}: registration entry has no valid tokenHash.`);
    }
    if (!Array.isArray(row.keys)) {
      throw new Error(`${absPath}: registration ${row.tokenHash.slice(0, 12)} has no keys[].`);
    }
    if (typeof row.baseUrl === 'string') {
      const canonical = normaliseBaseUrl(row.baseUrl);
      if (canonical !== row.baseUrl) {
        row.baseUrl = canonical;
        dirty = true;
      }
    }
    row.keys = (row.keys as Array<Record<string, unknown>>).map((k) => {
      const apiKey = String(k.apiKey ?? '');
      if (!isEncrypted(apiKey)) dirty = true;
      return {
        ...k,
        apiKey: isEncrypted(apiKey) ? secrets.decrypt(apiKey) : apiKey,
      };
    });
    return { reg: row as unknown as Registration, dirty };
  }

  get(tokenHash: string): Registration | undefined {
    const reg = this.registrations.get(tokenHash);
    return reg ? cloneRegistration(reg) : undefined;
  }

  list(): Registration[] {
    return [...this.registrations.values()].map(cloneRegistration);
  }

  listForUser(userid: number, baseUrl: string): Registration[] {
    const normalised = normaliseBaseUrl(baseUrl);
    return [...this.registrations.values()]
      .filter((r) => r.userid === userid && r.baseUrl === normalised)
      .map(cloneRegistration);
  }

  create(input: CreateInput): Promise<CreateResult> {
    return this.mutate((next) => {
      const created = buildRegistration(input);
      const { registration } = created;
      if (input.maxTokensPerUser !== undefined) {
        let owned = 0;
        for (const r of next.values()) {
          if (r.userid === registration.userid && r.baseUrl === registration.baseUrl) {
            owned++;
          }
        }
        if (owned >= input.maxTokensPerUser) {
          throw new TokenLimitError(input.maxTokensPerUser);
        }
      }
      next.set(registration.tokenHash, registration);
      return {
        value: { token: created.token, registration: cloneRegistration(registration) },
        changed: true,
      };
    });
  }

  update(
    userid: number,
    baseUrl: string,
    tokenHash: string,
    patch: UpdatePatch
  ): Promise<Registration | undefined> {
    return this.mutateOwned(userid, baseUrl, tokenHash, (reg) =>
      applyPatch(reg, patch)
    );
  }

  addKey(
    userid: number,
    baseUrl: string,
    input: AddTeamInput
  ): Promise<Registration | undefined> {
    return this.mutateOwned(userid, baseUrl, input.tokenHash, (reg) => {
      // Caller should have caught a duplicate team; if it slips through
      // we keep the registration unchanged rather than add a second row.
      if (reg.keys.some((k) => k.team === input.team)) return false;
      reg.keys.push({ apiKey: input.apiKey, team: input.team, label: input.label });
      return true;
    });
  }

  removeKey(
    userid: number,
    baseUrl: string,
    tokenHash: string,
    team: number
  ): Promise<Registration | undefined> {
    return this.mutateOwned(userid, baseUrl, tokenHash, (reg) =>
      applyRemoveKey(reg, team)
    );
  }

  revokeForUser(
    userid: number,
    baseUrl: string,
    tokenHash: string
  ): Promise<boolean> {
    return this.mutate((next) => {
      const reg = next.get(tokenHash);
      if (!reg || !isOwnedBy(reg, userid, baseUrl)) {
        // Don't reveal that the token exists under a different identity.
        return { value: false, changed: false };
      }
      next.delete(tokenHash);
      return { value: true, changed: true };
    });
  }

  /**
   * Mark a registration as used. Throttled per token, and persistence
   * failures are logged but not fatal — losing the timestamp is
   * harmless.
   */
  async touch(tokenHash: string): Promise<void> {
    const current = this.registrations.get(tokenHash);
    if (!current) return;
    const last = current.lastUsedAt ? Date.parse(current.lastUsedAt) : 0;
    if (Date.now() - last < TOUCH_THROTTLE_MS) return;
    try {
      await this.mutate((next) => {
        const reg = next.get(tokenHash);
        if (!reg) return { value: undefined, changed: false };
        reg.lastUsedAt = new Date().toISOString();
        return { value: undefined, changed: true };
      });
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

  /** `mutate` scoped to one registration the caller must own. */
  private mutateOwned(
    userid: number,
    baseUrl: string,
    tokenHash: string,
    apply: (reg: Registration) => boolean
  ): Promise<Registration | undefined> {
    return this.mutate((next) => {
      const reg = next.get(tokenHash);
      if (!reg || !isOwnedBy(reg, userid, baseUrl)) {
        return { value: undefined, changed: false };
      }
      const changed = apply(reg);
      return { value: cloneRegistration(reg), changed };
    });
  }

  /**
   * Serialised read-modify-write. `apply` gets a deep copy of the
   * current state; if it reports a change, the copy is persisted and
   * then becomes the live state. Writes are queued via a promise chain
   * so two mutations never interleave.
   */
  private mutate<T>(
    apply: (next: Map<string, Registration>) => MutationResult<T>
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const next = new Map(
        [...this.registrations].map(([k, v]) => [k, cloneRegistration(v)])
      );
      const { value, changed } = apply(next);
      if (!changed) return value;
      await this.persist(next);
      this.registrations = next;
      return value;
    };
    const result = this.writeChain.then(run);
    // Swallow errors on the chain so one failure doesn't poison every
    // subsequent write; the original promise still rejects to its caller.
    this.writeChain = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  /**
   * Encrypt + serialise `state` and atomically replace the live file:
   * write tmp (0600) → fsync → rename → fsync the directory.
   */
  private async persist(state: Map<string, Registration>): Promise<void> {
    const payload: PersistedShapeV4 = {
      version: SCHEMA_VERSION,
      registrations: [...state.values()].map((r) => ({
        ...r,
        keys: r.keys.map((k) => ({ ...k, apiKey: this.secrets.encrypt(k.apiKey) })),
      })),
    };
    const tmp = `${this.path}.tmp`;
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify(payload, null, 2));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, this.path);
    // Directory fsync makes the rename itself durable. Not supported on
    // every platform / filesystem — best-effort.
    try {
      const dir = await open(dirname(this.path), 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      // ignore
    }
  }
}

function isOwnedBy(reg: Registration, userid: number, baseUrl: string): boolean {
  return reg.userid === userid && reg.baseUrl === normaliseBaseUrl(baseUrl);
}
