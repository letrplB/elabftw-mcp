import { elabFetch, elabJson, extractLocationId } from './http';
import type {
  ElabCategory,
  ElabComment,
  ElabCompound,
  ElabCompoundPatch,
  ElabCompoundQuery,
  ElabPubchemHit,
  ElabCreateEntityInput,
  ElabDuplicateOptions,
  ElabEntity,
  ElabEntityAction,
  ElabEntityType,
  ElabEntityUpdate,
  ElabEvent,
  ElabExperimentsTemplate,
  ElabExtraFieldKey,
  ElabInfo,
  ElabItemsType,
  ElabLink,
  ElabListQuery,
  ElabMetadata,
  ElabRevision,
  ElabStatus,
  ElabStep,
  ElabTag,
  ElabTeam,
  ElabUpload,
  ElabUser,
  ElabftwConfig,
} from './types';

/**
 * Small, composable client for the elabftw v2 REST API.
 *
 * Design choices:
 *   - Stateless: every method takes a {@link ElabftwConfig}. This makes it
 *     safe to share a module-level import with differently-configured
 *     callers (e.g. per-user keys in an MCP server).
 *   - Thin: no retries, no caching, no rate limiting. Callers stack those
 *     on top if needed.
 *   - Honest: unknown fields survive as `unknown`; we do not pretend
 *     elabftw's shape is stable across minor versions.
 *
 * All paths documented in the OpenAPI spec map to a single method here.
 * The wrapper does not model admin-only endpoints (config, idps, audit,
 * reports); those should be added when a concrete need arises.
 */
export class ElabftwClient {
  constructor(private readonly config: ElabftwConfig) {}

  /** Raw JSON request. Escape hatch for endpoints not yet wrapped. */
  request<T = unknown>(
    path: string,
    options?: {
      method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
      query?: Record<string, unknown>;
      body?: unknown;
    }
  ): Promise<T> {
    return elabJson<T>(this.config, path, options?.query, {
      method: options?.method,
      body: options?.body,
    });
  }

  // ------------------------------------------------------------------------
  // Identity / instance metadata
  // ------------------------------------------------------------------------

  /** `GET /users/me` — the caller's own user record. */
  me(): Promise<ElabUser> {
    return elabJson(this.config, '/users/me');
  }

  /** `GET /info` — instance version and aggregate counts. */
  info(): Promise<ElabInfo> {
    return elabJson(this.config, '/info');
  }

  // ------------------------------------------------------------------------
  // Entity CRUD (experiments, items, templates, items_types)
  // ------------------------------------------------------------------------

  /** `GET /{entityType}` — list with filters. */
  list(
    entityType: ElabEntityType,
    query?: ElabListQuery
  ): Promise<ElabEntity[]> {
    return elabJson(this.config, `/${entityType}`, query as Record<string, unknown>);
  }

  /** `GET /{entityType}/{id}` — single entity. */
  get(entityType: ElabEntityType, id: number): Promise<ElabEntity> {
    return elabJson(this.config, `/${entityType}/${id}`);
  }

  /**
   * `GET /{entityType}/{id}?format=...` — export view.
   * Returns the raw `Response` so callers can stream binary formats
   * (pdf, zip, eln, qrpng, qrpdf). JSON formats can be parsed by caller.
   */
  export(
    entityType: ElabEntityType,
    id: number,
    format:
      | 'csv'
      | 'json'
      | 'pdf'
      | 'pdfa'
      | 'zip'
      | 'zipa'
      | 'eln'
      | 'elnhtml'
      | 'qrpdf'
      | 'qrpng',
    options?: { changelog?: boolean }
  ): Promise<Response> {
    return elabFetch(
      this.config,
      `/${entityType}/${id}`,
      {
        format,
        ...(options?.changelog ? { changelog: 'true' } : {}),
      },
      { accept: '*/*' }
    );
  }

  /**
   * `POST /{entityType}` — create an entity. elabftw returns 201 with a
   * `Location` header pointing at the new resource; this returns the new
   * numeric id, or null if elabftw did not provide it.
   *
   * After creation you typically `update()` to set title/body/metadata.
   */
  async create(
    entityType: ElabEntityType,
    input: ElabCreateEntityInput = {}
  ): Promise<number | null> {
    const response = await elabFetch(this.config, `/${entityType}`, undefined, {
      method: 'POST',
      body: input,
    });
    return extractLocationId(response);
  }

  /**
   * `PATCH /{entityType}/{id}` with the patch body sent directly. elabftw
   * silently drops unknown fields.
   *
   * Do not wrap the body in `{action:'update', ...}` — modern elabftw v2
   * treats `action:'update'` as a legacy dispatch requiring `target` and
   * `value` fields, and rejects a field-shaped body with
   * `400 "Invalid update target."`. The plain PATCH (no `action`) is the
   * supported shape for field edits; explicit actions like `duplicate`,
   * `lock`, `sign`, `timestamp` still go through {@link action}.
   */
  update(
    entityType: ElabEntityType,
    id: number,
    patch: ElabEntityUpdate
  ): Promise<ElabEntity> {
    return elabJson(this.config, `/${entityType}/${id}`, undefined, {
      method: 'PATCH',
      body: patch,
    });
  }

  /**
   * `PATCH /{entityType}/{id}` with an explicit action. Use {@link update}
   * for plain field edits; use this for state transitions (lock, sign,
   * timestamp, bloxberg, pin, archive, exclusiveeditmode).
   */
  action(
    entityType: ElabEntityType,
    id: number,
    action: ElabEntityAction,
    extra?: Record<string, unknown>
  ): Promise<ElabEntity> {
    return elabJson(this.config, `/${entityType}/${id}`, undefined, {
      method: 'PATCH',
      body: { action, ...extra },
    });
  }

  /**
   * Update a single extra_fields entry without having to rewrite the whole
   * `metadata` blob. Maps to `action:"updatemetadatafield"`.
   */
  updateExtraField(
    entityType: ElabEntityType,
    id: number,
    fieldName: string,
    value: unknown
  ): Promise<ElabEntity> {
    return elabJson(this.config, `/${entityType}/${id}`, undefined, {
      method: 'PATCH',
      body: {
        action: 'updatemetadatafield',
        [fieldName]: value,
      },
    });
  }

  /**
   * `POST /{entityType}/{id}` with `action:"duplicate"`. Returns the new id.
   */
  async duplicate(
    entityType: ElabEntityType,
    id: number,
    options?: ElabDuplicateOptions
  ): Promise<number | null> {
    const response = await elabFetch(
      this.config,
      `/${entityType}/${id}`,
      undefined,
      {
        method: 'POST',
        body: { action: 'duplicate', ...options },
      }
    );
    return extractLocationId(response);
  }

  /**
   * `DELETE /{entityType}/{id}` — soft-delete (sets state=3). The record
   * is still retrievable with `state=3` in list queries.
   */
  async remove(entityType: ElabEntityType, id: number): Promise<void> {
    await elabFetch(this.config, `/${entityType}/${id}`, undefined, {
      method: 'DELETE',
    });
  }

  // ------------------------------------------------------------------------
  // Sub-resources: uploads, comments, steps, links, tags, revisions
  // ------------------------------------------------------------------------

  /** `GET /{entityType}/{id}/uploads` — list attachments (metadata only). */
  listUploads(entityType: ElabEntityType, id: number): Promise<ElabUpload[]> {
    return elabJson(this.config, `/${entityType}/${id}/uploads`);
  }

  /** `GET /{entityType}/{id}/uploads/{subid}` — upload metadata. */
  getUpload(
    entityType: ElabEntityType,
    id: number,
    uploadId: number
  ): Promise<ElabUpload> {
    return elabJson(this.config, `/${entityType}/${id}/uploads/${uploadId}`);
  }

  /**
   * `GET /{entityType}/{id}/uploads/{subid}?format=binary` — raw bytes.
   * Returns the Response so callers can stream without buffering large files.
   */
  downloadUpload(
    entityType: ElabEntityType,
    id: number,
    uploadId: number
  ): Promise<Response> {
    return elabFetch(
      this.config,
      `/${entityType}/${id}/uploads/${uploadId}`,
      { format: 'binary' },
      { accept: '*/*' }
    );
  }

  /**
   * `POST /{entityType}/{id}/uploads` — attach a file.
   * Accepts either a standard File (with embedded name) or a Blob+filename.
   */
  async uploadFile(
    entityType: ElabEntityType,
    id: number,
    file: Blob | File,
    options?: { filename?: string; comment?: string }
  ): Promise<number | null> {
    const form = new FormData();
    const filename =
      options?.filename ?? (file instanceof File ? file.name : 'upload.bin');
    form.append('file', file, filename);
    if (options?.comment) form.append('comment', options.comment);

    const response = await elabFetch(
      this.config,
      `/${entityType}/${id}/uploads`,
      undefined,
      { method: 'POST', rawBody: form }
    );
    return extractLocationId(response);
  }

  /** `DELETE /{entityType}/{id}/uploads/{subid}` — detach / delete a file. */
  async deleteUpload(
    entityType: ElabEntityType,
    id: number,
    uploadId: number
  ): Promise<void> {
    await elabFetch(
      this.config,
      `/${entityType}/${id}/uploads/${uploadId}`,
      undefined,
      { method: 'DELETE' }
    );
  }

  /** Comments — CRUD. */
  listComments(
    entityType: ElabEntityType,
    id: number
  ): Promise<ElabComment[]> {
    return elabJson(this.config, `/${entityType}/${id}/comments`);
  }

  async addComment(
    entityType: ElabEntityType,
    id: number,
    comment: string
  ): Promise<number | null> {
    const response = await elabFetch(
      this.config,
      `/${entityType}/${id}/comments`,
      undefined,
      { method: 'POST', body: { comment } }
    );
    return extractLocationId(response);
  }

  updateComment(
    entityType: ElabEntityType,
    id: number,
    commentId: number,
    comment: string
  ): Promise<ElabComment> {
    return elabJson(
      this.config,
      `/${entityType}/${id}/comments/${commentId}`,
      undefined,
      { method: 'PATCH', body: { comment } }
    );
  }

  async deleteComment(
    entityType: ElabEntityType,
    id: number,
    commentId: number
  ): Promise<void> {
    await elabFetch(
      this.config,
      `/${entityType}/${id}/comments/${commentId}`,
      undefined,
      { method: 'DELETE' }
    );
  }

  /** Steps (checklist). */
  listSteps(entityType: ElabEntityType, id: number): Promise<ElabStep[]> {
    return elabJson(this.config, `/${entityType}/${id}/steps`);
  }

  async addStep(
    entityType: ElabEntityType,
    id: number,
    body: string,
    options?: { deadline?: string; deadline_notif?: boolean }
  ): Promise<number | null> {
    const response = await elabFetch(
      this.config,
      `/${entityType}/${id}/steps`,
      undefined,
      {
        method: 'POST',
        body: {
          body,
          ...(options?.deadline ? { deadline: options.deadline } : {}),
          ...(options?.deadline_notif !== undefined
            ? { deadline_notif: options.deadline_notif ? 1 : 0 }
            : {}),
        },
      }
    );
    return extractLocationId(response);
  }

  /**
   * Toggle a step's `finished` flag. elabftw sets `finished_time`
   * server-side when finished=1.
   */
  toggleStep(
    entityType: ElabEntityType,
    id: number,
    stepId: number,
    finished: boolean
  ): Promise<ElabStep> {
    return elabJson(
      this.config,
      `/${entityType}/${id}/steps/${stepId}`,
      undefined,
      {
        method: 'PATCH',
        body: { action: 'finish', finished: finished ? 1 : 0 },
      }
    );
  }

  async deleteStep(
    entityType: ElabEntityType,
    id: number,
    stepId: number
  ): Promise<void> {
    await elabFetch(
      this.config,
      `/${entityType}/${id}/steps/${stepId}`,
      undefined,
      { method: 'DELETE' }
    );
  }

  /**
   * `PATCH /{entityType}/{id}/steps/{stepId}` with field updates. Modern
   * elabftw v2 treats a plain PATCH (no `action`) as a direct row update,
   * so this is the path for editing a step's prose, deadline, or
   * deadline-notification flag without churning the audit trail by
   * delete + re-add. The `action`-shaped path is reserved for
   * `finish` / `notif` (see {@link toggleStep}).
   *
   * `deadline_notif` is stored as 0/1 on the wire; the boolean arg here is
   * coerced to match {@link addStep}.
   */
  updateStep(
    entityType: ElabEntityType,
    id: number,
    stepId: number,
    patch: { body?: string; deadline?: string | null; deadline_notif?: boolean }
  ): Promise<ElabStep> {
    return elabJson(
      this.config,
      `/${entityType}/${id}/steps/${stepId}`,
      undefined,
      {
        method: 'PATCH',
        body: {
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          ...(patch.deadline !== undefined ? { deadline: patch.deadline } : {}),
          ...(patch.deadline_notif !== undefined
            ? { deadline_notif: patch.deadline_notif ? 1 : 0 }
            : {}),
        },
      }
    );
  }

  /**
   * Links between entities. elabftw splits these by target kind:
   *   - `/experiments_links` when the target is an experiment
   *   - `/items_links` when the target is an item
   *   - `/compounds_links` when the target is a compound (add/delete only;
   *     this method does not list compound links — they're surfaced on the
   *     parent entity via the GET handler's `compounds_links` block)
   */
  listLinks(
    fromType: ElabEntityType,
    fromId: number,
    targetKind: 'experiments' | 'items'
  ): Promise<ElabLink[]> {
    const sub = targetKind === 'experiments' ? 'experiments_links' : 'items_links';
    return elabJson(this.config, `/${fromType}/${fromId}/${sub}`);
  }

  async addLink(
    fromType: ElabEntityType,
    fromId: number,
    targetKind: 'experiments' | 'items' | 'compounds',
    targetId: number
  ): Promise<void> {
    const sub =
      targetKind === 'experiments'
        ? 'experiments_links'
        : targetKind === 'items'
          ? 'items_links'
          : 'compounds_links';
    await elabFetch(
      this.config,
      `/${fromType}/${fromId}/${sub}/${targetId}`,
      undefined,
      { method: 'POST' }
    );
  }

  async deleteLink(
    fromType: ElabEntityType,
    fromId: number,
    targetKind: 'experiments' | 'items' | 'compounds',
    targetId: number
  ): Promise<void> {
    const sub =
      targetKind === 'experiments'
        ? 'experiments_links'
        : targetKind === 'items'
          ? 'items_links'
          : 'compounds_links';
    await elabFetch(
      this.config,
      `/${fromType}/${fromId}/${sub}/${targetId}`,
      undefined,
      { method: 'DELETE' }
    );
  }

  /**
   * `GET /{entityType}/{id}/revisions` — list prior body snapshots.
   *
   * Availability: elabftw revisions are controlled by a per-instance
   * config flag. On instances with revisions disabled, elabftw returns
   * 400 / 404. Callers should tolerate that as "no history available".
   */
  listRevisions(
    entityType: ElabEntityType,
    id: number
  ): Promise<ElabRevision[]> {
    return elabJson(this.config, `/${entityType}/${id}/revisions`);
  }

  /** `GET /{entityType}/{id}/revisions/{revisionId}` — one snapshot. */
  getRevision(
    entityType: ElabEntityType,
    id: number,
    revisionId: number
  ): Promise<ElabRevision> {
    return elabJson(
      this.config,
      `/${entityType}/${id}/revisions/${revisionId}`
    );
  }

  /** Tags on a single entity. */
  listEntityTags(
    entityType: ElabEntityType,
    id: number
  ): Promise<ElabTag[]> {
    return elabJson(this.config, `/${entityType}/${id}/tags`);
  }

  async addEntityTag(
    entityType: ElabEntityType,
    id: number,
    tag: string
  ): Promise<void> {
    await elabFetch(this.config, `/${entityType}/${id}/tags`, undefined, {
      method: 'POST',
      body: { tag },
    });
  }

  async deleteEntityTag(
    entityType: ElabEntityType,
    id: number,
    tagId: number
  ): Promise<void> {
    await elabFetch(
      this.config,
      `/${entityType}/${id}/tags/${tagId}`,
      undefined,
      { method: 'DELETE' }
    );
  }

  // ------------------------------------------------------------------------
  // Global collections
  // ------------------------------------------------------------------------

  /**
   * `GET /teams/current/tags` — tags in the caller's current team.
   *
   * Endpoint history: `/tags` (pre-5.x) → `/team_tags` (early 5.x) →
   * `/teams/current/tags` (5.5+). We target the current spelling.
   */
  listTags(query?: { q?: string }): Promise<ElabTag[]> {
    return elabJson(this.config, '/teams/current/tags', query);
  }

  /**
   * `POST /teams/current/tags` with `{tag}` — create (or no-op upsert) a
   * tag in the caller's team without attaching it to any entity. elabftw's
   * `TeamTags::create` uses `INSERT ... ON DUPLICATE KEY UPDATE`, so calling
   * this with an existing tag string is idempotent and yields the existing
   * tag id via the `Location` header.
   *
   * Returns the new (or existing) tag id, or `null` if elabftw did not
   * surface it via the Location header.
   *
   * Source of truth: `elabftw/src/Models/TeamTags.php:57-78`.
   */
  async createTag(tag: string): Promise<number | null> {
    const response = await elabFetch(
      this.config,
      '/teams/current/tags',
      undefined,
      { method: 'POST', body: { tag } }
    );
    return extractLocationId(response);
  }

  /**
   * `DELETE /teams/current/tags/{tagId}` — permanently delete a team tag.
   * elabftw first unreferences the tag from every entity that carried it,
   * then deletes the row. Resolve the id via {@link listTags} first.
   *
   * Source of truth: `elabftw/src/Models/TeamTags.php:133-...` (destroy).
   */
  async deleteTag(tagId: number): Promise<void> {
    await elabFetch(
      this.config,
      `/teams/current/tags/${tagId}`,
      undefined,
      { method: 'DELETE' }
    );
  }

  /**
   * `GET /teams/current/experiments_categories` — the team's experiment
   * categories. Categories also act as template selectors on experiment
   * create (`elab_create_entity(experiments, category_id=<id>)`) and
   * color-code the experiment list.
   *
   * Source of truth: `elabftw/src/Enums/ApiSubModels.php:25`
   * (`ExperimentsCategories = 'experiments_categories'`) +
   * `elabftw/src/Models/AbstractStatus.php:96-123` (readAll query).
   */
  listExperimentsCategories(): Promise<ElabCategory[]> {
    return elabJson(this.config, '/teams/current/experiments_categories');
  }

  /**
   * `GET /teams/current/experiments_status` — workflow statuses for
   * experiments (e.g. "Running", "Success", "Fail"). The `status` arg
   * on `elab_create_entity` / `elab_update_entity` takes an id from this
   * list.
   *
   * Source of truth: `elabftw/src/Models/ExperimentsStatus.php` extends
   * AbstractStatus; see `elabftw/src/Models/AbstractStatus.php:96-123`.
   */
  listExperimentsStatus(): Promise<ElabStatus[]> {
    return elabJson(this.config, '/teams/current/experiments_status');
  }

  /**
   * `GET /teams/current/items_status` — workflow statuses for items
   * (resources). Same shape as experiment statuses; lives in a separate
   * table because items can declare their own state vocabulary
   * (e.g. "In stock", "Depleted").
   *
   * Source of truth: `elabftw/src/Models/ItemsStatus.php` extends
   * AbstractStatus.
   */
  listItemsStatus(): Promise<ElabStatus[]> {
    return elabJson(this.config, '/teams/current/items_status');
  }

  /**
   * `GET /compounds` — list/search the team's compound catalog. The `q`
   * parameter does a server-side full-text search across name + identifiers
   * (CAS, CID, InChI, SMILES, formula).
   *
   * Source of truth: `elabftw/src/Models/Compounds.php` (readAll).
   */
  listCompounds(query?: ElabCompoundQuery): Promise<ElabCompound[]> {
    return elabJson(
      this.config,
      '/compounds',
      query as Record<string, unknown> | undefined
    );
  }

  /** `GET /compounds/{id}` — fetch one compound. */
  getCompound(id: number): Promise<ElabCompound> {
    return elabJson(this.config, `/compounds/${id}`);
  }

  /**
   * `POST /compounds` — create a compound. elabftw requires
   * `action: 'create'` on the POST body plus the substance fields (only
   * `name` is strictly required). Boolean hazard flags are coerced to 0/1
   * to match the wire shape.
   *
   * Returns the new compound id parsed from the `Location` header.
   */
  async createCompound(input: { name: string } & ElabCompoundPatch): Promise<
    number | null
  > {
    const body = {
      action: 'create',
      ...serializeCompoundPatch(input),
    };
    const response = await elabFetch(
      this.config,
      '/compounds',
      undefined,
      { method: 'POST', body }
    );
    return extractLocationId(response);
  }

  /**
   * `PATCH /compounds/{id}` — partial update. Plain PATCH (no `action`)
   * matches modern elabftw v2 row-update semantics, consistent with
   * {@link update} for entities. Hazard flag booleans are coerced to 0/1.
   */
  async updateCompound(
    id: number,
    patch: ElabCompoundPatch
  ): Promise<ElabCompound> {
    return elabJson(this.config, `/compounds/${id}`, undefined, {
      method: 'PATCH',
      body: serializeCompoundPatch(patch),
    });
  }

  /**
   * `DELETE /compounds/{id}` — soft-delete (sets state=3, consistent with
   * `elab_delete_entity`). Permanent deletion is sysadmin-only and not
   * exposed.
   */
  async deleteCompound(id: number): Promise<void> {
    await elabFetch(this.config, `/compounds/${id}`, undefined, {
      method: 'DELETE',
    });
  }

  /**
   * `GET /compounds?search_pubchem_cid=<cid>` — preview a compound from
   * PubChem by CID without writing anything to elabftw. Returns the parsed
   * Compound shape (camelCase fields per the elabftw importer convention;
   * no hazard flags on this path — PubChem hazard data is only resolved on
   * the CAS / name paths). Useful for showing the agent what a record will
   * look like before committing to a create.
   *
   * Source of truth: `elabftw/src/Models/Compounds.php:94-101`,
   * `elabftw/src/Services/PubChemImporter.php`.
   */
  searchPubchemCid(cid: number): Promise<ElabPubchemHit> {
    return elabJson(this.config, '/compounds', {
      search_pubchem_cid: cid,
    });
  }

  /**
   * `GET /compounds?search_pubchem_cas=<cas>` — PubChem search by CAS
   * number. Returns 0..N hits as an array; includes hazard flags resolved
   * from PubChem.
   */
  searchPubchemCas(cas: string): Promise<ElabPubchemHit[]> {
    return elabJson(this.config, '/compounds', {
      search_pubchem_cas: cas,
    });
  }

  /**
   * `GET /compounds?search_pubchem_name=<name>` — PubChem search by
   * substance name (free-text). Returns 0..N hits as an array; includes
   * hazard flags. Use sparingly — names are ambiguous; prefer CAS or CID.
   */
  searchPubchemName(name: string): Promise<ElabPubchemHit[]> {
    return elabJson(this.config, '/compounds', {
      search_pubchem_name: name,
    });
  }

  /**
   * `POST /compounds` with `action: 'duplicate'` and `{cid}` — fetch the
   * compound from PubChem and create a new row in the team's compound
   * catalog with all fields pre-filled (name, identifiers, structure,
   * hazard flags). Returns the new compound id from the `Location`
   * header.
   *
   * Source of truth: `elabftw/src/Models/Compounds.php:192-216` —
   * `postAction` dispatches `Action::Duplicate` to
   * `createCompoundFromIdentifier` which routes by `cid` (preferred) or
   * `cas` (fallback).
   */
  async createCompoundFromPubchemCid(cid: number): Promise<number | null> {
    const response = await elabFetch(this.config, '/compounds', undefined, {
      method: 'POST',
      body: { action: 'duplicate', cid },
    });
    return extractLocationId(response);
  }

  /**
   * `POST /compounds` with `action: 'duplicate'` and `{cas}` — same as
   * {@link createCompoundFromPubchemCid} but routes through PubChem's
   * CAS → CID lookup before fetching. Use when only the CAS is known.
   */
  async createCompoundFromPubchemCas(cas: string): Promise<number | null> {
    const response = await elabFetch(this.config, '/compounds', undefined, {
      method: 'POST',
      body: { action: 'duplicate', cas },
    });
    return extractLocationId(response);
  }

  /** `GET /users` (sysadmin) or `GET /users/search?q=...`. */
  searchUsers(q: string): Promise<ElabUser[]> {
    return elabJson(this.config, '/users', { q });
  }

  getUser(userid: number): Promise<ElabUser> {
    return elabJson(this.config, `/users/${userid}`);
  }

  listTeams(): Promise<ElabTeam[]> {
    return elabJson(this.config, '/teams');
  }

  /**
   * `GET /extra_fields_keys` — instance-wide index of every `extra_fields`
   * key that has any data attached, with usage frequency. Useful for
   * autocomplete / cohort discovery. Returns `[{extra_fields_key, frequency}]`
   * sorted by frequency desc. Does NOT carry per-field type/options — those
   * live inside each entity's `metadata.extra_fields[<name>]`.
   *
   * (Endpoint was `/extra_fields` in older versions.)
   */
  listExtraFieldNames(): Promise<ElabExtraFieldKey[]> {
    return elabJson(this.config, '/extra_fields_keys');
  }

  /** `GET /events` — scheduler bookings for bookable items. */
  listEvents(query?: {
    start?: string;
    end?: string;
    item?: number;
  }): Promise<ElabEvent[]> {
    return elabJson(this.config, '/events', query);
  }

  /**
   * `GET /unfinished_steps` — open checklist items across accessible entries
   * for the API key's team. Response groups by entity kind, with each entity
   * carrying its open steps as `[stepId, body]` tuples (string-typed).
   */
  listUnfinishedSteps(): Promise<{
    experiments?: Array<{ id: number; title: string; steps: Array<[string, string]> }>;
    items?: Array<{ id: number; title: string; steps: Array<[string, string]> }>;
  }> {
    return elabJson(this.config, '/unfinished_steps');
  }

  /** `GET /todolist` — personal todos. */
  listTodos(): Promise<
    Array<{ id: number; body: string; creation_time?: string }>
  > {
    return elabJson(this.config, '/todolist');
  }

  listTemplates(query?: ElabListQuery): Promise<ElabExperimentsTemplate[]> {
    return elabJson(
      this.config,
      '/experiments_templates',
      query as Record<string, unknown>
    );
  }

  listItemsTypes(query?: ElabListQuery): Promise<ElabItemsType[]> {
    return elabJson(
      this.config,
      '/items_types',
      query as Record<string, unknown>
    );
  }

  // ------------------------------------------------------------------------
  // Metadata helpers
  // ------------------------------------------------------------------------

  /**
   * Normalize elabftw's `metadata` field into a typed object. Handles the
   * common case where the instance returns a JSON-encoded *string*.
   * Returns `null` if metadata is missing or unparseable.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  parseMetadata(entity: ElabEntity): ElabMetadata | null {
    const raw = entity.metadata;
    if (raw == null) return null;
    if (typeof raw === 'string') {
      if (!raw.trim()) return null;
      try {
        return JSON.parse(raw) as ElabMetadata;
      } catch {
        return null;
      }
    }
    return raw as ElabMetadata;
  }

  // ------------------------------------------------------------------------
  // Pagination
  // ------------------------------------------------------------------------

  /**
   * Pages through a list endpoint until it returns fewer rows than the
   * requested limit. elabftw has no cursor / total-count header, so this
   * is the only safe way to sync large corpora.
   */
  async *paginate(
    entityType: ElabEntityType,
    query: ElabListQuery = {},
    pageSize = 100
  ): AsyncGenerator<ElabEntity, void, unknown> {
    let offset = query.offset ?? 0;
    while (true) {
      const page = await this.list(entityType, {
        ...query,
        limit: pageSize,
        offset,
      });
      for (const row of page) yield row;
      if (page.length < pageSize) return;
      offset += pageSize;
    }
  }
}

/**
 * Convert an {@link ElabCompoundPatch} to the wire shape. Boolean hazard
 * flags become 0/1 integers; everything else is passed through unchanged.
 * Undefined fields are omitted so they don't accidentally clear existing
 * values on PATCH.
 */
function serializeCompoundPatch(
  patch: ElabCompoundPatch
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key.startsWith('is_') && typeof value === 'boolean') {
      out[key] = value ? 1 : 0;
    } else {
      out[key] = value;
    }
  }
  return out;
}
