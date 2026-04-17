import { elabFetch, elabJson, extractLocationId } from './http';
import type {
  ElabComment,
  ElabCreateEntityInput,
  ElabDuplicateOptions,
  ElabEntity,
  ElabEntityAction,
  ElabEntityType,
  ElabEntityUpdate,
  ElabEvent,
  ElabExperimentsTemplate,
  ElabExtraFieldDescriptor,
  ElabInfo,
  ElabItemsType,
  ElabLink,
  ElabListQuery,
  ElabMetadata,
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
   * `PATCH /{entityType}/{id}` with `action:"update"` (the default).
   * elabftw silently drops unknown fields.
   */
  update(
    entityType: ElabEntityType,
    id: number,
    patch: ElabEntityUpdate
  ): Promise<ElabEntity> {
    return elabJson(this.config, `/${entityType}/${id}`, undefined, {
      method: 'PATCH',
      body: { action: 'update', ...patch },
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
          ...(options?.deadline_notif
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
   * Links between entities. elabftw splits these by target kind:
   *   - `/experiments_links` when the target is an experiment
   *   - `/items_links` when the target is an item
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
    targetKind: 'experiments' | 'items',
    targetId: number
  ): Promise<void> {
    const sub = targetKind === 'experiments' ? 'experiments_links' : 'items_links';
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
    targetKind: 'experiments' | 'items',
    targetId: number
  ): Promise<void> {
    const sub = targetKind === 'experiments' ? 'experiments_links' : 'items_links';
    await elabFetch(
      this.config,
      `/${fromType}/${fromId}/${sub}/${targetId}`,
      undefined,
      { method: 'DELETE' }
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
   * `GET /extra_fields_keys` — instance-wide field name autocomplete.
   * (Endpoint was `/extra_fields` in older versions.)
   */
  listExtraFieldNames(): Promise<ElabExtraFieldDescriptor[]> {
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

  /** `GET /unfinished_steps` — open checklist items across accessible entries. */
  listUnfinishedSteps(): Promise<
    Array<{ id: number; entity_id: number; entity_type: string; body: string }>
  > {
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
