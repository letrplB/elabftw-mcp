import {
  ElabftwApiError,
  elabFetch,
  elabJson,
  extractLocationId,
} from './http';
import type {
  ElabCategory,
  ElabComment,
  ElabCompound,
  ElabCompoundCreateResult,
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
 * Targets eLabFTW 6.0 (6.0.9) and stays compatible with 5.6 where the
 * endpoint exists there (6.0-only endpoints are marked). Only the subset
 * of the v2 API the toolkit needs is wrapped; admin-only endpoints
 * (config, idps, audit, reports) are not. Use {@link request} for
 * anything not covered.
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
   * `PATCH /{entityType}/{id}` with the patch body sent directly. Every key
   * must be a writable column: eLabFTW rejects unknown keys with
   * `400 "Invalid update target."` (`EntityParams::getContent`).
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
   * Set a step's `finished` state idempotently. elabftw's
   * `Action::Finish` is a *toggle*, not a setter — it flips the column
   * unconditionally, ignores any `finished` value in the body, AND has
   * a side effect: it clears `deadline` and `deadline_notif` every
   * time it fires. Passing a `finished: boolean` arg to a toggle is a
   * UX trap (flipping an already-finished step to unfinished while
   * losing the deadline) so the toolkit wraps it with a read-modify-
   * write: GET the current state, only PATCH when it doesn't match
   * the requested state.
   *
   * Returns the (possibly unchanged) step row.
   *
   * Source of truth: `Steps::toggleFinished` (note the
   * `deadline = null, deadline_notif = 0` in its UPDATE).
   */
  async toggleStep(
    entityType: ElabEntityType,
    id: number,
    stepId: number,
    finished: boolean
  ): Promise<ElabStep> {
    const stepUrl = `/${entityType}/${id}/steps/${stepId}`;
    const current = (await elabJson(this.config, stepUrl)) as ElabStep;
    const desired = finished ? 1 : 0;
    if (current.finished === desired) return current;
    return elabJson(this.config, stepUrl, undefined, {
      method: 'PATCH',
      body: { action: 'finish' },
    });
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
   * Edit a step's `body` and/or `deadline` and/or `deadline_notif`. The
   * elabftw v2 step PATCH dispatcher routes by `Action::*` enum, with
   * three idiosyncrasies the toolkit smooths over:
   *
   * - **No `action` key on field updates.** The controller defaults to
   *   `Action::Update` when no `action` is in the body
   *   (`Apiv2Controller::handlePatch`). The `Action::Update`
   *   branch in `Steps::patch` then iterates `$params` and calls
   *   `StepParams($key, $value)` for each entry — including any `action`
   *   key the caller sent, which fails the whitelist (`body`,
   *   `deadline`, `finished_time`, `is_immutable` only) with
   *   `"Incorrect parameter for steps"`. Sending `action: 'update'`
   *   explicitly breaks the field-update path; sending no action at all
   *   is the supported shape.
   * - **`deadline_notif` is not writable directly.** It lives behind
   *   two separate actions — `Action::Notif` (toggle, requires the row
   *   to already carry a deadline) and `Action::NotifDestroy` (clear).
   *   For idempotent set-to-true semantics we GET the current state and
   *   only fire the toggle when needed; set-to-false always uses
   *   `NotifDestroy` (which is idempotent).
   * - **Order matters when combining.** Body/deadline must land first so
   *   a deadline change is visible to the subsequent notif toggle (the
   *   server reads the current `deadline` to populate the notification
   *   record).
   *
   * Source of truth: `Steps::patch` (dispatcher), `StepParams` (writable
   * columns), `Apiv2Controller::handlePatch` (default action for PATCH).
   */
  async updateStep(
    entityType: ElabEntityType,
    id: number,
    stepId: number,
    patch: { body?: string; deadline?: string | null; deadline_notif?: boolean }
  ): Promise<ElabStep> {
    const stepUrl = `/${entityType}/${id}/steps/${stepId}`;

    // Field-update path. No `action` key — controller defaults to
    // Action::Update and the iterator only sees the whitelisted columns.
    const updateBody: Record<string, unknown> = {};
    if (patch.body !== undefined) updateBody.body = patch.body;
    if (patch.deadline !== undefined) updateBody.deadline = patch.deadline;
    if (Object.keys(updateBody).length > 0) {
      await elabFetch(this.config, stepUrl, undefined, {
        method: 'PATCH',
        body: updateBody,
      });
    }

    // deadline_notif lives behind separate actions. `Notif` toggles
    // (not idempotent) and depends on the row already carrying a
    // deadline; `NotifDestroy` always clears. Read-modify-write avoids
    // an accidental toggle-back when the state is already correct.
    if (patch.deadline_notif === true) {
      const current = (await elabJson(this.config, stepUrl)) as ElabStep;
      if (current.deadline_notif !== 1) {
        await elabFetch(this.config, stepUrl, undefined, {
          method: 'PATCH',
          body: { action: 'notif' },
        });
      }
    } else if (patch.deadline_notif === false) {
      await elabFetch(this.config, stepUrl, undefined, {
        method: 'PATCH',
        body: { action: 'notifdestroy' },
      });
    }

    return elabJson(this.config, stepUrl);
  }

  /**
   * Links between entities. elabftw splits these by target kind:
   *   - `/experiments_links` when the target is an experiment
   *   - `/items_links` when the target is an item
   *   - `/compounds_links` when the target is a compound — see
   *     {@link listCompoundLinks} / {@link addCompoundLink} /
   *     {@link deleteCompoundLink} (compound link rows have a different
   *     shape: they are compound records, not entity link rows).
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
   * `GET /{entityType}/{id}/compounds_links` — compounds linked to an
   * entity. Each row is the full compound record (`id` is the compound
   * id), from `AbstractCompoundsLinks::readAll`; deleted compounds are
   * excluded.
   */
  listCompoundLinks(
    entityType: ElabEntityType,
    id: number
  ): Promise<ElabCompound[]> {
    return elabJson(this.config, `/${entityType}/${id}/compounds_links`);
  }

  /**
   * `POST /{entityType}/{id}/compounds_links/{compoundId}` with
   * `{action:"create"}` — link a compound to an entity. Idempotent
   * (`INSERT IGNORE`): re-linking an already-linked compound succeeds.
   */
  async addCompoundLink(
    entityType: ElabEntityType,
    id: number,
    compoundId: number
  ): Promise<void> {
    await elabFetch(
      this.config,
      `/${entityType}/${id}/compounds_links/${compoundId}`,
      undefined,
      { method: 'POST', body: { action: 'create' } }
    );
  }

  /**
   * `DELETE /{entityType}/{id}/compounds_links/{compoundId}` — unlink a
   * compound from an entity. The compound itself is untouched.
   */
  async deleteCompoundLink(
    entityType: ElabEntityType,
    id: number,
    compoundId: number
  ): Promise<void> {
    await elabFetch(
      this.config,
      `/${entityType}/${id}/compounds_links/${compoundId}`,
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

  /** `GET /teams/current/tags` — tags in the caller's current team. */
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
   * Source of truth: `TeamTags::create`.
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
   * Source of truth: `TeamTags::destroy`.
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
   * categories: a classification label (with color) set via an
   * experiment's `category` field. Categories are not templates; experiment
   * templates are `/experiments_templates` ({@link listTemplates}).
   *
   * Source of truth: `ApiSubModels::ExperimentsCategories` +
   * `AbstractStatus::readAll`.
   */
  listExperimentsCategories(): Promise<ElabCategory[]> {
    return elabJson(this.config, '/teams/current/experiments_categories');
  }

  /**
   * `GET /teams/current/resources_categories` — the team's resource (item)
   * categories, set via an item's `category` field. eLabFTW 6.0+: resource
   * categories are separate from resource templates (`/items_types`,
   * {@link listItemsTypes}) — e.g. category #51 "Reaction" and items_type
   * #33 "Reaction" are different rows. Not available on 5.x (404).
   *
   * Source of truth: `ApiSubModels::ResourcesCategories` +
   * `AbstractStatus::readAll`.
   */
  listItemsCategories(): Promise<ElabCategory[]> {
    return elabJson(this.config, '/teams/current/resources_categories');
  }

  /**
   * `GET /teams/current/experiments_status` — workflow statuses for
   * experiments (e.g. "Running", "Success", "Fail"). The `status` arg
   * on `elab_create_entity` / `elab_update_entity` takes an id from this
   * list.
   *
   * Source of truth: `ExperimentsStatus` (extends `AbstractStatus`).
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
   * Source of truth: `ItemsStatus` (extends `AbstractStatus`).
   */
  listItemsStatus(): Promise<ElabStatus[]> {
    return elabJson(this.config, '/teams/current/items_status');
  }

  /**
   * `GET /compounds` — list/search the team's compound catalog. The `q`
   * parameter does a server-side full-text search across name + identifiers
   * (CAS, CID, InChI, SMILES, formula).
   *
   * Source of truth: `Compounds::readAll`.
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
   * `name` is strictly required).
   *
   * **POST signature limitation.** elabftw's `Compounds::postAction`
   * destructures `$reqBody` for a fixed subset of fields and silently
   * drops everything else. Specifically: `molecular_weight`, all long-tail
   * identifiers (`ec_number`, `chebi_id`, `chembl_id`, `dea_number`,
   * `drugbank_id`, `dsstox_id`, `hmdb_id`, `kegg_id`, `metabolomics_wb_id`,
   * `nci_code`, `nikkaji_number`, `pharmgkb_id`, `pharos_ligand_id`,
   * `rxcui`, `unii`, `wikidata`, `wikipedia`), and 16 of the 24 hazard
   * flags (`is_radioactive`, `is_antibiotic*`, `is_drug*`,
   * `is_explosive_precursor`, `is_cmr`, `is_nano`, `is_controlled`,
   * `is_ed2*`, `is_pbt`, `is_pmt`, `is_vpvb`, `is_vpvm`) never make it to
   * the row on create. This method works around the gap with a
   * reconcile-on-POST PATCH that lands every non-POST-accepted field
   * the caller provided.
   *
   * Returns the new compound id parsed from the `Location` header. If the
   * POST succeeds but the reconcile PATCH fails, this throws an
   * {@link ElabCompoundReconcileError} that carries the new id
   * (`compoundId`) — the compound EXISTS, so callers must not retry the
   * create. Prefer {@link createCompoundDetailed}, which returns the id and
   * the reconcile failure as data instead of throwing.
   *
   * Source of truth: `Compounds::postAction` / `Compounds::create`.
   */
  async createCompound(input: { name: string } & ElabCompoundPatch): Promise<
    number | null
  > {
    const result = await this.createCompoundDetailed(input);
    if (result.reconcileError && result.id != null) {
      throw new ElabCompoundReconcileError(
        result.id,
        result.unreconciledFields ?? [],
        result.reconcileError
      );
    }
    return result.id;
  }

  /**
   * Same as {@link createCompound}, but a failed reconcile PATCH is
   * reported in the result instead of thrown: `{ id, reconcileError,
   * unreconciledFields }`. `id` is the created compound (null only when
   * elabftw returned no `Location` header). When `reconcileError` is set,
   * the compound exists with the POST-accepted fields only; re-apply
   * `unreconciledFields` with {@link updateCompound}.
   */
  async createCompoundDetailed(
    input: { name: string } & ElabCompoundPatch
  ): Promise<ElabCompoundCreateResult> {
    const serialized = serializeCompoundPatch(input);
    const response = await elabFetch(
      this.config,
      '/compounds',
      undefined,
      { method: 'POST', body: { action: 'create', ...serialized } }
    );
    const id = extractLocationId(response);
    if (id == null) return { id: null };

    // The reconcile patch covers everything that didn't make it onto the
    // POST signature. Re-asserting fields that already landed via POST is
    // harmless, so no diff against a fresh GET.
    const reconcilePatch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(serialized)) {
      if (!COMPOUND_POST_ACCEPTED_FIELDS.has(k)) reconcilePatch[k] = v;
    }
    const fields = Object.keys(reconcilePatch);
    if (fields.length === 0) return { id };
    try {
      await elabFetch(this.config, `/compounds/${id}`, undefined, {
        method: 'PATCH',
        body: reconcilePatch,
      });
      return { id };
    } catch (error) {
      const message =
        error instanceof ElabftwApiError
          ? `${error.message}${error.body ? `: ${error.body}` : ''}`
          : error instanceof Error
            ? error.message
            : String(error);
      return { id, reconcileError: message, unreconciledFields: fields };
    }
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
   * Source of truth: `Compounds::readAll` (search_pubchem_* params),
   * `PubChemImporter`.
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
   * Source of truth: `Compounds::postAction` dispatches `Action::Duplicate` to
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

  /**
   * `GET /users?q=...` — users matching `q` (name / email); empty `q`
   * lists every user the key can see (sysadmin: everyone; team admin:
   * users of their teams).
   */
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
   * `GET /unfinished_steps` — open checklist items, grouped by entity kind,
   * each entity carrying its open steps as `[stepId, body]` tuples
   * (string-typed). Rows have no `team` field.
   *
   * Default: the caller's own entries — from every team the caller belongs
   * to, not only the key's team. `scope: 'team'`: every readable entry
   * whose `team` is the key's team (`UnfinishedSteps` with `teamScoped`).
   */
  listUnfinishedSteps(options?: { scope?: 'team' }): Promise<{
    experiments?: Array<{ id: number; title: string; steps: Array<[string, string]> }>;
    items?: Array<{ id: number; title: string; steps: Array<[string, string]> }>;
  }> {
    return elabJson(
      this.config,
      '/unfinished_steps',
      options?.scope ? { scope: options.scope } : undefined
    );
  }

  /** `GET /todolist` — personal todos. */
  listTodos(): Promise<
    Array<{ id: number; body: string; creation_time?: string }>
  > {
    return elabJson(this.config, '/todolist');
  }

  /** `GET /experiments_templates` — experiment templates. */
  listTemplates(query?: ElabListQuery): Promise<ElabExperimentsTemplate[]> {
    return elabJson(
      this.config,
      '/experiments_templates',
      query as Record<string, unknown>
    );
  }

  /**
   * `GET /items_types` — resource templates (eLabFTW 6.0 UI: "Resource
   * templates"; 5.x: "Resource categories"). Instantiate one with
   * `create('items', { template: <id> })`. In 6.0 the resource *category*
   * is a separate concept, listed by {@link listItemsCategories}.
   */
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
 * Thrown by {@link ElabftwClient.createCompound} when the compound was
 * created but the follow-up PATCH (fields `POST /compounds` ignores)
 * failed. The compound exists as `compoundId`; do not re-create it.
 */
export class ElabCompoundReconcileError extends Error {
  constructor(
    readonly compoundId: number,
    readonly unreconciledFields: string[],
    readonly reason: string
  ) {
    super(
      `Compound #${compoundId} was created, but setting ${unreconciledFields.join(', ')} failed (${reason}). ` +
        `Do not create it again; re-apply those fields with an update of compound #${compoundId}.`
    );
    this.name = 'ElabCompoundReconcileError';
  }
}

/**
 * Fields that elabftw's `POST /compounds` actually persists. Everything
 * else in the request body is silently dropped (see the elabftw
 * `Compounds::postAction` create signature). The toolkit's
 * `createCompound` PATCHes the remaining fields after POST so callers
 * don't have to track the limitation themselves.
 *
 * Source of truth: `Compounds::postAction` —
 * `postAction(... default => $this->create(name, inchi, inchi_key, smiles,
 * molecular_formula, cas_number, iupac_name, pubchem_cid, isCorrosive,
 * isSeriousHealthHazard, isExplosive, isFlammable, isGasUnderPressure,
 * isHazardous2env, isHazardous2health, isOxidising, isToxic))`.
 */
const COMPOUND_POST_ACCEPTED_FIELDS = new Set<string>([
  'name',
  'inchi',
  'inchi_key',
  'smiles',
  'molecular_formula',
  'cas_number',
  'iupac_name',
  'pubchem_cid',
  'is_corrosive',
  'is_serious_health_hazard',
  'is_explosive',
  'is_flammable',
  'is_gas_under_pressure',
  'is_hazardous2env',
  'is_hazardous2health',
  'is_oxidising',
  'is_toxic',
]);

/**
 * Convert an {@link ElabCompoundPatch} to the wire shape. Boolean hazard
 * flags become elabftw's checkbox-style `"on"` / `""` strings — the PATCH
 * dispatcher routes hazard columns through `Filter::onToBinary`, which
 * returns 1 *only* when the value is the literal string `"on"`, otherwise
 * 0. Sending `1` / `0` silently writes 0 to the column. POST accepts the
 * same encoding (the `Compounds::postAction` create path uses PHP's
 * `(bool)` cast, and `(bool) "on"` is true), so one helper works for both
 * verbs. Undefined fields are omitted so they don't accidentally clear
 * existing values on PATCH.
 *
 * Source of truth: `CompoundParams` (`is_*` columns) and
 * `Filter::onToBinary`.
 */
function serializeCompoundPatch(
  patch: ElabCompoundPatch
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key.startsWith('is_') && typeof value === 'boolean') {
      out[key] = value ? 'on' : '';
    } else {
      out[key] = value;
    }
  }
  return out;
}
