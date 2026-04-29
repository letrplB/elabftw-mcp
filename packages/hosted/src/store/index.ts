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

export interface RegistrationKey {
  /** Raw eLabFTW API key — sent verbatim as the Authorization header. */
  apiKey: string;
  /** Team id `/users/me` returned for this key at probe time. */
  team: number;
  /** Optional human-readable label, shown by `elab_configured_teams`. */
  label?: string;
}

export interface Registration {
  /** Bearer secret. 64 hex chars (256 bits). */
  token: string;
  /** Instance root URL, no trailing slash, no `/api/v2` suffix. */
  baseUrl: string;
  /**
   * eLabFTW user id (from `/users/me` at registration time). Joins
   * tokens to the *user* rather than any one API key. Rotating an
   * eLabFTW key never orphans the token; adding a team just appends
   * another row to `keys` under the same `userid`.
   */
  userid: number;
  /**
   * One entry per team this token covers. Single-team registrations
   * have `keys.length === 1`; multi-team unlocks the `team` parameter
   * routing on every tool plus the `elab_search_all_teams` fanout
   * tool, exactly like stdio multi-key mode.
   *
   * Invariant: every key in this array resolves to the same `userid`
   * via `/users/me`, and no two share a `team`.
   */
  keys: RegistrationKey[];
  /**
   * Default team id used when a tool call omits the `team` parameter.
   * Always matches one of `keys[].team`. On registration we set it to
   * the first (and only) key's team; multi-team users can override on
   * a future "set default" action.
   */
  defaultTeam: number;
  /**
   * Per-token permission gates. Effective values at request time are
   * AND-ed with the operator's env-var settings — env caps, the
   * registration opts in. `allowDestructive` requires `allowWrites`
   * at both layers.
   */
  allowWrites: boolean;
  allowDestructive: boolean;
  revealUserIdentities: boolean;
  /** Human-readable token label, distinct from per-key labels. */
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface CreateInput {
  apiKey: string;
  baseUrl: string;
  userid: number;
  team: number;
  /** Per-team label that ends up on `keys[0]`. */
  keyLabel?: string;
  /** Token label (separate from per-team label). */
  label?: string;
  allowWrites?: boolean;
  allowDestructive?: boolean;
  revealUserIdentities?: boolean;
}

export interface AddTeamInput {
  token: string;
  apiKey: string;
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
  /**
   * Append a `(apiKey, team, label?)` tuple to a token's `keys[]`.
   * Caller must have already validated that the new key resolves to
   * the same `userid` via `/users/me` and that the team isn't already
   * present. Returns the updated registration, or `undefined` if the
   * token / userid pair didn't match.
   */
  addKey(
    userid: number,
    baseUrl: string,
    input: AddTeamInput
  ): Promise<Registration | undefined>;
  /**
   * Drop a team from a token's `keys[]`. Last team can't be removed
   * (use `revoke` instead). If the removed team was `defaultTeam`,
   * the smallest remaining team becomes the new default. Returns the
   * updated registration, or `undefined` on no-op.
   */
  removeKey(
    userid: number,
    baseUrl: string,
    token: string,
    team: number
  ): Promise<Registration | undefined>;
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
