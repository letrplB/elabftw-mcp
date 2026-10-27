/**
 * Registration store — public interface.
 *
 * A "registration" pairs a 256-bit bearer token with one or more
 * eLabFTW API keys, a base URL, and the user identity that owns the
 * token. Two persistence backends share the same shape:
 *
 *   - JSON file with atomic write (default; fine to ~hundreds of tokens,
 *     single process only).
 *   - SQLite via `better-sqlite3` (institutional scale, indexed lookups).
 *
 * Backend selection is via `MCP_STORE_BACKEND=json|sqlite` (default
 * `json`). Both backends are fed the same `MCP_REGISTRATIONS_PATH`; for
 * SQLite, the file is the database.
 *
 * Secrets at rest (both backends): the bearer token is stored only as
 * `sha256(token)`; API keys are AES-256-GCM encrypted (see `crypto.ts`).
 * In-memory `Registration` objects carry the *decrypted* API keys —
 * the runtime needs them to talk to eLabFTW — but never the token.
 */

import { randomBytes } from 'node:crypto';
import { type SecretBox, hashToken } from './crypto';
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
  /**
   * `sha256(bearer token)`, 64 hex chars. The token itself is never
   * persisted; it's shown to the user exactly once at mint time.
   */
  tokenHash: string;
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
  /**
   * Refuse (with `TokenLimitError`) when the user already holds this
   * many tokens on `baseUrl`. Checked inside the backend's write
   * serialisation so concurrent mints can't overshoot.
   */
  maxTokensPerUser?: number;
}

export interface CreateResult {
  registration: Registration;
  /** Plaintext bearer token. Only ever available here, at mint time. */
  token: string;
}

export interface AddTeamInput {
  tokenHash: string;
  apiKey: string;
  team: number;
  label?: string;
}

/**
 * Partial update applied atomically by `update()`. Absent fields are
 * left alone; `label: { value: undefined }` clears the label.
 */
export interface UpdatePatch {
  label?: { value: string | undefined };
  flags?: {
    allowWrites: boolean;
    allowDestructive: boolean;
    revealUserIdentities: boolean;
  };
  /** Ignored unless it matches one of `keys[].team`. */
  defaultTeam?: number;
}

export class TokenLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Token limit reached (${limit} per user).`);
    this.name = 'TokenLimitError';
  }
}

/**
 * Backend-agnostic store contract. Mutating methods persist before
 * resolving so a process restart never loses an acknowledged write.
 * Every returned `Registration` is a copy — mutating it never touches
 * the store.
 *
 * Methods that take `(userid, baseUrl)` filter by both — userids are
 * only unique within a single eLabFTW instance, and a single hosted
 * server might front more than one. Those methods return `undefined` /
 * `false` when the token doesn't exist *or* belongs to someone else,
 * so callers can't probe for other users' tokens.
 */
export interface RegistrationStore {
  get(tokenHash: string): Registration | undefined;
  list(): Registration[];
  listForUser(userid: number, baseUrl: string): Registration[];
  create(input: CreateInput): Promise<CreateResult>;
  revokeForUser(
    userid: number,
    baseUrl: string,
    tokenHash: string
  ): Promise<boolean>;
  /**
   * Apply label / flag / default-team changes in one write.
   * `allowDestructive` is downgraded when `allowWrites` is false.
   * Returns the updated registration, or `undefined` if not owned.
   */
  update(
    userid: number,
    baseUrl: string,
    tokenHash: string,
    patch: UpdatePatch
  ): Promise<Registration | undefined>;
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
   * (use `revokeForUser` instead). If the removed team was
   * `defaultTeam`, the smallest remaining team becomes the new default.
   * Returns the updated registration, or `undefined` on no-op.
   */
  removeKey(
    userid: number,
    baseUrl: string,
    tokenHash: string,
    team: number
  ): Promise<Registration | undefined>;
  touch(tokenHash: string): Promise<void>;
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
 * Mint a token and build the registration row for it. Shared by both
 * backends so the defaults (least-privilege flags, destructive requires
 * writes) live in one place.
 */
export function buildRegistration(input: CreateInput): CreateResult {
  const token = mintToken();
  const allowWrites = input.allowWrites ?? false;
  return {
    token,
    registration: {
      tokenHash: hashToken(token),
      baseUrl: normaliseBaseUrl(input.baseUrl),
      userid: input.userid,
      keys: [{ apiKey: input.apiKey, team: input.team, label: input.keyLabel }],
      defaultTeam: input.team,
      allowWrites,
      allowDestructive: (input.allowDestructive ?? false) && allowWrites,
      revealUserIdentities: input.revealUserIdentities ?? false,
      label: input.label,
      createdAt: new Date().toISOString(),
    },
  };
}

/**
 * Apply an `UpdatePatch` to a registration in place. Returns whether
 * anything actually changed (so backends can skip a no-op write).
 */
export function applyPatch(reg: Registration, patch: UpdatePatch): boolean {
  let changed = false;
  if (patch.label && patch.label.value !== reg.label) {
    reg.label = patch.label.value;
    changed = true;
  }
  if (patch.flags) {
    const allowWrites = patch.flags.allowWrites;
    const allowDestructive = patch.flags.allowDestructive && allowWrites;
    if (
      allowWrites !== reg.allowWrites ||
      allowDestructive !== reg.allowDestructive ||
      patch.flags.revealUserIdentities !== reg.revealUserIdentities
    ) {
      reg.allowWrites = allowWrites;
      reg.allowDestructive = allowDestructive;
      reg.revealUserIdentities = patch.flags.revealUserIdentities;
      changed = true;
    }
  }
  if (
    patch.defaultTeam !== undefined &&
    patch.defaultTeam !== reg.defaultTeam &&
    reg.keys.some((k) => k.team === patch.defaultTeam)
  ) {
    reg.defaultTeam = patch.defaultTeam;
    changed = true;
  }
  return changed;
}

/**
 * Drop `team` from `reg.keys` in place, re-pointing `defaultTeam` at the
 * smallest remaining team when needed. No-op (returns false) for the
 * last team or a team that isn't on the token.
 */
export function applyRemoveKey(reg: Registration, team: number): boolean {
  if (reg.keys.length <= 1) return false;
  const next = reg.keys.filter((k) => k.team !== team);
  if (next.length === reg.keys.length) return false;
  reg.keys = next;
  if (reg.defaultTeam === team) {
    reg.defaultTeam = next.reduce(
      (lo, k) => (k.team < lo ? k.team : lo),
      next[0]!.team
    );
  }
  return true;
}

/**
 * Non-secret identifier for a token, safe to render in HTML and post
 * back in forms: the first 12 hex chars of its hash. Only ever
 * resolved within one user's token list, so collisions don't matter.
 */
export function tokenIdOf(tokenHash: string): string {
  return tokenHash.slice(0, 12);
}

/**
 * Canonical form of an eLabFTW base URL: `origin + path`, trailing
 * slashes stripped. `new URL()` lowercases scheme + host and drops a
 * default port, so `HTTPS://Elab.Example.com:443/` and
 * `https://elab.example.com` compare equal. Throws on anything that
 * isn't a plain http(s) URL — query strings, fragments, and userinfo
 * are rejected outright rather than silently dropped.
 */
export function canonicaliseBaseUrl(raw: string): string {
  const u = new URL(raw.trim());
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`Base URL must be http(s), got ${u.protocol}`);
  }
  if (u.username || u.password) {
    throw new Error('Base URL must not contain credentials.');
  }
  if (u.search || u.hash) {
    throw new Error('Base URL must not contain a query string or fragment.');
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * Lenient variant used for comparisons on stored rows: canonicalise
 * when possible, otherwise just strip trailing slashes. Keeps
 * `(userid, baseUrl)` joins symmetric across requests and legacy rows.
 */
export function normaliseBaseUrl(raw: string): string {
  try {
    return canonicaliseBaseUrl(raw);
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

/** Deep copy for handing registrations across the store boundary. */
export function cloneRegistration(reg: Registration): Registration {
  return structuredClone(reg);
}

export type StoreBackend = 'json' | 'sqlite';

export interface OpenStoreOptions {
  /** Where the data lives. JSON file or SQLite db file. */
  path: string;
  /** Default `json`. Override with `MCP_STORE_BACKEND` in callers. */
  backend?: StoreBackend;
  /** Encrypts / decrypts API keys at rest. See `loadStoreKey`. */
  secrets: SecretBox;
}

export async function openRegistrationStore(
  options: OpenStoreOptions
): Promise<RegistrationStore> {
  const backend = options.backend ?? 'json';
  switch (backend) {
    case 'json':
      return JsonRegistrationStore.open(options.path, options.secrets);
    case 'sqlite': {
      // Dynamic import keeps the SQLite module out of the JSON path at
      // the source level. Note tsup (splitting: false) inlines it, so
      // `better-sqlite3`'s JS is loaded at startup either way; its
      // native addon is only loaded when a Database is constructed.
      const { SqliteRegistrationStore } = await import('./sqlite');
      return SqliteRegistrationStore.open(options.path, options.secrets);
    }
    default: {
      // Exhaustiveness check.
      const _never: never = backend;
      throw new Error(`Unknown MCP_STORE_BACKEND: ${String(_never)}`);
    }
  }
}
