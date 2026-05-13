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
  /**
   * YYYYMMDD string (e.g. "20260417"). elabftw drops this on POST and
   * defaults to "today"; the MCP `elab_create_entity` tool re-PATCHes
   * when supplied so the value lands.
   */
  date?: string;
  /**
   * Integer 0-5. elabftw drops this on POST; the MCP layer re-PATCHes.
   */
  rating?: number;
  /** Status id (team-scoped). elabftw honors this on POST in v5.x. */
  status?: number;
  /**
   * Stable per-team identifier. elabftw drops this on POST; the MCP
   * layer re-PATCHes.
   */
  custom_id?: number;
  /**
   * JSON string describing read permissions. elabftw normalizes
   * whitespace/key-order on round-trip; the MCP layer compares with
   * deep-equal before deciding to re-PATCH.
   */
  canread?: string;
  /** Same shape and semantics as `canread`. */
  canwrite?: string;
  /**
   * 1 = Normal, 2 = Archived. State `3` (Deleted) is reachable via
   * `elab_delete_entity` only — keep create/update flows unambiguous.
   * elabftw drops this on POST; the MCP layer re-PATCHes.
   */
  state?: ElabState | number;
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

/**
 * Row returned by `GET /teams/current/experiments_categories` — the team's
 * experiment categories. Categories double as template selectors on
 * experiment create and color-code the experiment list.
 *
 * Source of truth: `elabftw/src/Models/AbstractStatus.php:96-123` (the
 * `readAll` query that backs both categories and statuses for the team
 * sub-resource). `color` is stored as a hex string WITHOUT the leading `#`
 * on the wire (e.g. `"29AEB9"`); callers should prepend `#` when rendering.
 */
export interface ElabCategory {
  id: number;
  title: string;
  color?: string;
  ordering?: number;
  is_default?: number | boolean;
  state?: ElabState | number;
  team?: number;
  is_private?: 0 | 1;
  team_name?: string | null;
  is_current_team?: 0 | 1;
  [key: string]: unknown;
}

/**
 * Row returned by `GET /teams/current/experiments_status` and
 * `GET /teams/current/items_status` — workflow tags (e.g. "Running",
 * "Success", "Fail") assignable to entities via the `status` field on
 * `elab_create_entity` / `elab_update_entity`.
 *
 * Shape matches {@link ElabCategory} (same `AbstractStatus` query); kept as
 * a separate interface so tool descriptions can talk about "statuses" vs
 * "categories" without aliasing.
 *
 * Source of truth: `elabftw/src/Models/AbstractStatus.php:96-123`.
 */
export interface ElabStatus {
  id: number;
  title: string;
  color?: string;
  is_default?: number | boolean;
  state?: ElabState | number;
  team?: number;
  is_private?: 0 | 1;
  team_name?: string | null;
  is_current_team?: 0 | 1;
  [key: string]: unknown;
}

/**
 * Hazard / classification booleans on a compound. elabftw stores them as
 * 0/1 integers on the wire and the UI surfaces them as the GHS pictograms
 * plus regulatory flags. The full set is enumerated here so {@link formatCompound}
 * can render a compact hazard summary without dynamic key probing.
 *
 * Source of truth: `elabftw/src/Models/Compounds.php` (the columns on the
 * `compounds` table; GHS subset matches `elabftw/src/ts/HazardsClass.ts`).
 */
export const COMPOUND_HAZARD_FLAGS = [
  // GHS pictograms
  'is_corrosive',
  'is_explosive',
  'is_flammable',
  'is_gas_under_pressure',
  'is_hazardous2env',
  'is_hazardous2health',
  'is_oxidising',
  'is_toxic',
  'is_radioactive',
  'is_serious_health_hazard',
  // Regulatory / classification flags
  'is_antibiotic',
  'is_antibiotic_precursor',
  'is_drug',
  'is_drug_precursor',
  'is_explosive_precursor',
  'is_cmr',
  'is_nano',
  'is_controlled',
  'is_ed2health',
  'is_ed2env',
  'is_pbt',
  'is_pmt',
  'is_vpvb',
  'is_vpvm',
] as const;

export type ElabCompoundHazardFlag = (typeof COMPOUND_HAZARD_FLAGS)[number];

/**
 * Row returned by `/compounds` endpoints. Compounds are a first-class
 * elabftw entity (separate from `items` / `experiments`) holding chemical
 * substances with an extensive set of external-database identifiers
 * (PubChem, ChEMBL, CAS, etc.), structural descriptors (InChI, SMILES),
 * and GHS / regulatory hazard flags.
 *
 * Note: `molecular_weight` is returned as a string with two decimals on
 * the wire (e.g. `"0.00"`), even though it's a numeric value. Callers can
 * `parseFloat` if arithmetic is needed.
 *
 * Source of truth: `elabftw/src/Models/Compounds.php`.
 */
export interface ElabCompound {
  id: number;
  state?: ElabState | number;
  team?: number;
  team_name?: string | null;
  userid?: number;
  userid_human?: string | null;
  created_by?: number;
  created_at?: string;
  modified_by?: number;
  modified_at?: string;

  /** Required on create; human-readable substance label. */
  name: string;

  // Structural descriptors
  molecular_formula?: string | null;
  molecular_weight?: string | null;
  inchi?: string | null;
  inchi_key?: string | null;
  smiles?: string | null;
  iupac_name?: string | null;

  // External database identifiers
  cas_number?: string | null;
  ec_number?: string | null;
  chebi_id?: string | null;
  chembl_id?: string | null;
  dea_number?: string | null;
  drugbank_id?: string | null;
  dsstox_id?: string | null;
  hmdb_id?: string | null;
  kegg_id?: string | null;
  metabolomics_wb_id?: string | null;
  nci_code?: string | null;
  nikkaji_number?: string | null;
  pharmgkb_id?: string | null;
  pharos_ligand_id?: string | null;
  pubchem_cid?: string | number | null;
  rxcui?: string | null;
  unii?: string | null;
  wikidata?: string | null;
  wikipedia?: string | null;

  // Hazard / classification flags (0 | 1 on the wire). See COMPOUND_HAZARD_FLAGS.
  is_corrosive?: 0 | 1;
  is_explosive?: 0 | 1;
  is_flammable?: 0 | 1;
  is_gas_under_pressure?: 0 | 1;
  is_hazardous2env?: 0 | 1;
  is_hazardous2health?: 0 | 1;
  is_oxidising?: 0 | 1;
  is_toxic?: 0 | 1;
  is_radioactive?: 0 | 1;
  is_serious_health_hazard?: 0 | 1;
  is_antibiotic?: 0 | 1;
  is_antibiotic_precursor?: 0 | 1;
  is_drug?: 0 | 1;
  is_drug_precursor?: 0 | 1;
  is_explosive_precursor?: 0 | 1;
  is_cmr?: 0 | 1;
  is_nano?: 0 | 1;
  is_controlled?: 0 | 1;
  is_ed2health?: 0 | 1;
  is_ed2env?: 0 | 1;
  is_pbt?: 0 | 1;
  is_pmt?: 0 | 1;
  is_vpvb?: 0 | 1;
  is_vpvm?: 0 | 1;

  // Internals — exposed but not generally useful to agents
  fp2_base64?: string | null;
  has_fingerprint?: 0 | 1;

  [key: string]: unknown;
}

/**
 * Query shape for `GET /compounds`. The `q` parameter does a full-text
 * search across name + identifiers; `limit` and `offset` paginate.
 */
export interface ElabCompoundQuery {
  q?: string;
  limit?: number;
  offset?: number;
  [key: string]: unknown;
}

/**
 * Hit returned by the PubChem-preview endpoints
 * (`GET /compounds?search_pubchem_{cid,cas,name}=...`). Field names follow
 * elabftw's PubChem importer convention (camelCase, distinct from the
 * snake_case `ElabCompound` shape used for stored compounds): `inChI`,
 * `inChIKey`, `iupacName`, `molecularFormula`, `molecularWeight`,
 * `isCorrosive`, `isExplosive`, etc.
 *
 * The CID-search path returns a single hit (no hazard flags); the
 * CAS / name paths return an array and *do* include hazard flags. We
 * model the union so both call paths are typed correctly.
 *
 * Source of truth: `elabftw/src/Services/PubChemImporter.php` +
 * `elabftw/src/Elabftw/Compound.php` (`toArray`).
 */
export interface ElabPubchemHit {
  name: string;
  cid: number;
  cas?: string | null;
  inChI?: string | null;
  inChIKey?: string | null;
  iupacName?: string | null;
  smiles?: string | null;
  molecularFormula?: string | null;
  molecularWeight?: number | null;
  isPublic?: 0 | 1 | boolean;
  // Hazard flags only present on CAS / name search results
  isCorrosive?: boolean;
  isExplosive?: boolean;
  isFlammable?: boolean;
  isGasUnderPressure?: boolean;
  isHazardous2env?: boolean;
  isHazardous2health?: boolean;
  isOxidising?: boolean;
  isToxic?: boolean;
  isSeriousHealthHazard?: boolean;
  [key: string]: unknown;
}

/**
 * PATCH-shaped diff for `elab_update_compound`. Every field is optional
 * (omitted means "leave alone"). Hazard flags accept `boolean` for
 * agent convenience; the client coerces to 0/1 before sending.
 */
export interface ElabCompoundPatch {
  name?: string;
  molecular_formula?: string | null;
  molecular_weight?: string | number | null;
  inchi?: string | null;
  inchi_key?: string | null;
  smiles?: string | null;
  iupac_name?: string | null;
  cas_number?: string | null;
  ec_number?: string | null;
  chebi_id?: string | null;
  chembl_id?: string | null;
  dea_number?: string | null;
  drugbank_id?: string | null;
  dsstox_id?: string | null;
  hmdb_id?: string | null;
  kegg_id?: string | null;
  metabolomics_wb_id?: string | null;
  nci_code?: string | null;
  nikkaji_number?: string | null;
  pharmgkb_id?: string | null;
  pharos_ligand_id?: string | null;
  pubchem_cid?: string | number | null;
  rxcui?: string | null;
  unii?: string | null;
  wikidata?: string | null;
  wikipedia?: string | null;
  is_corrosive?: boolean;
  is_explosive?: boolean;
  is_flammable?: boolean;
  is_gas_under_pressure?: boolean;
  is_hazardous2env?: boolean;
  is_hazardous2health?: boolean;
  is_oxidising?: boolean;
  is_toxic?: boolean;
  is_radioactive?: boolean;
  is_serious_health_hazard?: boolean;
  is_antibiotic?: boolean;
  is_antibiotic_precursor?: boolean;
  is_drug?: boolean;
  is_drug_precursor?: boolean;
  is_explosive_precursor?: boolean;
  is_cmr?: boolean;
  is_nano?: boolean;
  is_controlled?: boolean;
  is_ed2health?: boolean;
  is_ed2env?: boolean;
  is_pbt?: boolean;
  is_pmt?: boolean;
  is_vpvb?: boolean;
  is_vpvm?: boolean;
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

/**
 * Row returned by `GET /extra_fields_keys` — an instance-wide index of every
 * `extra_fields` key that has any data attached, with usage frequency. This
 * endpoint does NOT carry the field type, options, or units; those live
 * inside per-entity `metadata`. Call `elab_get` on an `experiments_templates`
 * or `items_types` to introspect a schema.
 *
 * Source of truth: `elabftw/src/Models/ExtraFieldsKeys.php:48-99`.
 */
export interface ElabExtraFieldKey {
  extra_fields_key: string;
  frequency: number;
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
 * The 15 elabftw 5.5 extra-field types. Source of truth:
 * `elabftw/src/ts/metadataInterfaces.ts:18-34` (the `ExtraFieldInputType` enum).
 *
 * Note that the UI sometimes uses friendlier labels (e.g. "Dropdown menu"
 * for `select`) but the wire-level / metadata-blob value is always one of
 * these literal strings.
 *
 * - Scalar: `text`, `number`, `date`, `datetime-local`, `email`, `time`, `url`
 * - Boolean: `checkbox`
 * - Choice: `select`, `radio`
 * - Entity links: `experiments`, `items`, `users`, `compounds`
 * - File handle: `uploads`
 */
export const EXTRA_FIELD_TYPES = [
  'text',
  'number',
  'checkbox',
  'date',
  'datetime-local',
  'email',
  'time',
  'url',
  'select',
  'radio',
  'experiments',
  'items',
  'users',
  'compounds',
  'uploads',
] as const;

export type ElabExtraFieldType = (typeof EXTRA_FIELD_TYPES)[number];

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

/**
 * Shape of one entry inside `metadata.extra_fields`. The `type` field is
 * narrowed to {@link ElabExtraFieldType} so callers get autocomplete on the
 * 15 supported types; the index signature still permits unknown extensions
 * (a future elabftw version may add new keys without breaking parsing).
 */
export interface ElabExtraFieldValue {
  type?: ElabExtraFieldType;
  value?: unknown;
  description?: string;
  required?: boolean;
  readonly?: boolean;
  group_id?: number | null;
  position?: number;
  options?: string[];
  unit?: string;
  units?: string[];
  blank_value_on_duplicate?: boolean;
  allow_multi_values?: boolean;
  [key: string]: unknown;
}
