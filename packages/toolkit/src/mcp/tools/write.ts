import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ElabEntityType, ElabEntityUpdate } from '../../client';
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
      'Optional fields (`date`, `rating`, `status`, `custom_id`, `canread`, `canwrite`, `state`, `content_type`) are forwarded on POST and, if elabftw drops or normalizes any of them, transparently re-PATCHed after a fresh fetch so the values actually land. Failures of the follow-up PATCH are reported in the response (call `elab_update_entity` to retry).\n' +
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

      // Fields that POST may drop on older elabftw versions. We forward them
      // anyway, then reconcile from a fresh fetch.
      const requestedFields: Partial<ElabEntityUpdate> = {
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
      };
      return guard(
        async () => {
          const id = await client.create(input.entityType, {
            category_id: input.category_id,
            title: input.title,
            body: input.body,
            tags: input.tags,
            metadata: input.metadata,
            ...requestedFields,
          });
          if (id == null)
            return {
              id,
              landedTeam: undefined as number | undefined,
              reconcileFailed: null as string[] | null,
            };
          const fresh = await client.get(input.entityType, id);

          // Build a single reconciliation patch:
          //  1) any optional field whose round-trip value differs from what
          //     the caller requested (POST may have dropped or normalized it),
          //  2) for schema kinds, body+metadata always — the POST endpoint
          //     only honors `title` on templates/items_types,
          //  3) if content_type is being re-PATCHed and a body was supplied,
          //     re-send body so it flows through elabftw's md→html pipeline.
          const reconcilePatch: Partial<ElabEntityUpdate> = {};
          for (const [key, val] of Object.entries(requestedFields)) {
            const current = (fresh as Record<string, unknown>)[key];
            if (fieldMismatch(key, val, current)) {
              (reconcilePatch as Record<string, unknown>)[key] = val;
            }
          }
          if (isSchemaKind) {
            if (input.body !== undefined) reconcilePatch.body = input.body;
            if (input.metadata !== undefined)
              reconcilePatch.metadata = input.metadata;
          }
          if ('content_type' in reconcilePatch && input.body !== undefined) {
            reconcilePatch.body = input.body;
          }

          let reconcileFailed: string[] | null = null;
          if (Object.keys(reconcilePatch).length > 0) {
            try {
              await client.update(input.entityType, id, reconcilePatch);
            } catch {
              reconcileFailed = Object.keys(reconcilePatch);
            }
          }
          return { id, landedTeam: fresh.team, reconcileFailed };
        },
        ({ id, landedTeam, reconcileFailed }) => {
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
          return text(`Created ${label} #${id} in team ${t}.${note}`);
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
    'Update a single `extra_fields` value on an entity without touching the rest of the metadata blob. The field must already exist in the entity\u2019s metadata schema.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
      fieldName: z.string(),
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
          await assertTeam(client, entityType, id, t);
          return client.updateExtraField(entityType, id, fieldName, value);
        },
        () =>
          text(
            `Updated extra field \`${fieldName}\` on ${entityType.slice(0, -1)} #${id}.`
          )
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
    'elab_delete_entity',
    'Soft-delete an experiment or item (sets state=3). The record is still retrievable with state=deleted. Permanent deletion is sysadmin-only and not exposed here.',
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

  // ------------------------------------------------------------------------
  // Destructive / audit-affecting actions. Gated by a second env flag.
  // ------------------------------------------------------------------------

  if (!config.allowDestructive) return;

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
}
