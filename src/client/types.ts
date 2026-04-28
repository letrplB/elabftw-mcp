/**
 * App-agnostic types for the elabftw v2 REST API.
 *
 * Everything here is derived from the official OpenAPI spec at
 * https://raw.githubusercontent.com/elabftw/elabftw/master/apidoc/v2/openapi.yaml
 *
 * These are intentionally permissive: elabftw returns lots of optional or
 * nullable fields depending on version and instance configuration. We keep
 * every known field typed but optional, and use `unknown` for fully open
 * JSON blobs (`metadata`) so callers don't have to fight the types when an
 * instance adds a new field.
 */

/**
 * The four entity "kinds" that share most of the same sub-resource tree
 * (uploads, comments, steps, links, tags, revisions, containers).
 */
export type ElabEntityType =
  | 'experiments'
  | 'items'
  | 'experiments_templates'
  | 'items_types';

/**
 * Entity state. Soft-delete sets state=3; archiving sets state=2.
 */
export enum ElabState {
  Normal = 1,
  Archived = 2,
  Deleted = 3,
}

/**
 * Scope values accepted by list endpoints: 1=self, 2=team, 3=everything
 * the caller can see.
 */
export enum ElabScope {
  Self = 1,
  Team = 2,
  Everything = 3,
}

/**
 * Order-by keys supported by list endpoints. Not all are valid for every
 * entity type, but elabftw ignores unknown ones.
 */
export type ElabOrderKey =
  | 'cat'
  | 'comment'
  | 'customid'
  | 'date'
  | 'id'
  | 'lastchange'
  | 'rating'
  | 'status'
  | 'title'
  | 'user';

export type ElabSortDirection = 'asc' | 'desc';

/**
 * Configuration required to talk to an elabftw instance.
 */
export interface ElabftwConfig {
  /**
   * Root URL of the instance, e.g. `https://elab.example.com`.
   * Do NOT include `/api/v2`; the client appends that itself.
   */
  baseUrl: string;
  /**
   * API key, e.g. `3-cb2314b00d2845a...`. Sent as the literal value of the
   * `Authorization` header — no `Bearer ` prefix. A read-only key will
   * fail on mutating calls with 403.
   */
  apiKey: string;
  /**
   * Optional User-Agent. Useful for instance admins grepping logs.
   * Defaults to `sura-elabftw/1.0`.
   */
  userAgent?: string;
  /**
   * Per-request timeout in ms. Default 30_000.
   */
  timeoutMs?: number;
  /**
   * Custom fetch implementation. Defaults to global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Query parameters accepted by list endpoints on entity types.
 * See the OpenAPI spec under `/experiments` (all entity list endpoints
 * share the same parameters).
 */
export interface ElabListQuery {
  /** Full-text search against title, body, elabid. */
  q?: string;
  /**
   * Advanced query DSL: `rating:5 and tag:"blue" and date:>2024-01-01`.
   * Takes precedence over `q` when both are sent; stick to one.
   */
  extended?: string;
  /** Find entries linking to this entity id. Pair with `related_origin`. */
  related?: number;
  /** Kind of the related entity (experiments | items). */
  related_origin?: 'experiments' | 'items';
  /** Filter by category id (team category / items_type id). */
  cat?: number;
  /** Filter by status id. */
  status?: number;
  /** Filter by tag ids. Multiple tags are AND-ed server-side. */
  tags?: number[];
  /** Page size. Server default is 15; there is no documented hard max. */
  limit?: number;
  /** Offset for pagination (0-based). */
  offset?: number;
  /** Restrict to a specific owner user id. */
  owner?: number;
  /** 1=self, 2=team, 3=everything visible. */
  scope?: ElabScope;
  order?: ElabOrderKey;
  sort?: ElabSortDirection;
  /** 1=Normal (default), 2=Archived, 3=Deleted. */
  state?: ElabState;
}

/**
 * Shape returned by `GET /{entity}` list endpoints and by single-entity
 * GETs. Fields vary by instance version; unknown fields survive as
 * `[key: string]: unknown`.
 */
export interface ElabEntity {
  id: number;
  team?: number;
  userid?: number;
  title?: string;
  /** HTML or markdown body, depending on `content_type`. */
  body?: string | null;
  /** 1 = HTML, 2 = Markdown. */
  content_type?: number;
  /** YYYYMMDD as a string, e.g. "20260417". */
  date?: string | null;
  created_at?: string | null;
  modified_at?: string | null;
  /** elabid / UUID-ish public identifier. */
  elabid?: string | null;
  /** Integer 0-5. */
  rating?: number | null;
  locked?: 0 | 1;
  locked_at?: string | null;
  lockedby?: number | null;
  /** ElabState (1=normal, 2=archived, 3=deleted). */
  state?: ElabState | number;
  canread?: string;
  canwrite?: string;
  canread_target?: string;
  canwrite_target?: string;
  /** Category / items_type id. */
  category?: number | null;
  category_title?: string | null;
  category_color?: string | null;
  status?: number | null;
  status_title?: string | null;
  status_color?: string | null;
  custom_id?: number | null;
  /**
   * Arbitrary JSON blob. elabftw returns this as a *string* containing JSON
   * on the wire in some versions and as a parsed object in others. Callers
   * should treat it as unknown and use `parseMetadata()` if they need the
   * `extra_fields` structure.
   */
  metadata?: string | Record<string, unknown> | null;
  /** Populated only on single-entity GET. */
  tags?: string | null;
  tags_id?: string | null;
  /** Convenience fields when included by `?include=`-style extensions. */
  uploads?: ElabUpload[];
  steps?: ElabStep[];
  comments?: ElabComment[];
  [key: string]: unknown;
}

/**
 * Subset of `ElabEntity` fields accepted by `PATCH /{entity}/{id}` in the
 * default `action:"update"` mode. elabftw silently drops unknown fields.
 */
export interface ElabEntityUpdate {
  title?: string;
  body?: string;
  content_type?: 1 | 2;
  date?: string;
  rating?: number;
  category?: number;
  status?: number;
  custom_id?: number;
  canread?: string;
  canwrite?: string;
  /** Send as a JSON string to be safe across instance versions. */
  metadata?: string;
  /** Plain-state transitions go through `state` (1=normal, 2=archived). */
  state?: ElabState | number;
  [key: string]: unknown;
}

/**
 * Actions that can be POSTed/PATCHed to `/{entity}/{id}`.
 * See the OpenAPI spec `Action` enum.
 */
export type ElabEntityAction =
  | 'update'
  | 'updatemetadatafield'
  | 'lock'
  | 'forcelock'
  | 'forceunlock'
  | 'pin'
  | 'exclusiveeditmode'
  | 'timestamp'
  | 'bloxberg'
  | 'sign'
  | 'duplicate'
  | 'archive';

export interface ElabDuplicateOptions {
  /** Defaults to false. */
  copyFiles?: boolean;
  /** Creates a link back to the original. Defaults to false. */
  linkToOriginal?: boolean;
  /** When duplicating a template into an experiment, set the team. */
  team?: number;
}

export interface ElabCreateEntityInput {
  /** For experiments: template id; for items: items_type id. */
  category_id?: number;
  /** Alias used in some versions; client will fall back. */
  template?: number;
  title?: string;
  body?: string;
  /**
   * 1 = HTML (default), 2 = Markdown. Older elabftw versions may ignore
   * this on POST; the MCP `elab_create_entity` tool re-PATCHes when the
   * value doesn't land on the new entity.
   */
  content_type?: 1 | 2;
  tags?: string[];
  /** Metadata as a JSON string (safest across versions). */
  metadata?: string;
}

export interface ElabUpload {
  id: number;
  real_name?: string;
  long_name?: string;
  comment?: string | null;
  hash?: string | null;
  hash_algorithm?: string | null;
  filesize?: number;
  /**
   * Parent entity type ('experiments' | 'items' | ...). This is NOT the
   * MIME type — elabftw stores no explicit MIME field in the upload
   * metadata; callers should rely on the file extension.
   */
  type?: string | null;
  created_at?: string | null;
  userid?: number;
  state?: ElabState | number;
  storage?: number;
  [key: string]: unknown;
}

export interface ElabComment {
  id: number;
  userid: number;
  fullname?: string;
  created_at?: string;
  modified_at?: string;
  comment: string;
  [key: string]: unknown;
}

export interface ElabStep {
  id: number;
  body: string;
  ordering?: number;
  finished?: 0 | 1;
  finished_time?: string | null;
  deadline?: string | null;
  deadline_notif?: 0 | 1;
  [key: string]: unknown;
}

export interface ElabLink {
  /** Id of the linked (target) entity. */
  entityid: number;
  /** Target category id (useful to find the right entity type). */
  category?: number;
  category_title?: string | null;
  category_color?: string | null;
  title?: string;
  elabid?: string | null;
  [key: string]: unknown;
}

export interface ElabTag {
  id: number;
  tag: string;
  is_favorite?: 0 | 1;
  item_count?: number;
  [key: string]: unknown;
}

export interface ElabUser {
  userid: number;
  firstname?: string;
  lastname?: string;
  fullname?: string;
  email?: string;
  orcid?: string | null;
  team?: number;
  teams?: Array<{ id: number; name: string }>;
  usergroup?: number;
  is_sysadmin?: 0 | 1;
  is_admin?: 0 | 1;
  archived?: 0 | 1;
  [key: string]: unknown;
}

export interface ElabTeam {
  id: number;
  name: string;
  orgid?: string | null;
  visible?: 0 | 1;
  [key: string]: unknown;
}

export interface ElabExperimentsTemplate extends ElabEntity {
  /** Some instances surface a `locked_at_timestamp` specific to templates. */
  locked_at_timestamp?: string | null;
}

export interface ElabItemsType extends ElabEntity {
  /** Items types expose a color used in the UI and for categories. */
  color?: string | null;
}

export interface ElabEvent {
  id: number;
  team: number;
  item: number;
  item_link?: number | null;
  experiment?: number | null;
  start: string;
  end: string;
  title?: string;
  userid: number;
  [key: string]: unknown;
}

export interface ElabRevision {
  id: number;
  /** ISO timestamp of when the revision was created. */
  created_at?: string | null;
  /** User who created the revision. */
  userid?: number;
  fullname?: string | null;
  /** Full body snapshot at the time of the revision. Usually HTML. */
  body?: string | null;
  /** Bytes of the body; elabftw returns this on list so callers can pick a short one. */
  body_size?: number | null;
  /** 1 = HTML, 2 = Markdown (matches ElabEntity.content_type). */
  content_type?: number;
  [key: string]: unknown;
}

export interface ElabExtraFieldDescriptor {
  name: string;
  type: string;
  /** Options for select-type fields. */
  options?: string[];
  [key: string]: unknown;
}

export interface ElabInfo {
  elabftw_version?: string;
  elabftw_version_int?: number;
  php_version?: string;
  ts_balance?: number | null;
  all_experiments_count?: number;
  all_items_count?: number;
  all_users_count?: number;
  all_teams_count?: number;
  uploads_size?: number;
  [key: string]: unknown;
}

/**
 * Structured view of an entity's `metadata` blob, as used by the extra-fields
 * editor in the UI. All fields are optional — instances using no extra
 * fields will return `null` or an empty object.
 */
export interface ElabMetadata {
  extra_fields?: Record<string, ElabExtraFieldValue>;
  elabftw?: {
    display_main_text?: boolean;
    extra_fields_groups?: Array<{ id: number; name: string }>;
  };
  [key: string]: unknown;
}

export interface ElabExtraFieldValue {
  type: string;
  value?: unknown;
  description?: string;
  required?: boolean;
  readonly?: boolean;
  group_id?: number | null;
  position?: number;
  options?: string[];
  unit?: string;
  units?: string[];
  [key: string]: unknown;
}
