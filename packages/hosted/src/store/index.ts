/**
 * Registration store — public interface.
 *
 * A "registration" pairs a 256-bit bearer token with an eLabFTW API key,
 * base URL, and the user identity that owns the token. Two persistence
 * backends share the same shape:
 *
 *   - JSON file with atomic write (default; fine to ~hundreds of tokens).
 *   - SQLite via `node:sqlite` (institutional scale, indexed lookups).
 *
 * Backend selection is via `MCP_STORE_BACKEND=json|sqlite` (default
 * `json`). Both backends are fed the same `MCP_REGISTRATIONS_PATH`; for
 * SQLite, the file is the database.
 */

import { randomBytes } from 'node:crypto';
import { JsonRegistrationStore } from './json';

export interface Registration {
  /** Bearer secret. 64 hex chars (256 bits). */
  token: string;
  /** Raw eLabFTW API key — sent verbatim as the Authorization header. */
  apiKey: string;
  /** Instance root URL, no trailing slash, no `/api/v2` suffix. */
  baseUrl: string;
  /**
   * eLabFTW user id (from `/users/me` at registration time). Joins
   * tokens to the *user* rather than the API key, so rotating the
   * eLabFTW key doesn't orphan tokens — the manage page can still
   * recognise them with any current key for the same user.
   */
  userid: number;
  /**
   * Team id from `/users/me`. Stored to avoid a per-session round-trip
   * and so `defaultTeam` matches what eLabFTW returns under this key.
   * Without this, list filters silently exclude every row.
   */
  team: number;
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface CreateInput {
  apiKey: string;
  baseUrl: string;
  userid: number;
  team: number;
  label?: string;
}

/**
 * Backend-agnostic store contract. Mutating methods persist before
 * resolving so a process restart never loses an acknowledged write.
 *
 * Methods that take `(userid, baseUrl)` filter by both — userids are
 * only unique within a single eLabFTW instance, and a single hosted
 * server might front more than one.
 */
export interface RegistrationStore {
  get(token: string): Registration | undefined;
  list(): Registration[];
  listForUser(userid: number, baseUrl: string): Registration[];
  create(input: CreateInput): Promise<Registration>;
  revoke(token: string): Promise<boolean>;
  revokeForUser(
    userid: number,
    baseUrl: string,
    token: string
  ): Promise<boolean>;
  touch(token: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Generate a 256-bit token rendered as 64 hex chars. Cryptographically
 * random; used as a bearer secret.
 */
export function mintToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Normalise a base URL the way registrations canonically store it:
 * lowercase scheme + host preserved as given, trailing slashes removed.
 * Used to make `(userid, baseUrl)` joins symmetric across requests.
 */
export function normaliseBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

export type StoreBackend = 'json' | 'sqlite';

export interface OpenStoreOptions {
  /** Where the data lives. JSON file or SQLite db file. */
  path: string;
  /** Default `json`. Override with `MCP_STORE_BACKEND` in callers. */
  backend?: StoreBackend;
}

export async function openRegistrationStore(
  options: OpenStoreOptions
): Promise<RegistrationStore> {
  const backend = options.backend ?? 'json';
  switch (backend) {
    case 'json':
      return JsonRegistrationStore.open(options.path);
    case 'sqlite': {
      // Lazy import — the SQLite backend uses `node:sqlite` (Node 22+),
      // and we don't want JSON-only deployments to pay the cost (or
      // crash on older Node) just for picking up the symbol.
      const { SqliteRegistrationStore } = await import('./sqlite');
      return SqliteRegistrationStore.open(options.path);
    }
    default: {
      // Exhaustiveness check.
      const _never: never = backend;
      throw new Error(`Unknown MCP_STORE_BACKEND: ${String(_never)}`);
    }
  }
}
