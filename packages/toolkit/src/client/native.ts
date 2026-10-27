/**
 * "Native view" of an elabftw entity — the wire shape with stringified
 * payloads pre-parsed. See {@link ElabEntityNative} in `./types.ts` for the
 * curated field set; this module owns the bidirectional conversion to
 * and from the raw wire shape.
 *
 * Used by `elab_get(view: 'native')` for read and by
 * `elab_update_entity({native})` for write. The roundtrip is intentional:
 * an agent can `elab_get` an entity in native view, edit any field
 * (permissions, tags, extra fields, …) in JSON, and pass the same shape
 * back to write — the toolkit handles re-stringification.
 */

import type {
  ElabEntity,
  ElabEntityNative,
  ElabEntityUpdate,
  ElabLink,
  ElabMetadata,
  ElabPermissions,
} from './types';

const EMPTY_PERMS: ElabPermissions = {
  teams: [],
  users: [],
  teamgroups: [],
};

/**
 * Parse a `canread` / `canwrite` JSON string into an {@link ElabPermissions}.
 * Returns an empty perms object when the input is missing or malformed —
 * an empty `teams[]` plus `<field>_base` on the wire is elabftw's "default
 * permissions from base level" state, so an empty object is the right
 * neutral.
 */
function parsePermissions(raw: unknown): ElabPermissions {
  if (typeof raw !== 'string' || raw.length === 0) return { ...EMPTY_PERMS };
  try {
    const parsed = JSON.parse(raw) as Partial<ElabPermissions>;
    return {
      teams: Array.isArray(parsed.teams) ? parsed.teams.map(Number) : [],
      users: Array.isArray(parsed.users) ? parsed.users.map(Number) : [],
      teamgroups: Array.isArray(parsed.teamgroups)
        ? parsed.teamgroups.map(Number)
        : [],
    };
  } catch {
    return { ...EMPTY_PERMS };
  }
}

/**
 * elabftw returns `tags` as a `|`-delimited string and `tags_id` as a
 * `,`-delimited string. Yes, different delimiters — that's the wire shape.
 * Both can be `null` when the entity has no tags.
 */
function parseTagList(raw: unknown, delimiter: '|' | ','): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  return raw.split(delimiter).filter((s) => s.length > 0);
}

function parseTagIds(raw: unknown): number[] {
  return parseTagList(raw, ',')
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
}

function parseMetadataString(raw: unknown): ElabMetadata | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw === 'null') return null;
  try {
    return JSON.parse(raw) as ElabMetadata;
  } catch {
    return null;
  }
}

/**
 * Project the wire shape onto the curated native view. Any stringified
 * payload is parsed; missing optional arrays are normalized to `[]` so
 * downstream code can iterate without null checks. Unknown extra keys
 * survive via the index signature — useful for items_type extra fields
 * elabftw might add in future versions.
 */
export function toNativeEntity(entity: ElabEntity): ElabEntityNative {
  const e = entity as ElabEntity & {
    canread_base?: number;
    canread_is_immutable?: 0 | 1;
    canwrite_base?: number;
    canwrite_is_immutable?: 0 | 1;
    elabid?: string | null;
    category_color?: string | null;
    experiments_links?: ElabLink[];
    items_links?: ElabLink[];
    compounds_links?: ElabLink[];
    locked?: 0 | 1;
  };

  const native: ElabEntityNative = {
    id: Number(e.id),
    team: Number(e.team ?? 0),
    userid: Number(e.userid ?? 0),
    elabid: e.elabid ?? null,

    title: e.title ?? '',
    body: e.body ?? '',
    content_type: (e.content_type === 2 ? 2 : 1) as 1 | 2,
    date: e.date,

    category: e.category ?? null,
    category_title: e.category_title ?? null,
    category_color: e.category_color ?? null,
    status: e.status ?? null,
    status_title: e.status_title ?? null,
    rating: e.rating,
    custom_id: e.custom_id ?? null,

    canread: parsePermissions(e.canread),
    canread_base: e.canread_base,
    canread_is_immutable: e.canread_is_immutable,
    canwrite: parsePermissions(e.canwrite),
    canwrite_base: e.canwrite_base,
    canwrite_is_immutable: e.canwrite_is_immutable,

    metadata: parseMetadataString(e.metadata),
    tags: parseTagList(e.tags, '|'),
    tags_id: parseTagIds(e.tags_id),

    experiments_links: e.experiments_links ?? [],
    items_links: e.items_links ?? [],
    compounds_links: e.compounds_links ?? [],

    state: e.state,
    locked: e.locked,
  };
  return native;
}

/**
 * Convert a (partial) native shape back into the PATCH body elabftw
 * expects: permissions and metadata are re-stringified. Tags and state
 * cannot go through a field PATCH (tags have their own endpoint, state
 * changes go through the `archive` / `unarchive` actions), so they come
 * back separately for the caller to apply.
 */
export interface NativePatchResult {
  patch: ElabEntityUpdate;
  /** Desired tag set (undefined = leave tags alone). */
  tags?: string[];
  /** Desired state (undefined = leave state alone). */
  state?: number;
}

export function nativeToUpdate(
  native: Partial<ElabEntityNative>
): NativePatchResult {
  const patch: ElabEntityUpdate = {};
  // `date` / `category` / … may be null to clear them; the index signature
  // carries the null through.
  const loose = patch as Record<string, unknown>;

  if (native.title !== undefined) patch.title = native.title;
  if (native.body !== undefined) patch.body = native.body;
  if (native.content_type !== undefined)
    patch.content_type = native.content_type;
  if (native.date !== undefined) loose.date = native.date;
  if (native.category !== undefined) loose.category = native.category;
  if (native.status !== undefined) loose.status = native.status;
  if (native.rating !== undefined) loose.rating = native.rating;
  if (native.custom_id !== undefined) loose.custom_id = native.custom_id;

  if (native.canread !== undefined)
    patch.canread = JSON.stringify(native.canread);
  if (native.canwrite !== undefined)
    patch.canwrite = JSON.stringify(native.canwrite);
  if (native.canread_base !== undefined)
    patch.canread_base = native.canread_base;
  if (native.canwrite_base !== undefined)
    patch.canwrite_base = native.canwrite_base;
  if (native.canread_is_immutable !== undefined)
    patch.canread_is_immutable = native.canread_is_immutable;
  if (native.canwrite_is_immutable !== undefined)
    patch.canwrite_is_immutable = native.canwrite_is_immutable;

  if (native.metadata !== undefined) {
    // The metadata column is JSON; an empty object clears it.
    patch.metadata = JSON.stringify(native.metadata ?? {});
  }

  return { patch, tags: native.tags, state: native.state };
}
