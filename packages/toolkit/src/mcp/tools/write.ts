import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ElabCompoundPatch,
  ElabEntityType,
  ElabEntityUpdate,
  ElabExtraFieldType,
  ElabExtraFieldValue,
  ElabMetadata,
} from '../../client';
import { EXTRA_FIELD_TYPES, formatCompound } from '../../client';
import { z } from 'zod';
import type { ClientRegistry } from '../clients';
import type { ElabMcpConfig } from '../config';
import { entityTypeSchema, errorText, guard, text } from './helpers';
import {
  assertTeam,
  clientFor,
  effectiveTeam,
  teamParamSchema,
} from './team-guard';
import {
  blankExtraFieldValues,
  buildExtraFieldEntry,
  cleanupMetadata,
  isMetadataEmpty,
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

/**
 * Normalize "no metadata" — elabftw represents an empty/missing blob as any
 * of `null`, the string `"null"`, the empty string, or `undefined`. Treat
 * them as equivalent to avoid spurious mismatch on round-trip.
 */
function isEmptyMetadata(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '' || trimmed === 'null') return true;
  }
  return false;
}

function parseMetadataLoose(v: unknown): unknown {
  if (isEmptyMetadata(v)) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/**
 * Compare a `tags: string[]` request against the response shape. elabftw
 * returns the entity's tags as a pipe-separated string (e.g.
 * `"alpha|beta|gamma"`) or `null` when there are none. Compare as sets.
 */
function tagsMismatch(requested: string[], current: unknown): boolean {
  const want = new Set(requested.map((t) => t.trim()).filter(Boolean));
  const haveStr =
    typeof current === 'string' ? current : current == null ? '' : String(current);
  const have = new Set(
    haveStr
      .split('|')
      .map((t) => t.trim())
      .filter(Boolean)
  );
  if (want.size !== have.size) return true;
  for (const tag of want) if (!have.has(tag)) return true;
  return false;
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
  if (key === 'metadata') {
    // Treat null / "null" / "" / undefined as equivalent — elabftw
    // normalizes empty metadata to null. Deep-equal parsed JSON otherwise.
    const r = parseMetadataLoose(requested);
    const c = parseMetadataLoose(current);
    if (r === null && c === null) return false;
    if (r === null || c === null) return true;
    return !deepEqualJson(r, c);
  }
  if (key === 'body') {
    // Guard: never re-PATCH body when the caller asked for an empty body.
    // elabftw's HTML pipeline may turn "" into something like a wrapping
    // <div></div>; refusing to clobber it is the safer call.
    if (typeof requested === 'string' && requested.length === 0) return false;
    return String(requested ?? '') !== String(current ?? '');
  }
  if (key === 'tags') {
    if (!Array.isArray(requested)) return false;
    return tagsMismatch(requested as string[], current);
  }
  if (current == null) return requested != null;
  return current !== requested;
}

export function registerWriteTools(
  server: McpServer,
  registry: ClientRegistry,
  config: ElabMcpConfig
): void {
  if (!config.allowWrites) return;

  server.tool(
    'elab_create_entity',
    'Create a new entity. Supports all four kinds:\n' +
      '  - `experiments`: pass `category_id=<templateId>` to instantiate from a template (optional).\n' +
      '  - `items`: pass `category_id=<itemsTypeId>` (required — every item belongs to a type).\n' +
      '  - `experiments_templates` / `items_types`: blank-schema kinds. The elabftw POST endpoint accepts only `title`; this tool follows up with a PATCH for body / metadata / content_type / etc. when supplied.\n' +
      'Optional fields (`date`, `rating`, `status`, `custom_id`, `canread`, `canwrite`, `state`, `content_type`, `metadata`, `body`, `tags`) are forwarded on POST and, if elabftw drops or normalizes any of them, transparently re-PATCHed after a fresh fetch so the values actually land. (elabftw 5.5 is known to silently drop `metadata` on `POST /items` — the reconcile path closes that gap.) Failures of the follow-up PATCH are reported in the response (call `elab_update_entity` or `elab_add_tag` to retry).\n' +
      'When `category_id` is set on an `items` or `experiments` create, the source `items_type` / `experiments_templates` schema is auto-loaded onto the new entity (mirroring the elabftw UI’s "Load fields" affordance); any caller-provided `metadata` wins per-field. Pass `loadFieldsFromCategory: false` to skip the auto-load and create a blank entity.\n' +
      'Pass `team` to target a specific configured team; otherwise the default team is used.',
    {
      entityType: entityTypeSchema,
      team: teamParamSchema,
      category_id: z
        .number()
        .int()
        .optional()
        .describe(
          'Template id (for experiments) or items_type id (for items). Required for items, optional for experiments. Ignored for experiments_templates and items_types.'
        ),
      title: z.string().optional(),
      body: z.string().optional(),
      content_type: z
        .enum(['html', 'markdown'])
        .optional()
        .describe(
          'Body rendering mode. Default `html`. Pass `markdown` when `body` uses GFM tables, `#` headings, fenced code, etc. — otherwise they render as literal characters. Older elabftw versions ignore this on POST; the tool transparently re-PATCHes if the value did not land.'
        ),
      tags: z.array(z.string()).optional(),
      metadata: z
        .string()
        .optional()
        .describe(
          'JSON string for the metadata field (extra_fields etc.). Keep it stringified.'
        ),
      date: z
        .string()
        .optional()
        .describe(
          'YYYYMMDD format (e.g. "20260417"). elabftw defaults to today on POST and the tool re-PATCHes the requested value after creation.'
        ),
      rating: z
        .number()
        .int()
        .min(0)
        .max(5)
        .optional()
        .describe('Integer 0-5. Re-PATCHed after creation if elabftw drops it.'),
      status: z
        .number()
        .int()
        .optional()
        .describe(
          'Status id (team-scoped). Use `elab_list_*`-discovered status ids; v5.x typically honors this on POST.'
        ),
      custom_id: z
        .number()
        .int()
        .optional()
        .describe('Stable per-team identifier. Re-PATCHed if elabftw drops it.'),
      canread: z
        .string()
        .optional()
        .describe(
          'JSON string describing read permissions, e.g. `{"base":40,"teams":[],"users":[],"teamgroups":[]}`. Compared with deep-equal because elabftw normalizes whitespace.'
        ),
      canwrite: z
        .string()
        .optional()
        .describe('Same shape as `canread`.'),
      state: z
        .enum(['normal', 'archived'])
        .optional()
        .describe(
          'Initial state. `normal` (default) or `archived`. To soft-delete an entity use `elab_delete_entity`.'
        ),
      loadFieldsFromCategory: z
        .boolean()
        .optional()
        .describe(
          'Default `true` when `category_id` is set on `items`/`experiments` creates. ' +
            'Auto-loads the items_type / experiments_template schema onto the new entity, ' +
            'merging with any caller-provided `metadata` (caller wins per-field). ' +
            'Mirrors the elabftw UI\'s "Load fields" button. Pass `false` to create a blank entity.'
        ),
    },
    async (args) => {
      const input = args as {
        entityType: ElabEntityType;
        team?: number;
        category_id?: number;
        title?: string;
        body?: string;
        content_type?: 'html' | 'markdown';
        tags?: string[];
        metadata?: string;
        date?: string;
        rating?: number;
        status?: number;
        custom_id?: number;
        canread?: string;
        canwrite?: string;
        state?: StateName;
        loadFieldsFromCategory?: boolean;
      };
      const ct =
        input.content_type === 'markdown'
          ? 2
          : input.content_type === 'html'
            ? 1
            : undefined;
      const stateNum = input.state ? stateMap[input.state] : undefined;
      const t = effectiveTeam(registry, input.team);
      const client = clientFor(registry, input.team);
      const isSchemaKind =
        input.entityType === 'experiments_templates' ||
        input.entityType === 'items_types';

      // Auto-load the items_type / experiments_template schema onto the new
      // entity when `category_id` is set and the caller hasn't opted out.
      // Mirrors the elabftw UI's "Load fields" button (`metadata.ts:250-260`):
      // the source defines the schema, any caller-provided `metadata` wins
      // per-field. The merged blob is fed into `requestedFields.metadata` so
      // the existing reconcile loop is the single PATCH source — we don't
      // add a second PATCH after reconcile (that would race on the same blob).
      //
      // Schema kinds (`experiments_templates`, `items_types`) are ignored
      // silently: they ARE the schemas; there's nothing to inherit.
      const shouldLoadSchema =
        !isSchemaKind &&
        input.category_id !== undefined &&
        input.loadFieldsFromCategory !== false &&
        (input.entityType === 'items' || input.entityType === 'experiments');

      let effectiveMetadata: string | undefined = input.metadata;
      let inheritedFieldCount = 0;
      let inheritFailed: string | null = null;
      let sourceKindLabel: 'items_types' | 'experiments_templates' | null = null;

      if (shouldLoadSchema) {
        const sourceKind: 'items_types' | 'experiments_templates' =
          input.entityType === 'items' ? 'items_types' : 'experiments_templates';
        sourceKindLabel = sourceKind;
        try {
          const source = await client.get(sourceKind, input.category_id!);
          const sourceMeta = client.parseMetadata(source);
          const sourceExtra = sourceMeta?.extra_fields;
          if (sourceMeta && sourceExtra && Object.keys(sourceExtra).length > 0) {
            // Parse caller's metadata (string-encoded) into an object. Treat
            // empty/null as `{}`. If the caller passed garbage, fall through
            // to inheriting just the source schema.
            let callerMeta: ElabMetadata = {};
            if (input.metadata !== undefined) {
              try {
                const parsed = JSON.parse(input.metadata);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  callerMeta = parsed as ElabMetadata;
                }
              } catch {
                // Ignore parse failure; treat caller's metadata as empty for
                // the purposes of the merge — the original string is still
                // honored via `effectiveMetadata` below if we end up bailing.
                callerMeta = {};
              }
            }
            // Per `mergeMetadataForClone` semantics: source is the base,
            // target (caller) wins per-field. That's exactly what we want.
            const merged = mergeMetadataForClone(sourceMeta, callerMeta);
            const callerKeys = new Set(Object.keys(callerMeta.extra_fields ?? {}));
            // "Genuinely inherited" = fields in source's schema that weren't
            // already in the caller's metadata. Reflects new schema landed on
            // the entity, which is the honest signal for the response.
            for (const k of Object.keys(sourceExtra)) {
              if (!callerKeys.has(k)) inheritedFieldCount += 1;
            }
            effectiveMetadata = JSON.stringify(merged);
          }
          // else: source has no schema to inherit; leave effectiveMetadata as-is.
        } catch (e) {
          inheritFailed = (e as Error)?.message || String(e);
        }
      }

      // Fields that POST may drop on older elabftw versions. We forward them
      // anyway, then reconcile from a fresh fetch. `metadata`, `body`, `tags`
      // are included here because elabftw 5.5 has been observed to drop
      // `metadata` on `POST /items`, and the schema-kind branch already
      // needed `body`/`metadata`. Note: `tags` is fed through `requestedFields`
      // for mismatch detection only — the actual reconcile uses
      // `client.addEntityTag(...)` (entity update PATCH doesn't accept tags).
      const requestedFields: Partial<ElabEntityUpdate> & { tags?: string[] } = {
        ...(ct ? { content_type: ct as 1 | 2 } : {}),
        ...(input.date !== undefined ? { date: input.date } : {}),
        ...(input.rating !== undefined ? { rating: input.rating } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.custom_id !== undefined
          ? { custom_id: input.custom_id }
          : {}),
        ...(input.canread !== undefined ? { canread: input.canread } : {}),
        ...(input.canwrite !== undefined ? { canwrite: input.canwrite } : {}),
        ...(stateNum !== undefined ? { state: stateNum } : {}),
        ...(effectiveMetadata !== undefined ? { metadata: effectiveMetadata } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
      };
      return guard(
        async () => {
          const id = await client.create(input.entityType, {
            category_id: input.category_id,
            title: input.title,
            ...requestedFields,
          });
          if (id == null)
            return {
              id,
              landedTeam: undefined as number | undefined,
              reconcileFailed: null as string[] | null,
              inheritedFieldCount,
              inheritFailed,
              sourceKindLabel,
            };
          const fresh = await client.get(input.entityType, id);

          // Build a single reconciliation patch:
          //  1) any optional field whose round-trip value differs from what
          //     the caller requested (POST may have dropped or normalized it),
          //  2) for schema kinds, body+metadata always — the POST endpoint
          //     only honors `title` on templates/items_types,
          //  3) if content_type is being re-PATCHed and a body was supplied,
          //     re-send body so it flows through elabftw's md→html pipeline.
          // `tags` is handled separately (per-tag add calls — the entity
          // PATCH endpoint does not accept a tags field).
          const reconcilePatch: Partial<ElabEntityUpdate> = {};
          let tagsNeedReconcile = false;
          for (const [key, val] of Object.entries(requestedFields)) {
            const current = (fresh as Record<string, unknown>)[key];
            if (!fieldMismatch(key, val, current)) continue;
            if (key === 'tags') {
              tagsNeedReconcile = true;
              continue;
            }
            (reconcilePatch as Record<string, unknown>)[key] = val;
          }
          if (isSchemaKind) {
            // Safety net: the elabftw POST endpoint for templates/items_types
            // only accepts `title`, so always re-PATCH body+metadata when the
            // caller supplied them — even if fresh appeared to match.
            if (input.body !== undefined) reconcilePatch.body = input.body;
            if (effectiveMetadata !== undefined)
              reconcilePatch.metadata = effectiveMetadata;
          }
          if ('content_type' in reconcilePatch && input.body !== undefined) {
            reconcilePatch.body = input.body;
          }

          const reconcileFailed: string[] = [];
          if (Object.keys(reconcilePatch).length > 0) {
            try {
              await client.update(input.entityType, id, reconcilePatch);
            } catch {
              reconcileFailed.push(...Object.keys(reconcilePatch));
            }
          }
          if (tagsNeedReconcile && Array.isArray(input.tags)) {
            // Tag PATCH-via-update is not supported; add each requested tag
            // that isn't already present. We don't try to delete unexpected
            // tags — that's an edge case not observed on POST.
            const currentTags = new Set(
              (typeof fresh.tags === 'string' ? fresh.tags : '')
                .split('|')
                .map((t) => t.trim())
                .filter(Boolean)
            );
            const toAdd = input.tags
              .map((t) => t.trim())
              .filter((t) => t && !currentTags.has(t));
            let tagFailed = false;
            for (const tag of toAdd) {
              try {
                await client.addEntityTag(input.entityType, id, tag);
              } catch {
                tagFailed = true;
              }
            }
            if (tagFailed) reconcileFailed.push('tags');
          }
          return {
            id,
            landedTeam: fresh.team,
            reconcileFailed: reconcileFailed.length ? reconcileFailed : null,
            inheritedFieldCount,
            inheritFailed,
            sourceKindLabel,
          };
        },
        ({
          id,
          landedTeam,
          reconcileFailed,
          inheritedFieldCount: inheritedCount,
          inheritFailed: inheritErr,
          sourceKindLabel: srcLabel,
        }) => {
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
          const label =
            input.entityType === 'experiments_templates'
              ? 'experiments_template'
              : input.entityType === 'items_types'
                ? 'items_type'
                : input.entityType.slice(0, -1);
          const note =
            reconcileFailed && reconcileFailed.length
              ? ` (follow-up PATCH for ${reconcileFailed.join(', ')} failed — call elab_update_entity to retry)`
              : '';
          // Inherited-schema note: only surface when the source had a schema
          // (inheritedCount > 0) or when the auto-load failed. Quiet otherwise.
          let inheritNote = '';
          if (inheritErr && srcLabel) {
            inheritNote = ` (schema load failed: ${inheritErr} — call elab_clone_extra_fields_schema to retry).`;
          } else if (inheritedCount > 0 && srcLabel && input.category_id !== undefined) {
            inheritNote = ` Inherited ${inheritedCount}-field schema from ${srcLabel} #${input.category_id}.`;
          }
          return text(`Created ${label} #${id} in team ${t}.${note}${inheritNote}`);
        }
      );
    }
  );

  server.tool(
    'elab_update_entity',
    'Update fields on any entity (experiments, items, templates, items_types). Any field not provided is left unchanged. Passing `metadata` replaces the whole blob; for single-field edits use `elab_update_extra_field` instead. To soft-delete an entity use `elab_delete_entity`.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
      title: z.string().optional(),
      body: z.string().optional(),
      content_type: z
        .enum(['html', 'markdown'])
        .optional()
        .describe('1 = html (default), 2 = markdown.'),
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
          'Archive (`archived`) or un-archive (`normal`) the entity. To soft-delete use `elab_delete_entity` — this tool deliberately does not accept `deleted` to keep the audit-trail entry point unambiguous.'
        ),
    },
    async (args) => {
      const input = args as Record<string, unknown> & {
        entityType: ElabEntityType;
        id: number;
        team?: number;
        content_type?: 'html' | 'markdown';
        state?: StateName;
      };
      const ct =
        input.content_type === 'markdown'
          ? 2
          : input.content_type === 'html'
            ? 1
            : undefined;
      const stateNum = input.state ? stateMap[input.state] : undefined;
      const {
        entityType,
        id,
        content_type: _ct,
        state: _st,
        team,
        ...rest
      } = input;
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          return client.update(entityType, id, {
            ...rest,
            ...(ct ? { content_type: ct as 1 | 2 } : {}),
            ...(stateNum !== undefined ? { state: stateNum } : {}),
          });
        },
        () => text(`Updated ${entityType.slice(0, -1)} #${id}.`)
      );
    }
  );

  server.tool(
    'elab_update_extra_field',
    'Update the *value* of an already-defined extra field on an entity. ' +
      'Cannot create new fields, change `type` / `options` / `unit`, or touch field groups \u2014 use `elab_set_extra_field` for those. ' +
      'Fast-path for batch value updates: the elabftw server-side handler is `JSON_SET` at `$.extra_fields.<name>.value`, so it bypasses the read-merge-PATCH cycle the full setter pays for. ' +
      'Pre-flight check: this tool first GETs the entity and confirms the field exists in `metadata.extra_fields`; if not, it returns a friendly error pointing at `elab_set_extra_field` (the previous behavior was a silent SQL no-op). ' +
      'Note: `value` is a primitive; complex structures must be JSON-encoded into a string.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
      fieldName: z.string().min(1),
      value: z
        .union([z.string(), z.number(), z.boolean(), z.null()])
        .describe('Primitive value. Complex structures should be JSON-encoded strings.'),
    },
    async (args) => {
      const { entityType, id, team, fieldName, value } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
        fieldName: string;
        value: string | number | boolean | null;
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          const entity = await assertTeam(client, entityType, id, t);
          const metadata = client.parseMetadata(entity);
          const present =
            metadata?.extra_fields &&
            Object.prototype.hasOwnProperty.call(
              metadata.extra_fields,
              fieldName
            );
          if (!present) {
            return {
              ok: false as const,
              reason:
                `Extra field \`${fieldName}\` does not exist on ${entityType.slice(0, -1)} #${id}. ` +
                'This tool only updates the value of a field that is already defined. ' +
                'Use `elab_set_extra_field` to create the field first (it accepts `type`, `options`, `unit`, etc.).',
            };
          }
          await client.updateExtraField(entityType, id, fieldName, value);
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
    'Create or fully replace an `extra_fields` entry on an entity in one call. ' +
      'Performs a read-merge-PATCH on the entity\u2019s `metadata` blob, mirroring the elabftw UI\u2019s field-builder modal. ' +
      'Supported types (15): `text`, `number`, `checkbox`, `date`, `datetime-local`, `email`, `time`, `url`, `select`, `radio`, `experiments`, `items`, `users`, `compounds`, `uploads`. ' +
      'Note: the elabftw UI label "Dropdown menu" maps to the internal type `select`. ' +
      'Per-type validation: `select` / `radio` require `options` (non-empty); `value` (if given) must be in `options`. `number` requires numeric `value`; pass `units` (string[]) to attach a unit picker \u2014 `unit` defaults to `units[0]` if not specified. `checkbox` coerces truthy \u2192 `"on"`, anything else \u2192 `""`. `experiments` / `items` / `users` / `compounds` require a positive integer id as `value`. ' +
      'Auto-link side-effect: when `type` is `experiments` / `items` / `compounds` and `value` is set, also creates the corresponding entity-link (POST `/{entityType}/{id}/{type}_links/{value}`). Pass `autoLink: false` to opt out. `users`-typed fields do NOT auto-link (there is no parallel user-link sub-resource at the entity level). ' +
      'Modes: `replace` (default) overwrites the field entirely; `merge` only updates the supplied properties and keeps existing values for the rest (use this when you just want to add a `description` or move the field to a new `group_id`). ' +
      'For value-only updates after the field already exists, prefer `elab_update_extra_field` \u2014 it bypasses the read-merge-PATCH cycle.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
      name: z.string().min(1).describe('Field key (used verbatim in the metadata blob).'),
      type: z
        .enum(EXTRA_FIELD_TYPES)
        .describe(
          'One of: ' + EXTRA_FIELD_TYPES.join(', ') + '. See the tool description for per-type semantics.'
        ),
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
          'Default value. For `experiments` / `items` / `users` / `compounds` pass the target entity id. For `select` with `allow_multi_values=true` pass a string[]. For `checkbox` pass boolean / "on" / "checked".'
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
        .describe('Group id (must exist in `metadata.elabftw.extra_fields_groups`; omit or pass -1 for the default group).'),
      position: z
        .number()
        .int()
        .optional()
        .describe('Sort order within its group.'),
      mode: z
        .enum(['replace', 'merge'])
        .optional()
        .describe(
          '`replace` (default) rewrites the field entirely; `merge` keeps existing properties not provided in this call.'
        ),
      autoLink: z
        .boolean()
        .optional()
        .describe(
          'For `experiments` / `items` / `compounds` types only \u2014 when true (default), also create the corresponding entity-link. Pass `false` to skip.'
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
        async () => {
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
            { partial: mode === 'merge' && existing !== undefined }
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
              try {
                await client.addLink(
                  input.entityType,
                  input.id,
                  input.type,
                  linkedId
                );
                linked = true;
              } catch (e) {
                // Tolerate "already linked" responses; rethrow on anything
                // else so the caller sees real failures.
                const msg = String((e as Error)?.message ?? '').toLowerCase();
                if (!msg.includes('already') && !msg.includes('duplicate')) {
                  throw e;
                }
              }
            }
          }
          return { name: input.name, type: input.type, value: input.value, linked };
        },
        ({ name, type, value, linked }) => {
          const label =
            input.entityType === 'experiments_templates'
              ? 'experiments_template'
              : input.entityType === 'items_types'
                ? 'items_type'
                : input.entityType.slice(0, -1);
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
    'Delete an `extra_fields` entry from an entity\u2019s metadata blob. ' +
      'Cleans up empty `extra_fields` map + unreferenced `extra_fields_groups` (mirrors the UI\u2019s `cleanupMetadata` behavior). ' +
      'If the metadata blob ends up empty, the entity\u2019s `metadata` is reset to `null`. ' +
      'For `experiments` / `items` / `compounds` typed fields with a valid value, also removes the corresponding entity-link by default (pass `alsoUnlink: false` to keep the link).',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
      name: z.string().min(1),
      alsoUnlink: z
        .boolean()
        .optional()
        .describe(
          'Default `true`. For `experiments` / `items` / `compounds` typed fields, also DELETE the corresponding entity-link. 404 (already-unlinked) is tolerated silently.'
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
        async () => {
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
          const patchMetadata = isMetadataEmpty(metadata)
            ? 'null'
            : JSON.stringify(metadata);
          await client.update(entityType, id, { metadata: patchMetadata });

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
                const msg = String((e as Error)?.message ?? '').toLowerCase();
                // Tolerate 404 / "not found" \u2014 link may already be gone.
                if (!msg.includes('404') && !msg.includes('not found')) {
                  throw e;
                }
              }
            }
          }
          return { removed: true as const, type: removedType, unlinked, linkedId: removedValue };
        },
        (result) => {
          if (!result.removed) return errorText(result.reason);
          const label =
            entityType === 'experiments_templates'
              ? 'experiments_template'
              : entityType === 'items_types'
                ? 'items_type'
                : entityType.slice(0, -1);
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
      'Agent equivalent of the elabftw UI\u2019s "Load fields" button (`metadata.ts:250-260`). ' +
      'Deep-merges: source defines the schema, target\u2019s existing per-field `value`s are preserved; for fields the target doesn\u2019t have yet, the source\u2019s shape (type, options, unit, description, required, group_id, ...) is copied in. ' +
      '`extra_fields_groups` are merged by `id` (target wins on conflicting names). ' +
      'Typical uses: seed a fresh `experiments` entity from an `experiments_templates`; copy an `items_types` schema onto an existing `items` entity. ' +
      'Pass `blankValues: true` for "schema only, no example values" \u2014 sets every field\u2019s `value` to `""` (matches elabftw\u2019s `blank_value_on_duplicate` server-side behavior). Both endpoints must be reachable under the same team.',
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
        async () => {
          // Validate team scope on both ends.
          const source = await assertTeam(client, sourceEntityType, sourceId, t);
          const target = await assertTeam(client, targetEntityType, targetId, t);
          const sourceMeta: ElabMetadata = client.parseMetadata(source) ?? {};
          const targetMeta: ElabMetadata = client.parseMetadata(target) ?? {};

          const merged = mergeMetadataForClone(sourceMeta, targetMeta);
          if (blankValues) {
            blankExtraFieldValues(merged);
          }
          const fieldCount = merged.extra_fields
            ? Object.keys(merged.extra_fields).length
            : 0;
          await client.update(targetEntityType, targetId, {
            metadata: JSON.stringify(merged),
          });
          return { fieldCount };
        },
        ({ fieldCount }) => {
          const label =
            targetEntityType === 'experiments_templates'
              ? 'experiments_template'
              : targetEntityType === 'items_types'
                ? 'items_type'
                : targetEntityType.slice(0, -1);
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
    'Manage the named groups under `metadata.elabftw.extra_fields_groups`. ' +
      'Groups cluster extra fields into collapsible UI sections (the field\u2019s `group_id` references one of these). ' +
      '`mode: \'replace\'` (default) overwrites the groups list entirely; `mode: \'merge\'` upserts by `id` (existing name overwritten; new groups appended). ' +
      'Group id `-1` is reserved for the default / uncategorized bucket; this tool rejects it.',
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
        async () => {
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
        },
        (count) => {
          const label =
            entityType === 'experiments_templates'
              ? 'experiments_template'
              : entityType === 'items_types'
                ? 'items_type'
                : entityType.slice(0, -1);
          return text(
            `Set ${count} extra-field group(s) on ${label} #${id} (mode=${effectiveMode}).`
          );
        }
      );
    }
  );

  server.tool(
    'elab_duplicate_entity',
    'Duplicate an experiment or item. Optionally copies files and creates a link back to the original. `team` selects which configured key to use for the duplicate call. `targetTeam` is where the duplicate should land — defaults to the same team as the source. Useful for cloning shared templates into another team’s workspace.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
      copyFiles: z.boolean().optional(),
      linkToOriginal: z.boolean().optional(),
      targetTeam: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Team id where the duplicate should land. Defaults to the source entity’s team. The configured key for `team` must have permission on `targetTeam`.'
        ),
    },
    async (args) => {
      const { entityType, id, team, copyFiles, linkToOriginal, targetTeam } =
        args as {
          entityType: ElabEntityType;
          id: number;
          team?: number;
          copyFiles?: boolean;
          linkToOriginal?: boolean;
          targetTeam?: number;
        };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          return client.duplicate(entityType, id, {
            copyFiles,
            linkToOriginal,
            ...(targetTeam !== undefined ? { team: targetTeam } : {}),
          });
        },
        (newId) =>
          newId == null
            ? errorText('Duplicated but elabftw returned no new id.')
            : text(
                `Duplicated ${entityType.slice(0, -1)} #${id} → #${newId}${targetTeam !== undefined ? ` (team ${targetTeam})` : ''}.`
              )
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
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
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
          'If `deadline` is set, `deadline_notif=true` makes elabftw email-notify the step owner before the deadline. Default off. Some elabftw versions ignore `deadline` / `deadline_notif` on step POST; check via `elab_list_steps` after creation. Per-step PATCH for these fields is not exposed (the v2 step PATCH dispatcher restricts to `action: finish`).'
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
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
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
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
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
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
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
    'Edit a checklist step in place — change the prose, set / clear the deadline, or flip the deadline-notification flag without churning the audit trail by delete + re-add. Pass any subset of `body` / `deadline` / `deadline_notif`; omitted fields are left untouched. `deadline` is a `YYYY-MM-DD HH:MM:SS` string (UTC); pass `null` to clear an existing deadline. Use `elab_list_steps` to resolve `stepId`. For finished/unfinished, use `elab_toggle_step`.',
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
    'Toggle a checklist step as finished or unfinished.',
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
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          return client.toggleStep(entityType, id, stepId, finished);
        },
        () =>
          text(
            `Step #${stepId} on ${entityType.slice(0, -1)} #${id} marked ${finished ? 'finished' : 'unfinished'}.`
          )
      );
    }
  );

  server.tool(
    'elab_link_entities',
    'Create a link between two entities. `entityType`+`id` are the source; `targetKind`+`targetId` are the destination. Both must live in the same team.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      targetKind: z.enum(['experiments', 'items']),
      targetId: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, targetKind, targetId, team } = args as {
        entityType: ElabEntityType;
        id: number;
        targetKind: 'experiments' | 'items';
        targetId: number;
        team?: number;
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          await assertTeam(client, targetKind, targetId, t);
          await client.addLink(entityType, id, targetKind, targetId);
          return null;
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
    'Remove an existing link between two entities.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      targetKind: z.enum(['experiments', 'items']),
      targetId: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, targetKind, targetId, team } = args as {
        entityType: ElabEntityType;
        id: number;
        targetKind: 'experiments' | 'items';
        targetId: number;
        team?: number;
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          await client.deleteLink(entityType, id, targetKind, targetId);
          return null;
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
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
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
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
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
    'Create a team-scoped tag without attaching it to any entity. Useful for seeding a tag namespace at team setup or before bulk-tagging a cohort via `elab_add_tag`. If the tag already exists (elabftw uses `INSERT ... ON DUPLICATE KEY UPDATE`), the call is idempotent and returns the existing tag id. Requires team-admin privileges on the API key. Pass `team` to pick which configured team key/team to target; omit for the default team.',
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
        () => client.createTag(tag),
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
  const compoundIdentifierFields = {
    molecular_formula: z.string().nullable().optional(),
    molecular_weight: z
      .union([z.number(), z.string()])
      .nullable()
      .optional()
      .describe(
        'Numeric weight. Accepts a number or a string (elabftw returns the field as a string on the wire).'
      ),
    inchi: z.string().nullable().optional(),
    inchi_key: z.string().nullable().optional(),
    smiles: z.string().nullable().optional(),
    iupac_name: z.string().nullable().optional(),
    cas_number: z.string().nullable().optional(),
    ec_number: z.string().nullable().optional(),
    chebi_id: z.string().nullable().optional(),
    chembl_id: z.string().nullable().optional(),
    dea_number: z.string().nullable().optional(),
    drugbank_id: z.string().nullable().optional(),
    dsstox_id: z.string().nullable().optional(),
    hmdb_id: z.string().nullable().optional(),
    kegg_id: z.string().nullable().optional(),
    metabolomics_wb_id: z.string().nullable().optional(),
    nci_code: z.string().nullable().optional(),
    nikkaji_number: z.string().nullable().optional(),
    pharmgkb_id: z.string().nullable().optional(),
    pharos_ligand_id: z.string().nullable().optional(),
    pubchem_cid: z
      .union([z.number(), z.string()])
      .nullable()
      .optional(),
    rxcui: z.string().nullable().optional(),
    unii: z.string().nullable().optional(),
    wikidata: z.string().nullable().optional(),
    wikipedia: z.string().nullable().optional(),
  } as const;
  const compoundHazardFields = {
    is_corrosive: z.boolean().optional(),
    is_explosive: z.boolean().optional(),
    is_flammable: z.boolean().optional(),
    is_gas_under_pressure: z.boolean().optional(),
    is_hazardous2env: z.boolean().optional(),
    is_hazardous2health: z.boolean().optional(),
    is_oxidising: z.boolean().optional(),
    is_toxic: z.boolean().optional(),
    is_radioactive: z.boolean().optional(),
    is_serious_health_hazard: z.boolean().optional(),
    is_antibiotic: z.boolean().optional(),
    is_antibiotic_precursor: z.boolean().optional(),
    is_drug: z.boolean().optional(),
    is_drug_precursor: z.boolean().optional(),
    is_explosive_precursor: z.boolean().optional(),
    is_cmr: z.boolean().optional(),
    is_nano: z.boolean().optional(),
    is_controlled: z.boolean().optional(),
    is_ed2health: z.boolean().optional(),
    is_ed2env: z.boolean().optional(),
    is_pbt: z.boolean().optional(),
    is_pmt: z.boolean().optional(),
    is_vpvb: z.boolean().optional(),
    is_vpvm: z.boolean().optional(),
  } as const;

  server.tool(
    'elab_create_compound',
    'Create a new compound (chemical substance) in the team’s compound catalog. Only `name` is required; everything else is optional and corresponds to PubChem / CAS / ChEMBL / EC identifiers, structural descriptors (InChI / SMILES / formula / MW / IUPAC name), and GHS / regulatory hazard flags (`is_corrosive`, `is_toxic`, `is_cmr`, etc.). Hazard flags accept booleans; the client coerces to 0/1. After create, attach the compound to an entity with `elab_link_entities(..., targetKind: "compounds", targetId: <newId>)` or via `elab_set_extra_field` with `type: "compounds"`. Pass `team` to pick a configured team key; omit for the default. Gated by `ELABFTW_ALLOW_WRITES`.',
    {
      name: z.string().min(1),
      ...compoundIdentifierFields,
      ...compoundHazardFields,
      team: teamParamSchema,
    },
    async (args) => {
      const { team, ...rest } = args as {
        name: string;
        team?: number;
      } & ElabCompoundPatch;
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        () => client.createCompound(rest as { name: string } & ElabCompoundPatch),
        (id) =>
          text(
            id != null
              ? `Created compound #${id} \`${rest.name}\` in team ${t}.`
              : `Created compound \`${rest.name}\` in team ${t}. (elabftw did not return an id; call \`elab_search_compounds\` to resolve.)`
          )
      );
    }
  );

  server.tool(
    'elab_create_compound_from_pubchem',
    'Create a compound by fetching its full record from PubChem. elabftw resolves the identifier (CID preferred, CAS fallback) against PubChem, pulls name / InChI / SMILES / formula / IUPAC / hazard flags, and stores the result in the team catalog. Provide exactly one of `cid` / `cas`. After create, attach to an entity with `elab_link_entities(targetKind: "compounds", targetId: <newId>)` or `elab_set_extra_field(type: "compounds")`. Preview before committing with `elab_search_pubchem`. Pass `team` to pick a configured team key. Gated by `ELABFTW_ALLOW_WRITES`.',
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
    'Patch fields on an existing compound. Plain PATCH semantics — pass any subset of the create-time fields and only those values are written; omitted fields stay untouched. Hazard flags accept booleans (coerced to 0/1). Cannot change team membership through this tool. Pass `team` to pick which configured team key/team the compound lives in. Gated by `ELABFTW_ALLOW_WRITES`.',
    {
      id: z.number().int().positive(),
      name: z.string().min(1).optional(),
      ...compoundIdentifierFields,
      ...compoundHazardFields,
      team: teamParamSchema,
    },
    async (args) => {
      const { id, team, ...rest } = args as {
        id: number;
        team?: number;
      } & ElabCompoundPatch;
      const client = clientFor(registry, team);
      const patch = rest as ElabCompoundPatch;
      if (Object.keys(patch).length === 0) {
        return errorText(
          'No fields provided. Pass at least one of `name` / identifier / hazard fields.'
        );
      }
      return guard(
        () => client.updateCompound(id, patch),
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
    'Soft-delete an experiment or item (sets state=3). The record is still retrievable with state=deleted. Permanent deletion is sysadmin-only and not exposed here. Gated behind `ELABFTW_ALLOW_DESTRUCTIVE` — even a soft-delete hides the row from default listings and can disrupt downstream readers.',
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
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          await client.remove(entityType, id);
          return id;
        },
        () => text(`Soft-deleted ${entityType.slice(0, -1)} #${id}.`)
      );
    }
  );

  server.tool(
    'elab_delete_comment',
    'Permanently delete a comment from an entity. Unlike entity deletion, this is not a soft-delete — the row is removed and the audit-trail entry shows the deletion. Use `elab_list_comments` to find the `commentId`. Gated behind `ELABFTW_ALLOW_DESTRUCTIVE`.',
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
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
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
    'Soft-delete a compound (sets state=3, consistent with `elab_delete_entity`). The compound is still retrievable with `state=deleted`; permanent deletion is sysadmin-only and not exposed. Gated behind `ELABFTW_ALLOW_DESTRUCTIVE` because compound deletion can cascade through `compounds_links` references on experiments / items, removing the link end-points downstream readers depend on. Pass `team` to pick which configured team key/team the compound lives in.',
    {
      id: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { id, team } = args as { id: number; team?: number };
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await client.deleteCompound(id);
          return null;
        },
        () => text(`Soft-deleted compound #${id}.`)
      );
    }
  );

  server.tool(
    'elab_lock',
    'Lock an entity to prevent further edits. Reversible by the owner or an admin via `elab_unlock`. Required before `elab_sign` / `elab_timestamp`.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
      force: z
        .boolean()
        .optional()
        .describe('Admin override; uses action=forcelock.'),
    },
    async (args) => {
      const { entityType, id, team, force } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
        force?: boolean;
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          return client.action(entityType, id, force ? 'forcelock' : 'lock');
        },
        () => text(`Locked ${entityType.slice(0, -1)} #${id}.`)
      );
    }
  );

  server.tool(
    'elab_unlock',
    'Force-unlock a previously locked entity. Admin action.',
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
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
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
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
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
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          return client.action(entityType, id, 'bloxberg');
        },
        () => text(`Bloxberg-anchored ${entityType.slice(0, -1)} #${id}.`)
      );
    }
  );

  server.tool(
    'elab_sign',
    'Cryptographically sign an entity with a configured signature key. Irreversible.',
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
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          return client.action(entityType, id, 'sign');
        },
        () => text(`Signed ${entityType.slice(0, -1)} #${id}.`)
      );
    }
  );

  server.tool(
    'elab_delete_tag',
    'Permanently delete a team-scoped tag. elabftw first detaches the tag from every entity that referenced it, then removes the row. Gated behind `ELABFTW_ALLOW_DESTRUCTIVE` because some teams use tags as permission gates — a stray delete can break access control. Pair with `elab_list_tags` to resolve the tag id first. Requires team-admin privileges on the API key. Pass `team` to pick which configured team key/team to target; omit for the default team.',
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
          await client.deleteTag(tagId);
          return null;
        },
        () => text(`Deleted tag #${tagId} from team ${t}.`)
      );
    }
  );
}
