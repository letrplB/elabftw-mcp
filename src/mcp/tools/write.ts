import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ElabEntityType } from '../../client';
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

export function registerWriteTools(
  server: McpServer,
  registry: ClientRegistry,
  config: ElabMcpConfig
): void {
  if (!config.allowWrites) return;

  server.tool(
    'elab_create_entity',
    'Create a new experiment or item. For experiments pass `category_id=<templateId>` to instantiate a template. For items pass `category_id=<itemsTypeId>`. Pass `team` to target a specific configured team; otherwise the default team is used.',
    {
      entityType: z.enum(['experiments', 'items']),
      team: teamParamSchema,
      category_id: z
        .number()
        .int()
        .optional()
        .describe(
          'Template id (for experiments) or items_type id (for items). Required for items, optional for experiments.'
        ),
      title: z.string().optional(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
      metadata: z
        .string()
        .optional()
        .describe(
          'JSON string for the metadata field (extra_fields etc.). Keep it stringified.'
        ),
    },
    async (args) => {
      const input = args as {
        entityType: 'experiments' | 'items';
        team?: number;
        category_id?: number;
        title?: string;
        body?: string;
        tags?: string[];
        metadata?: string;
      };
      const t = effectiveTeam(registry, input.team);
      const client = clientFor(registry, input.team);
      return guard(
        async () => {
          const id = await client.create(input.entityType, {
            category_id: input.category_id,
            title: input.title,
            body: input.body,
            tags: input.tags,
            metadata: input.metadata,
          });
          if (id == null) return { id, landedTeam: undefined as number | undefined };
          const fresh = await client.get(input.entityType, id);
          return { id, landedTeam: fresh.team };
        },
        ({ id, landedTeam }) => {
          if (id == null) {
            return errorText(
              'Create succeeded but elabftw returned no Location header.'
            );
          }
          if (landedTeam !== undefined && landedTeam !== t) {
            return errorText(
              `Created ${input.entityType.slice(0, -1)} #${id}, but it landed in team ${landedTeam}, not the requested team ${t}. ` +
                'Switch your current team in the elabftw UI (for the key that owns this session) and try again, or soft-delete this entry manually.'
            );
          }
          return text(
            `Created ${input.entityType.slice(0, -1)} #${id} in team ${t}.`
          );
        }
      );
    }
  );

  server.tool(
    'elab_update_entity',
    'Update fields on an experiment or item. Any field not provided is left unchanged. Passing `metadata` replaces the whole blob; for single-field edits use `elab_update_extra_field` instead.',
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
    },
    async (args) => {
      const input = args as Record<string, unknown> & {
        entityType: ElabEntityType;
        id: number;
        team?: number;
        content_type?: 'html' | 'markdown';
      };
      const ct =
        input.content_type === 'markdown'
          ? 2
          : input.content_type === 'html'
            ? 1
            : undefined;
      const { entityType, id, content_type: _ct, team, ...rest } = input;
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          return client.update(entityType, id, {
            ...rest,
            ...(ct ? { content_type: ct as 1 | 2 } : {}),
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
    'Duplicate an experiment or item. Optionally copies files and creates a link back to the original.',
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
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          return client.duplicate(entityType, id, { copyFiles, linkToOriginal });
        },
        (newId) =>
          newId == null
            ? errorText('Duplicated but elabftw returned no new id.')
            : text(`Duplicated ${entityType.slice(0, -1)} #${id} → #${newId}.`)
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
    },
    async (args) => {
      const { entityType, id, team, body, deadline } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
        body: string;
        deadline?: string;
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          return client.addStep(entityType, id, body, { deadline });
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
