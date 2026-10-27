import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ElabCompoundPatch,
  ElabEntityNative,
  ElabEntityType,
  ElabEntityUpdate,
  ElabExtraFieldType,
  ElabExtraFieldValue,
  ElabMetadata,
} from '../../client';
import {
  COMPOUND_HAZARD_FLAGS,
  EXTRA_FIELD_TYPES,
  decodeStoredMarkdown,
  formatCompound,
  looksLikeHtml,
  markdownToHtml,
  nativeToUpdate,
} from '../../client';
import { z } from 'zod';
import type { ClientRegistry } from '../clients';
import { ElabftwApiError } from '../../client';
import type { ElabMcpConfig } from '../config';
import {
  entityTypeSchema,
  errorText,
  guard,
  text,
  withEntityLock,
} from './helpers';
import {
  assertCompoundTeam,
  assertCurrentTeam,
  assertTeam,
  clientFor,
  effectiveTeam,
  entityScope,
  teamParamSchema,
} from './team-guard';
import {
  blankExtraFieldValues,
  buildExtraFieldEntry,
  cleanupMetadata,
  coerceCheckboxValue,
  mergeExtraFieldEntry,
  mergeMetadataForClone,
} from './extra-fields';

const stateMap = { normal: 1, archived: 2 } as const;
type StateName = keyof typeof stateMap;

/**
 * Deep-equal for parsed JSON. Used for `canread` / `canwrite`: elabftw
 * normalizes whitespace and may reorder keys, so byte-for-byte string
 * comparison would falsely flag a mismatch on every round-trip.
 */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== (b as unknown[]).length) return false;
    return a.every((v, i) => deepEqualJson(v, (b as unknown[])[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.length !== bk.length) return false;
  if (!ak.every((k, i) => k === bk[i])) return false;
  return ak.every((k) => deepEqualJson(ao[k], bo[k]));
}

/** Parse elabftw's pipe-separated tag string into a set. */
function tagSet(tags: unknown): Set<string> {
  return new Set(
    (typeof tags === 'string' ? tags : '')
      .split('|')
      .map((t) => t.trim())
      .filter(Boolean)
  );
}

function fieldMismatch(
  key: string,
  requested: unknown,
  current: unknown
): boolean {
  if (key === 'canread' || key === 'canwrite') {
    try {
      return !deepEqualJson(
        JSON.parse(String(requested)),
        JSON.parse(String(current ?? '{}'))
      );
    } catch {
      return String(requested) !== String(current);
    }
  }
  if (key === 'body') {
    // elabftw sanitizes bodies on save (HTML purifier, entity-escaping of
    // markdown), so the stored body rarely equals the request byte-for-byte.
    // Only treat the body as dropped when nothing landed. An empty request
    // never re-PATCHes: elabftw may wrap "" in markup and clobbering it is
    // not worth it.
    if (typeof requested !== 'string' || requested.length === 0) return false;
    return String(current ?? '').trim().length === 0;
  }
  if (current == null) return requested != null;
  return current !== requested;
}

type BodyFormat = 'markdown' | 'html';
type EditorMode = 'html' | 'markdown';

/**
 * Turn the caller's `body` into what elabftw should store. The default is
 * the rich-text editor: markdown input is rendered to HTML and stored with
 * `content_type=1`, so users can keep editing the entry in TinyMCE.
 * `content_type: 'markdown'` opts into storing raw markdown, which forces
 * elabftw's markdown editor.
 */
function prepareBody(
  body: string,
  bodyFormat: BodyFormat | undefined,
  editor: EditorMode | undefined
): { body: string; content_type: 1 | 2 } {
  if (editor === 'markdown') return { body, content_type: 2 };
  const format = bodyFormat ?? (looksLikeHtml(body) ? 'html' : 'markdown');
  return {
    body: format === 'markdown' ? markdownToHtml(body) : body,
    content_type: 1,
  };
}

/**
 * Render an entity's stored markdown body to HTML. Covers entries still in
 * markdown mode (`content_type=2`) and entries a user flipped to the
 * rich-text editor in the UI, which leaves the raw markdown behind under
 * `content_type=1`. Returns null when there is nothing to convert.
 */
function storedBodyAsHtml(entity: {
  body?: string | null;
  content_type?: number;
}): string | null {
  const body = entity.body ?? '';
  if (entity.content_type !== 2 && (body.trim() === '' || looksLikeHtml(body)))
    return null;
  return markdownToHtml(decodeStoredMarkdown(body));
}

const bodySchema = z
  .string()
  .optional()
  .describe(
    'Body in markdown (headings, lists, tables, links) or HTML; stored as rich text for the elabftw editor.'
  );
const bodyFormatSchema = z
  .enum(['markdown', 'html'])
  .optional()
  .describe(
    'Syntax of `body`; auto-detected when omitted.'
  );
const contentTypeSchema = z
  .enum(['html', 'markdown'])
  .optional()
  .describe(
    'Editor: `html` (rich text, default). Markdown bodies are converted automatically; pass `markdown` only if the user wants the markdown editor.'
  );

export function registerWriteTools(
  server: McpServer,
  registry: ClientRegistry,
  config: ElabMcpConfig
): void {
  if (!config.allowWrites) return;

  server.tool(
    'elab_create_entity',
    'Create an entity. For experiments / items, `template` instantiates an experiment template / resource template (`items_types`) like the elabftw UI does: body, extra-fields schema, steps, links, tags, permissions, category. Everything else you pass is applied on top; `metadata` is merged into the template\'s, yours winning. The response names any field that could not be applied.',
    {
      entityType: entityTypeSchema,
      team: teamParamSchema,
      template: z
        .number()
        .int()
        .optional()
        .describe(
          'Experiment template id (experiments) or `items_types` id (items).'
        ),
      category: z
        .number()
        .int()
        .optional()
        .describe(
          'Category id: experiment category for experiments, resource category for items. Overrides the template\'s category.'
        ),
      category_id: z
        .number()
        .int()
        .optional()
        .describe('Deprecated alias of `template`.'),
      title: z.string().optional(),
      body: bodySchema,
      body_format: bodyFormatSchema,
      content_type: contentTypeSchema,
      tags: z.array(z.string()).optional(),
      metadata: z
        .string()
        .optional()
        .describe('JSON object string for the metadata blob (extra_fields etc.).'),
      date: z.string().optional().describe('YYYYMMDD, e.g. "20260417".'),
      rating: z.number().int().min(0).max(5).optional(),
      status: z.number().int().optional().describe('Status id (team-scoped).'),
      custom_id: z.number().int().optional(),
      canread: z
        .string()
        .optional()
        .describe(
          'JSON permissions string, e.g. `{"base":40,"teams":[],"users":[],"teamgroups":[]}`.'
        ),
      canwrite: z.string().optional().describe('Same shape as `canread`.'),
      state: z
        .enum(['normal', 'archived'])
        .optional()
        .describe('`archived` archives (and locks) the entry right after creation.'),
    },
    async (args) => {
      const input = args as {
        entityType: ElabEntityType;
        team?: number;
        template?: number;
        category?: number;
        category_id?: number;
        title?: string;
        body?: string;
        body_format?: BodyFormat;
        content_type?: EditorMode;
        tags?: string[];
        metadata?: string;
        date?: string;
        rating?: number;
        status?: number;
        custom_id?: number;
        canread?: string;
        canwrite?: string;
        state?: StateName;
      };
      const t = effectiveTeam(registry, input.team);
      const client = clientFor(registry, input.team);
      const isSchemaKind =
        input.entityType === 'experiments_templates' ||
        input.entityType === 'items_types';
      const templateId = isSchemaKind
        ? undefined
        : (input.template ?? input.category_id);

      let callerMeta: ElabMetadata | undefined;
      if (input.metadata !== undefined) {
        try {
          const parsed: unknown = JSON.parse(input.metadata);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('not an object');
          callerMeta = parsed as ElabMetadata;
        } catch {
          return errorText('`metadata` must be a JSON object string.');
        }
      }

      const prepared =
        input.body !== undefined
          ? prepareBody(input.body, input.body_format, input.content_type)
          : undefined;
      const ct =
        prepared?.content_type ??
        (input.content_type === 'markdown'
          ? 2
          : input.content_type === 'html'
            ? 1
            : undefined);
      const requestedFields: Partial<ElabEntityUpdate> = {
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(ct ? { content_type: ct } : {}),
        ...(input.date !== undefined ? { date: input.date } : {}),
        ...(input.rating !== undefined ? { rating: input.rating } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.custom_id !== undefined ? { custom_id: input.custom_id } : {}),
        ...(input.canread !== undefined ? { canread: input.canread } : {}),
        ...(input.canwrite !== undefined ? { canwrite: input.canwrite } : {}),
        ...(prepared ? { body: prepared.body } : {}),
      };

      return guard(
        async () => {
          // From a template, elabftw applies only `title` (and, on 6.x,
          // merges `metadata`); everything else lands via the PATCH below.
          const id = await client.create(
            input.entityType,
            templateId !== undefined
              ? { template: templateId, title: input.title, metadata: input.metadata }
              : {
                  title: input.title,
                  ...requestedFields,
                  metadata: input.metadata,
                  tags: input.tags,
                }
          );
          if (id == null) return { id, landedTeam: undefined, failed: [] as string[] };
          const fresh = await client.get(input.entityType, id);
          if (fresh.team !== undefined && fresh.team !== t)
            return { id, landedTeam: fresh.team, failed: [] as string[] };

          const patch: Partial<ElabEntityUpdate> = {};
          for (const [key, val] of Object.entries(requestedFields)) {
            const current = (fresh as Record<string, unknown>)[key];
            if (templateId !== undefined || isSchemaKind || fieldMismatch(key, val, current))
              (patch as Record<string, unknown>)[key] = val;
          }
          if (callerMeta) {
            // Server-side merge is 6.x only, and 5.x double-encodes string
            // metadata on create: merge onto what landed and re-send if needed.
            const landed = client.parseMetadata(fresh) ?? {};
            const want =
              templateId !== undefined
                ? mergeMetadataForClone(landed, callerMeta)
                : callerMeta;
            if (isSchemaKind || !deepEqualJson(want, landed))
              patch.metadata = JSON.stringify(want);
          }

          const failed: string[] = [];
          if (Object.keys(patch).length > 0) {
            try {
              await client.update(input.entityType, id, patch);
            } catch {
              failed.push(...Object.keys(patch));
            }
          }
          if (input.tags?.length) {
            const have = tagSet(fresh.tags);
            for (const tag of input.tags.map((x) => x.trim())) {
              if (!tag || have.has(tag)) continue;
              try {
                await client.addEntityTag(input.entityType, id, tag);
              } catch {
                if (!failed.includes('tags')) failed.push('tags');
              }
            }
          }
          // Last: an archived entity rejects every further update.
          if (input.state === 'archived') {
            try {
              await client.action(input.entityType, id, 'archive');
            } catch {
              failed.push('state');
            }
          }
          return { id, landedTeam: fresh.team, failed };
        },
        ({ id, landedTeam, failed }) => {
          if (id == null) {
            return errorText(
              'Create succeeded but elabftw returned no Location header.'
            );
          }
          if (landedTeam !== undefined && landedTeam !== t) {
            return errorText(
              `Created ${input.entityType} #${id}, but it landed in team ${landedTeam}, not the requested team ${t}. ` +
                'Switch your current team in the elabftw UI (for the key that owns this session) and try again, or soft-delete this entry manually.'
            );
          }
          const from =
            templateId !== undefined
              ? ` from ${input.entityType === 'items' ? 'items_type' : 'template'} #${templateId}`
              : '';
          const note = failed.length
            ? ` Could not apply ${failed.join(', ')}; retry with elab_update_entity / elab_add_tag.`
            : '';
          return text(
            `Created ${input.entityType.slice(0, -1)} #${id}${from} in team ${t}.${note}`
          );
        }
      );
    }
  );

  server.tool(
    'elab_update_entity',
    'Update fields on an entity; fields not provided stay unchanged. `metadata` replaces the whole blob (for one field use `elab_set_extra_field` / `elab_update_extra_field`). ' +
      'Round-trip: pass `native` (the shape from `elab_get(view: "native")`) to write every field present in it, including `tags` (made to match exactly) and permission fields; explicit args win over `native`. Links inside `native` are ignored (use `elab_link_entities`).',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
      title: z.string().optional(),
      body: bodySchema,
      body_format: bodyFormatSchema,
      content_type: contentTypeSchema.describe(
        'Editor; omit to keep the current one. `html` without `body` converts the stored markdown body. `markdown` only if the user wants the markdown editor.'
      ),
      date: z.string().optional().describe('YYYYMMDD format.'),
      rating: z.number().int().min(0).max(5).optional(),
      category: z.number().int().optional(),
      status: z.number().int().optional(),
      custom_id: z.number().int().optional(),
      canread: z.string().optional(),
      canwrite: z.string().optional(),
      metadata: z
        .string()
        .optional()
        .describe('Full JSON string to replace the metadata blob.'),
      state: z
        .enum(['normal', 'archived'])
        .optional()
        .describe(
          '`archived` archives and locks; `normal` un-archives (stays locked). Archived entries reject other edits.'
        ),
      native: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          'Entity in the `elab_get(view: "native")` shape; only fields present are written.'
        ),
    },
    async (args) => {
      const input = args as Record<string, unknown> & {
        entityType: ElabEntityType;
        id: number;
        team?: number;
        body?: string;
        body_format?: BodyFormat;
        content_type?: EditorMode;
        state?: StateName;
        native?: Partial<ElabEntityNative>;
      };
      const {
        entityType,
        id,
        body,
        body_format,
        content_type,
        state,
        team,
        native,
        ...rest
      } = input;
      const ct =
        content_type === 'markdown'
          ? 2
          : content_type === 'html'
            ? 1
            : undefined;
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      const fromNative = native ? nativeToUpdate(native) : { patch: {} };
      const patch: ElabEntityUpdate = {
        ...fromNative.patch,
        ...rest,
        ...(body !== undefined ? { body } : {}),
        ...(ct ? { content_type: ct } : {}),
      };
      const nativeState =
        fromNative.state === 1 || fromNative.state === 2 ? fromNative.state : undefined;
      const wantState = state ? stateMap[state] : nativeState;
      const wantTags = fromNative.tags;
      if (
        Object.keys(patch).length === 0 &&
        wantState === undefined &&
        wantTags === undefined
      ) {
        return errorText(
          'No fields provided. Pass at least one updatable field or a `native` patch.'
        );
      }
      return guard(
        async () => {
          const entity = await assertTeam(client, entityType, id, t);
          const notes: string[] = [];
          if (body !== undefined) {
            // Without an explicit `content_type`, keep the editor the entry
            // already uses: users who keep an entry in markdown mode chose so.
            const editor: EditorMode =
              content_type ??
              ((patch.content_type ?? entity.content_type) === 2
                ? 'markdown'
                : 'html');
            const prepared = prepareBody(body, body_format, editor);
            patch.body = prepared.body;
            patch.content_type = prepared.content_type;
          } else if (patch.content_type === 1 && patch.body === undefined) {
            // Switching to the rich-text editor without a new body: render the
            // stored markdown, otherwise TinyMCE shows it as one flat paragraph.
            const html = storedBodyAsHtml(entity);
            if (html !== null) {
              patch.body = html;
              notes.push('Converted the markdown body to rich text.');
            }
          }

          const archived = entity.state === stateMap.archived;
          const hasEdits =
            Object.keys(patch).length > 0 || wantTags !== undefined;
          if (archived && hasEdits && wantState !== stateMap.normal) {
            throw new Error(
              'The entity is archived and eLabFTW rejects edits on archived entries. Pass `state: "normal"` to un-archive it first.'
            );
          }
          if (archived && wantState === stateMap.normal) {
            await client.action(entityType, id, 'unarchive');
            notes.push('Un-archived (still locked; use elab_unlock to edit).');
          }
          if (Object.keys(patch).length > 0)
            await client.update(entityType, id, patch);
          if (wantTags !== undefined) {
            const want = new Set(wantTags.map((x) => x.trim()).filter(Boolean));
            const have = await client.listEntityTags(entityType, id);
            for (const tag of have)
              if (!want.has(tag.tag))
                await client.deleteEntityTag(entityType, id, tag.id);
            const haveNames = new Set(have.map((x) => x.tag));
            for (const tag of want)
              if (!haveNames.has(tag)) await client.addEntityTag(entityType, id, tag);
          }
          if (!archived && wantState === stateMap.archived) {
            await client.action(entityType, id, 'archive');
            notes.push('Archived (and locked).');
          }
          return notes;
        },
        (notes) =>
          text(
            [`Updated ${entityType.slice(0, -1)} #${id}.`, ...notes].join(' ')
          )
      );
    }
  );

  server.tool(
    'elab_convert_body_to_html',
    'Convert a markdown body to rich-text HTML so the entry opens formatted in the elabftw editor. Fixes entries stored as markdown and entries switched to the rich-text editor that show raw markdown. No-op on HTML bodies.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, team } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
      };
      return guard(
        async () => {
          const { client, entity } = await entityScope(registry, team, entityType, id);
          const html = storedBodyAsHtml(entity);
          if (html === null) return false;
          await client.update(entityType, id, { body: html, content_type: 1 });
          return true;
        },
        (converted) =>
          text(
            converted
              ? `Converted ${entityType.slice(0, -1)} #${id} to rich text.`
              : `${entityType.slice(0, -1)} #${id} already has an HTML body; nothing to convert.`
          )
      );
    }
  );

  server.tool(
    'elab_update_extra_field',
    'Set the value of an extra field that already exists on an entity (fast path, safe to call in parallel). To create a field or change its type / options / unit, use `elab_set_extra_field`.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
      fieldName: z.string().min(1),
      value: z
        .union([z.string(), z.number(), z.boolean(), z.null()])
        .describe('New value. Checkbox: true/false. null clears the field.'),
    },
    async (args) => {
      const { entityType, id, team, fieldName, value } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
        fieldName: string;
        value: string | number | boolean | null;
      };
      return guard(
        async () => {
          const { client, entity } = await entityScope(registry, team, entityType, id);
          const field = client.parseMetadata(entity)?.extra_fields?.[fieldName];
          if (!field) {
            return {
              ok: false as const,
              reason:
                `Extra field \`${fieldName}\` does not exist on ${entityType.slice(0, -1)} #${id}. ` +
                'This tool only updates the value of a field that is already defined. ' +
                'Use `elab_set_extra_field` to create the field first (it accepts `type`, `options`, `unit`, etc.).',
            };
          }
          // elabftw only takes strings / ints here and expects checkboxes
          // as 'on' / ''.
          const wire =
            field.type === 'checkbox'
              ? coerceCheckboxValue(value)
              : value === null
                ? ''
                : typeof value === 'string'
                  ? value
                  : String(value);
          await client.updateExtraField(entityType, id, fieldName, wire);
          return { ok: true as const };
        },
        (result) =>
          result.ok
            ? text(
                `Updated extra field \`${fieldName}\` on ${entityType.slice(0, -1)} #${id}.`
              )
            : errorText(result.reason)
      );
    }
  );

  server.tool(
    'elab_set_extra_field',
    'Create or replace one extra field (definition and value) on an entity. Types: text, number, checkbox, date, datetime-local, time, email, url, select (UI: dropdown), radio, experiments, items, users, compounds, uploads. select / radio need `options` and a value among them; number takes a numeric value and optional `units`; experiments / items / users / compounds take an id, and experiments / items / compounds are also linked unless `autoLink: false`. `mode: \"merge\"` changes only the properties you pass. To change only the value of an existing field, use `elab_update_extra_field`.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
      name: z.string().min(1).describe('Field key (used verbatim in the metadata blob).'),
      type: z
        .enum(EXTRA_FIELD_TYPES)
        .describe('Field type.'),
      value: z
        .union([
          z.string(),
          z.number(),
          z.boolean(),
          z.array(z.string()),
          z.null(),
        ])
        .optional()
        .describe(
          'Value: an id for experiments / items / users / compounds, string[] for multi-select, true / false for checkbox.'
        ),
      options: z
        .array(z.string())
        .optional()
        .describe('Choices for `select` / `radio`. Required for those two types.'),
      unit: z.string().optional().describe('Selected unit for `number`. Defaults to `units[0]` if omitted.'),
      units: z.array(z.string()).optional().describe('Available units for `number` (UI shows them as a picker).'),
      description: z.string().optional(),
      required: z.boolean().optional(),
      readonly: z.boolean().optional(),
      blank_value_on_duplicate: z
        .boolean()
        .optional()
        .describe('When true, duplicating this entity blanks the field\u2019s value on the copy.'),
      allow_multi_values: z
        .boolean()
        .optional()
        .describe('For `select` only \u2014 enables multi-select.'),
      group_id: z
        .number()
        .int()
        .optional()
        .describe('Group id (see `elab_set_extra_field_groups`); omit for the default group.'),
      position: z
        .number()
        .int()
        .optional()
        .describe('Sort order within its group.'),
      mode: z
        .enum(['replace', 'merge'])
        .optional()
        .describe(
          '`replace` (default) or `merge` (keep properties not passed).'
        ),
      autoLink: z
        .boolean()
        .optional()
        .describe(
          'Default true: also link the referenced experiment / item / compound.'
        ),
    },
    async (args) => {
      const input = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
        name: string;
        type: ElabExtraFieldType;
        value?: string | number | boolean | string[] | null;
        options?: string[];
        unit?: string;
        units?: string[];
        description?: string;
        required?: boolean;
        readonly?: boolean;
        blank_value_on_duplicate?: boolean;
        allow_multi_values?: boolean;
        group_id?: number;
        position?: number;
        mode?: 'replace' | 'merge';
        autoLink?: boolean;
      };
      const t = effectiveTeam(registry, input.team);
      const client = clientFor(registry, input.team);
      const mode = input.mode ?? 'replace';
      const autoLink = input.autoLink !== false; // default true
      return guard(
        () => withEntityLock(`${t}/${input.entityType}/${input.id}`, async () => {
          const entity = await assertTeam(client, input.entityType, input.id, t);
          const metadata: ElabMetadata = client.parseMetadata(entity) ?? {};
          const extraFields = (metadata.extra_fields =
            metadata.extra_fields ?? {});

          const existing = extraFields[input.name];
          const newEntry = buildExtraFieldEntry(
            {
              type: input.type,
              value: input.value,
              options: input.options,
              unit: input.unit,
              units: input.units,
              description: input.description,
              required: input.required,
              readonly: input.readonly,
              blank_value_on_duplicate: input.blank_value_on_duplicate,
              allow_multi_values: input.allow_multi_values,
              group_id: input.group_id,
              position: input.position,
            },
            { partial: mode === 'merge' && existing !== undefined, existing }
          );

          extraFields[input.name] =
            mode === 'merge' && existing
              ? mergeExtraFieldEntry(existing, newEntry)
              : newEntry;

          await client.update(input.entityType, input.id, {
            metadata: JSON.stringify(metadata),
          });

          // Auto-link side effect for entity-link types (NOT users \u2014 there
          // is no `/users_links` sub-resource at the entity level in elabftw).
          let linked = false;
          if (
            autoLink &&
            (input.type === 'experiments' ||
              input.type === 'items' ||
              input.type === 'compounds')
          ) {
            const linkedId =
              typeof input.value === 'number'
                ? input.value
                : typeof input.value === 'string'
                  ? Number(input.value)
                  : NaN;
            if (Number.isInteger(linkedId) && linkedId > 0) {
              // elabftw ignores duplicate links, so re-linking is harmless.
              await client.addLink(input.entityType, input.id, input.type, linkedId);
              linked = true;
            }
          }
          return { name: input.name, type: input.type, value: input.value, linked };
        }),
        ({ name, type, value, linked }) => {
          const label = input.entityType.slice(0, -1);
          const linkNote =
            linked && value !== undefined && value !== null
              ? ` Auto-linked ${type} #${typeof value === 'string' ? Number(value) : value}.`
              : '';
          return text(
            `Set extra field \`${name}\` (type=${type}) on ${label} #${input.id}.${linkNote}`
          );
        }
      );
    }
  );

  server.tool(
    'elab_remove_extra_field',
    'Remove an extra field from an entity (empty groups are cleaned up). For experiments / items / compounds fields the matching link is removed too unless `alsoUnlink: false`.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
      name: z.string().min(1),
      alsoUnlink: z
        .boolean()
        .optional()
        .describe(
          'Default `true`: for `experiments` / `items` / `compounds` fields, also remove the matching entity link.'
        ),
    },
    async (args) => {
      const { entityType, id, team, name, alsoUnlink } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
        name: string;
        alsoUnlink?: boolean;
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      const doUnlink = alsoUnlink !== false; // default true
      return guard(
        () => withEntityLock(`${t}/${entityType}/${id}`, async () => {
          const entity = await assertTeam(client, entityType, id, t);
          const metadata: ElabMetadata = client.parseMetadata(entity) ?? {};
          const existing = metadata.extra_fields?.[name];
          if (!existing) {
            return {
              removed: false as const,
              reason: `Extra field \`${name}\` is not present on ${entityType.slice(0, -1)} #${id}.`,
            };
          }
          const removedType = existing.type;
          const removedValue = existing.value;
          if (metadata.extra_fields) {
            delete metadata.extra_fields[name];
          }
          cleanupMetadata(metadata);
          await client.update(entityType, id, { metadata: JSON.stringify(metadata) });

          // Optional entity-link cleanup.
          let unlinked = false;
          if (
            doUnlink &&
            (removedType === 'experiments' ||
              removedType === 'items' ||
              removedType === 'compounds')
          ) {
            const linkedId =
              typeof removedValue === 'number'
                ? removedValue
                : typeof removedValue === 'string'
                  ? Number(removedValue)
                  : NaN;
            if (Number.isInteger(linkedId) && linkedId > 0) {
              try {
                await client.deleteLink(entityType, id, removedType, linkedId);
                unlinked = true;
              } catch (e) {
                // The linked entity may be gone already.
                if (!(e instanceof ElabftwApiError && e.statusCode === 404)) throw e;
              }
            }
          }
          return { removed: true as const, type: removedType, unlinked, linkedId: removedValue };
        }),
        (result) => {
          if (!result.removed) return errorText(result.reason);
          const label = entityType.slice(0, -1);
          const linkNote = result.unlinked
            ? ` Unlinked ${result.type} #${typeof result.linkedId === 'string' ? Number(result.linkedId) : result.linkedId}.`
            : '';
          return text(
            `Removed extra field \`${name}\` from ${label} #${id}.${linkNote}`
          );
        }
      );
    }
  );

  server.tool(
    'elab_clone_extra_fields_schema',
    'Copy an `extra_fields` schema (and field groups) from a source entity onto a target. ' +
      'Like the elabftw UI\u2019s "Load fields" button: the source defines each field\u2019s schema (type, options, units, group, \u2026); values the target already has are kept, fields it lacks are added with the source\u2019s values. Field groups are merged by `id`. ' +
      '`blankValues: true` copies the schema without the source\u2019s example values (the target\u2019s own values are still kept).',
    {
      sourceEntityType: entityTypeSchema,
      sourceId: z.number().int().positive(),
      targetEntityType: entityTypeSchema,
      targetId: z.number().int().positive(),
      team: teamParamSchema,
      blankValues: z.boolean().optional(),
    },
    async (args) => {
      const {
        sourceEntityType,
        sourceId,
        targetEntityType,
        targetId,
        team,
        blankValues,
      } = args as {
        sourceEntityType: ElabEntityType;
        sourceId: number;
        targetEntityType: ElabEntityType;
        targetId: number;
        team?: number;
        blankValues?: boolean;
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        () => withEntityLock(`${t}/${targetEntityType}/${targetId}`, async () => {
          const source = await assertTeam(client, sourceEntityType, sourceId, t);
          const target = await assertTeam(client, targetEntityType, targetId, t);
          const sourceMeta: ElabMetadata = client.parseMetadata(source) ?? {};
          const targetMeta: ElabMetadata = client.parseMetadata(target) ?? {};

          if (blankValues) blankExtraFieldValues(sourceMeta);
          const merged = mergeMetadataForClone(sourceMeta, targetMeta, {
            keep: 'value',
          });
          const fieldCount = merged.extra_fields
            ? Object.keys(merged.extra_fields).length
            : 0;
          await client.update(targetEntityType, targetId, {
            metadata: JSON.stringify(merged),
          });
          return { fieldCount };
        }),
        ({ fieldCount }) => {
          const label = targetEntityType.slice(0, -1);
          const blankNote = blankValues ? ' (values blanked)' : '';
          return text(
            `Cloned ${fieldCount}-field schema from ${sourceEntityType.slice(0, -1)} #${sourceId} onto ${label} #${targetId}${blankNote}.`
          );
        }
      );
    }
  );

  server.tool(
    'elab_set_extra_field_groups',
    'Set the named extra-field groups (UI sections) of an entity; fields reference them by `group_id`. `mode`: `replace` (default) or `merge` (upsert by id). Id -1 is reserved.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
      groups: z
        .array(
          z.object({
            id: z
              .number()
              .int()
              .refine((v) => v !== -1, {
                message: 'group id -1 is reserved for the default group.',
              }),
            name: z.string().min(1),
          })
        )
        .min(1),
      mode: z.enum(['replace', 'merge']).optional(),
    },
    async (args) => {
      const { entityType, id, team, groups, mode } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
        groups: Array<{ id: number; name: string }>;
        mode?: 'replace' | 'merge';
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      const effectiveMode = mode ?? 'replace';
      return guard(
        () => withEntityLock(`${t}/${entityType}/${id}`, async () => {
          const entity = await assertTeam(client, entityType, id, t);
          const metadata: ElabMetadata = client.parseMetadata(entity) ?? {};
          metadata.elabftw = metadata.elabftw ?? {};
          if (effectiveMode === 'replace') {
            metadata.elabftw.extra_fields_groups = groups;
          } else {
            const existing = metadata.elabftw.extra_fields_groups ?? [];
            const byId = new Map<number, { id: number; name: string }>();
            for (const g of existing) byId.set(g.id, g);
            for (const g of groups) byId.set(g.id, g);
            metadata.elabftw.extra_fields_groups = [...byId.values()];
          }
          await client.update(entityType, id, {
            metadata: JSON.stringify(metadata),
          });
          return metadata.elabftw.extra_fields_groups.length;
        }),
        (count) => {
          const label = entityType.slice(0, -1);
          return text(
            `Set ${count} extra-field group(s) on ${label} #${id} (mode=${effectiveMode}).`
          );
        }
      );
    }
  );

  server.tool(
    'elab_duplicate_entity',
    'Duplicate an entity, optionally copying its files and linking the copy back to the original. The copy lands in the team the API key is currently in.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
      copyFiles: z.boolean().optional(),
      linkToOriginal: z.boolean().optional(),
    },
    async (args) => {
      const { entityType, id, team, copyFiles, linkToOriginal } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
        copyFiles?: boolean;
        linkToOriginal?: boolean;
      };
      return guard(
        async () => {
          const { t, client } = await entityScope(registry, team, entityType, id);
          const newId = await client.duplicate(entityType, id, {
            copyFiles,
            linkToOriginal,
          });
          const landedTeam =
            newId == null ? undefined : (await client.get(entityType, newId)).team;
          return { newId, landedTeam, t };
        },
        ({ newId, landedTeam, t }) => {
          if (newId == null)
            return errorText('Duplicated but elabftw returned no new id.');
          const where =
            landedTeam !== undefined && landedTeam !== t
              ? ` Note: the copy landed in team ${landedTeam}, not ${t}.`
              : '';
          return text(
            `Duplicated ${entityType.slice(0, -1)} #${id} → #${newId}.${where}`
          );
        }
      );
    }
  );

  server.tool(
    'elab_add_comment',
    'Add a comment to an entity.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
      comment: z.string().min(1),
    },
    async (args) => {
      const { entityType, id, team, comment } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
        comment: string;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          return client.addComment(entityType, id, comment);
        },
        (cid) =>
          text(
            cid == null
              ? `Added comment on ${entityType.slice(0, -1)} #${id}.`
              : `Added comment #${cid} on ${entityType.slice(0, -1)} #${id}.`
          )
      );
    }
  );

  server.tool(
    'elab_add_step',
    'Add a checklist step to an entity.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
      body: z.string().min(1),
      deadline: z.string().optional().describe('ISO datetime, optional.'),
      deadline_notif: z
        .boolean()
        .optional()
        .describe(
          'Email the step owner before the deadline. Default false.'
        ),
    },
    async (args) => {
      const { entityType, id, team, body, deadline, deadline_notif } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
        body: string;
        deadline?: string;
        deadline_notif?: boolean;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          return client.addStep(entityType, id, body, {
            deadline,
            deadline_notif,
          });
        },
        (sid) =>
          text(
            sid == null
              ? `Added step on ${entityType.slice(0, -1)} #${id}.`
              : `Added step #${sid} on ${entityType.slice(0, -1)} #${id}.`
          )
      );
    }
  );

  server.tool(
    'elab_update_comment',
    'Edit an existing comment on an entity. Use `elab_list_comments` to find the `commentId`.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      commentId: z.number().int().positive(),
      team: teamParamSchema,
      comment: z.string().min(1),
    },
    async (args) => {
      const { entityType, id, commentId, team, comment } = args as {
        entityType: ElabEntityType;
        id: number;
        commentId: number;
        team?: number;
        comment: string;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          return client.updateComment(entityType, id, commentId, comment);
        },
        () =>
          text(
            `Updated comment #${commentId} on ${entityType.slice(0, -1)} #${id}.`
          )
      );
    }
  );

  server.tool(
    'elab_delete_step',
    'Permanently delete a checklist step from an entity. Unlike entity deletion, this is not a soft-delete — the step row is removed. Use `elab_list_steps` to find the `stepId`.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      stepId: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, stepId, team } = args as {
        entityType: ElabEntityType;
        id: number;
        stepId: number;
        team?: number;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          await client.deleteStep(entityType, id, stepId);
          return null;
        },
        () =>
          text(
            `Deleted step #${stepId} from ${entityType.slice(0, -1)} #${id}.`
          )
      );
    }
  );

  server.tool(
    'elab_update_step',
    'Edit a checklist step: `body`, `deadline` (`YYYY-MM-DD HH:MM:SS`; null clears) and / or `deadline_notif` (needs a deadline). Omitted fields stay unchanged. Mark it done with `elab_toggle_step`.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      stepId: z.number().int().positive(),
      body: z.string().min(1).optional(),
      deadline: z
        .string()
        .nullable()
        .optional()
        .describe(
          '`YYYY-MM-DD HH:MM:SS` to set; `null` to clear. Omit to leave untouched.'
        ),
      deadline_notif: z
        .boolean()
        .optional()
        .describe('Toggle the deadline-notification flag.'),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, stepId, body, deadline, deadline_notif, team } =
        args as {
          entityType: ElabEntityType;
          id: number;
          stepId: number;
          body?: string;
          deadline?: string | null;
          deadline_notif?: boolean;
          team?: number;
        };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      const patch = {
        ...(body !== undefined ? { body } : {}),
        ...(deadline !== undefined ? { deadline } : {}),
        ...(deadline_notif !== undefined ? { deadline_notif } : {}),
      };
      if (Object.keys(patch).length === 0) {
        return errorText(
          'No fields provided. Pass at least one of `body`, `deadline`, `deadline_notif`.'
        );
      }
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          return client.updateStep(entityType, id, stepId, patch);
        },
        () => {
          const changes: string[] = [];
          if (body !== undefined) changes.push('body');
          if (deadline !== undefined)
            changes.push(deadline === null ? 'deadline cleared' : 'deadline');
          if (deadline_notif !== undefined)
            changes.push(`deadline_notif=${deadline_notif}`);
          return text(
            `Updated step #${stepId} on ${entityType.slice(0, -1)} #${id} (${changes.join(', ')}).`
          );
        }
      );
    }
  );

  server.tool(
    'elab_toggle_step',
    'Mark a checklist step finished (`finished: true`) or unfinished. Idempotent, and keeps the step\'s deadline.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      stepId: z.number().int().positive(),
      finished: z.boolean(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, stepId, finished, team } = args as {
        entityType: ElabEntityType;
        id: number;
        stepId: number;
        finished: boolean;
        team?: number;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          return client.toggleStep(entityType, id, stepId, finished);
        },
        () =>
          text(
            `Step #${stepId} on ${entityType.slice(0, -1)} #${id} marked ${finished ? 'finished' : 'unfinished'}.`
          )
      );
    }
  );

  const linkTargetSchema = z
    .enum(['experiments', 'items', 'compounds'])
    .describe('Kind of the target; `targetId` is an experiment, item or compound id.');

  server.tool(
    'elab_link_entities',
    'Link an entity (`entityType` + `id`) to an experiment, item or compound (`targetKind` + `targetId`) in the same team. Linking twice is harmless.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      targetKind: linkTargetSchema,
      targetId: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, targetKind, targetId, team } = args as {
        entityType: ElabEntityType;
        id: number;
        targetKind: 'experiments' | 'items' | 'compounds';
        targetId: number;
        team?: number;
      };
      return guard(
        async () => {
          const { t, client } = await entityScope(registry, team, entityType, id);
          if (targetKind === 'compounds') {
            await assertCompoundTeam(client, targetId, t);
            await client.addCompoundLink(entityType, id, targetId);
          } else {
            await assertTeam(client, targetKind, targetId, t);
            await client.addLink(entityType, id, targetKind, targetId);
          }
        },
        () =>
          text(
            `Linked ${entityType.slice(0, -1)} #${id} → ${targetKind.slice(0, -1)} #${targetId}.`
          )
      );
    }
  );

  server.tool(
    'elab_unlink_entities',
    'Remove a link from an entity to an experiment, item or compound.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      targetKind: linkTargetSchema,
      targetId: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, targetKind, targetId, team } = args as {
        entityType: ElabEntityType;
        id: number;
        targetKind: 'experiments' | 'items' | 'compounds';
        targetId: number;
        team?: number;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          if (targetKind === 'compounds')
            await client.deleteCompoundLink(entityType, id, targetId);
          else await client.deleteLink(entityType, id, targetKind, targetId);
        },
        () =>
          text(
            `Unlinked ${entityType.slice(0, -1)} #${id} from ${targetKind.slice(0, -1)} #${targetId}.`
          )
      );
    }
  );

  server.tool(
    'elab_add_tag',
    'Attach a tag (by name) to an entity. elabftw creates the tag globally if it doesn\u2019t exist.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      tag: z.string().min(1),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, tag, team } = args as {
        entityType: ElabEntityType;
        id: number;
        tag: string;
        team?: number;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          await client.addEntityTag(entityType, id, tag);
          return null;
        },
        () => text(`Tagged ${entityType.slice(0, -1)} #${id} with \`${tag}\`.`)
      );
    }
  );

  server.tool(
    'elab_remove_tag',
    'Detach a tag (by tag id) from an entity. Use `elab_list_tags` or `elab_get` to find the tag id.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      tagId: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, tagId, team } = args as {
        entityType: ElabEntityType;
        id: number;
        tagId: number;
        team?: number;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          await client.deleteEntityTag(entityType, id, tagId);
          return null;
        },
        () =>
          text(`Removed tag #${tagId} from ${entityType.slice(0, -1)} #${id}.`)
      );
    }
  );

  server.tool(
    'elab_create_tag',
    'Create a team-scoped tag without attaching it to any entity. Useful for seeding a tag namespace at team setup or before bulk-tagging a cohort via `elab_add_tag`. If the tag already exists (elabftw uses `INSERT ... ON DUPLICATE KEY UPDATE`), the call is idempotent and returns the existing tag id. Requires team-admin privileges on the API key.',
    {
      tag: z
        .string()
        .min(1)
        .describe('The literal tag string (e.g. "buffer", "cohort-2026").'),
      team: teamParamSchema,
    },
    async (args) => {
      const { tag, team } = args as { tag: string; team?: number };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertCurrentTeam(client, t);
          return client.createTag(tag);
        },
        (tagId) =>
          text(
            tagId !== null
              ? `Created tag #${tagId} \`${tag}\` in team ${t}.`
              : `Created tag \`${tag}\` in team ${t}. (elabftw did not return an id; call \`elab_list_tags\` to resolve.)`
          )
      );
    }
  );

  // Compound CRUD field schemas. Kept as a constant so create / update
  // tools share the same field set, and additions only need to land here.
  // Hazard flags are booleans on the agent side; the client coerces them
  // to 0/1 before sending.
  // Compound fields shared by create / update. Hazards travel as one list
  // of short names instead of 24 booleans to keep the tool schema small.
  const compoundIdentifierFields = {
    molecular_weight: z.number().optional(),
    pubchem_cid: z.number().int().optional(),
    molecular_formula: z.string().optional(),
    inchi: z.string().optional(),
    inchi_key: z.string().optional(),
    smiles: z.string().optional(),
    iupac_name: z.string().optional(),
    cas_number: z.string().optional(),
    ec_number: z.string().optional(),
    chebi_id: z.string().optional(),
    chembl_id: z.string().optional(),
    dea_number: z.string().optional(),
    drugbank_id: z.string().optional(),
    dsstox_id: z.string().optional(),
    hmdb_id: z.string().optional(),
    kegg_id: z.string().optional(),
    metabolomics_wb_id: z.string().optional(),
    nci_code: z.string().optional(),
    nikkaji_number: z.string().optional(),
    pharmgkb_id: z.string().optional(),
    pharos_ligand_id: z.string().optional(),
    rxcui: z.string().optional(),
    unii: z.string().optional(),
    wikidata: z.string().optional(),
    wikipedia: z.string().optional(),
  };
  const hazardNames = COMPOUND_HAZARD_FLAGS.map((f) => f.slice(3)) as [
    string,
    ...string[],
  ];
  const hazardsSchema = z
    .array(z.enum(hazardNames))
    .optional()
    .describe(
      'Hazard flags that apply, e.g. ["toxic","flammable"]. On update it replaces the set; omit to keep it.'
    );
  /** Expand `hazards` into the 24 `is_*` flags elabftw stores. */
  const hazardFlags = (hazards: string[] | undefined): ElabCompoundPatch =>
    hazards === undefined
      ? {}
      : (Object.fromEntries(
          COMPOUND_HAZARD_FLAGS.map((f) => [f, hazards.includes(f.slice(3))])
        ) as ElabCompoundPatch);

  server.tool(
    'elab_create_compound',
    'Create a compound in the team catalog. Only `name` is required; the rest are identifiers, structure descriptors and `hazards`. Prefer `elab_create_compound_from_pubchem` when the compound is in PubChem. Attach it with `elab_link_entities(targetKind: "compounds")`.',
    {
      name: z.string().min(1),
      ...compoundIdentifierFields,
      hazards: hazardsSchema,
      team: teamParamSchema,
    },
    async (args) => {
      const { team, hazards, ...rest } = args as {
        name: string;
        team?: number;
        hazards?: string[];
      } & ElabCompoundPatch;
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        () =>
          client.createCompoundDetailed({ ...rest, ...hazardFlags(hazards) }),
        ({ id, unreconciledFields }) => {
          if (id == null)
            return text(
              `Created compound \`${rest.name}\` in team ${t}, but elabftw returned no id; find it with \`elab_search_compounds\`.`
            );
          const note = unreconciledFields?.length
            ? ` Could not set ${unreconciledFields.join(', ')}; retry with elab_update_compound (do not create it again).`
            : '';
          return text(`Created compound #${id} \`${rest.name}\` in team ${t}.${note}`);
        }
      );
    }
  );

  server.tool(
    'elab_create_compound_from_pubchem',
    'Import a compound from PubChem into the team catalog by `cid` or `cas` (exactly one): name, structure, identifiers, hazards. Check first with `elab_search_pubchem`; attach it with `elab_link_entities(targetKind: \"compounds\")`.',
    {
      cid: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('PubChem CID. Preferred — unambiguous.'),
      cas: z
        .string()
        .optional()
        .describe(
          'CAS registry number (e.g. `58-08-2`). Server resolves CAS → CID via PubChem first.'
        ),
      team: teamParamSchema,
    },
    async (args) => {
      const { cid, cas, team } = args as {
        cid?: number;
        cas?: string;
        team?: number;
      };
      const provided = [cid, cas].filter((v) => v !== undefined).length;
      if (provided !== 1) {
        return errorText(
          'Provide exactly one of `cid` / `cas`. Use `cid` when known; `cas` is the fallback.'
        );
      }
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        () =>
          cid !== undefined
            ? client.createCompoundFromPubchemCid(cid)
            : client.createCompoundFromPubchemCas(cas!),
        (id) => {
          const label =
            cid !== undefined ? `CID=${cid}` : `CAS=${cas}`;
          return text(
            id != null
              ? `Created compound #${id} from PubChem ${label} in team ${t}.`
              : `Created compound from PubChem ${label} in team ${t}. (elabftw did not return an id; call \`elab_search_compounds\` to resolve.)`
          );
        }
      );
    }
  );

  server.tool(
    'elab_update_compound',
    'Update fields on a compound; omitted fields stay unchanged.',
    {
      id: z.number().int().positive(),
      name: z.string().min(1).optional(),
      ...compoundIdentifierFields,
      hazards: hazardsSchema,
      team: teamParamSchema,
    },
    async (args) => {
      const { id, team, hazards, ...rest } = args as {
        id: number;
        team?: number;
        hazards?: string[];
      } & ElabCompoundPatch;
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      const patch: ElabCompoundPatch = { ...rest, ...hazardFlags(hazards) };
      if (Object.keys(patch).length === 0) {
        return errorText(
          'No fields provided. Pass at least one of `name` / identifier / hazard fields.'
        );
      }
      return guard(
        async () => {
          await assertCompoundTeam(client, id, t);
          return client.updateCompound(id, patch);
        },
        (compound) => text(`Updated compound #${id}.\n${formatCompound(compound)}`)
      );
    }
  );

  // ------------------------------------------------------------------------
  // Destructive / audit-affecting actions. Gated by a second env flag.
  // ------------------------------------------------------------------------

  if (!config.allowDestructive) return;

  server.tool(
    'elab_delete_entity',
    'Soft-delete an entity (state=deleted). It stays retrievable with `state: "deleted"` searches and can be restored in the elabftw UI.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, team } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          await client.remove(entityType, id);
          return id;
        },
        () => text(`Soft-deleted ${entityType.slice(0, -1)} #${id}.`)
      );
    }
  );

  server.tool(
    'elab_delete_comment',
    'Permanently delete a comment from an entity. Unlike entity deletion, this is not a soft-delete — the row is removed and the audit-trail entry shows the deletion. Use `elab_list_comments` to find the `commentId`.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      commentId: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, commentId, team } = args as {
        entityType: ElabEntityType;
        id: number;
        commentId: number;
        team?: number;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          await client.deleteComment(entityType, id, commentId);
          return null;
        },
        () =>
          text(
            `Deleted comment #${commentId} from ${entityType.slice(0, -1)} #${id}.`
          )
      );
    }
  );

  server.tool(
    'elab_delete_compound',
    'Soft-delete a compound (sets state=3, consistent with `elab_delete_entity`). The compound is still retrievable with `state=deleted`; permanent deletion is sysadmin-only and not exposed.',
    {
      id: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { id, team } = args as { id: number; team?: number };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertCompoundTeam(client, id, t);
          await client.deleteCompound(id);
          return null;
        },
        () => text(`Soft-deleted compound #${id}.`)
      );
    }
  );

  server.tool(
    'elab_lock',
    'Lock an entity against further edits. Idempotent: an already locked entity stays locked. Undo with `elab_unlock`.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, team } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          // `lock` toggles; `forcelock` sets locked=1.
          return client.action(entityType, id, 'forcelock');
        },
        () => text(`Locked ${entityType.slice(0, -1)} #${id}.`)
      );
    }
  );

  server.tool(
    'elab_unlock',
    'Unlock a locked entity. Allowed for whoever locked it and for admins.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, team } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          return client.action(entityType, id, 'forceunlock');
        },
        () => text(`Unlocked ${entityType.slice(0, -1)} #${id}.`)
      );
    }
  );

  server.tool(
    'elab_timestamp',
    'Attach an RFC 3161 trusted timestamp to an entity. Irreversible and consumes one timestamp from the instance\u2019s ts_balance.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, team } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          return client.action(entityType, id, 'timestamp');
        },
        () => text(`Timestamped ${entityType.slice(0, -1)} #${id}.`)
      );
    }
  );

  server.tool(
    'elab_bloxberg',
    'Anchor an entity onto the Bloxberg blockchain. Irreversible.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, team } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          return client.action(entityType, id, 'bloxberg');
        },
        () => text(`Bloxberg-anchored ${entityType.slice(0, -1)} #${id}.`)
      );
    }
  );

  server.tool(
    'elab_delete_tag',
    'Permanently delete a team-scoped tag. elabftw first detaches the tag from every entity that referenced it, then removes the row. Pair with `elab_list_tags` to resolve the tag id first. Requires team-admin privileges on the API key.',
    {
      tagId: z
        .number()
        .int()
        .positive()
        .describe('The team-scoped tag id, resolved via `elab_list_tags`.'),
      team: teamParamSchema,
    },
    async (args) => {
      const { tagId, team } = args as { tagId: number; team?: number };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertCurrentTeam(client, t);
          await client.deleteTag(tagId);
          return null;
        },
        () => text(`Deleted tag #${tagId} from team ${t}.`)
      );
    }
  );
}
