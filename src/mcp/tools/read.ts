import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type ElabEntityType,
  formatComments,
  formatEntityFull,
  formatEntityList,
  formatLinks,
  formatSteps,
  formatUploads,
} from '../../client';
import { z } from 'zod';
import type { ClientRegistry } from '../clients';
import type { ElabMcpConfig } from '../config';
import { entityTypeSchema, guard, text } from './helpers';
import {
  assertTeam,
  clientFor,
  effectiveTeam,
  filterByTeam,
  teamParamSchema,
} from './team-guard';

const listInput = z.object({
  entityType: entityTypeSchema,
  team: teamParamSchema,
  q: z
    .string()
    .optional()
    .describe('Full-text search against title and body.'),
  extended: z
    .string()
    .optional()
    .describe(
      'Advanced elabftw query DSL, e.g. `rating:5 and tag:"buffer" and date:>2024-01-01`. Takes precedence over `q`.'
    ),
  category: z.number().int().optional().describe('Filter by category id.'),
  status: z.number().int().optional().describe('Filter by status id.'),
  tags: z
    .array(z.number().int())
    .optional()
    .describe('Filter by tag ids (AND).'),
  owner: z
    .number()
    .int()
    .optional()
    .describe('Restrict to a specific owner userid.'),
  scope: z
    .enum(['self', 'team', 'everything'])
    .optional()
    .describe('Visibility scope. Defaults to the instance default.'),
  order: z
    .enum([
      'cat',
      'comment',
      'customid',
      'date',
      'id',
      'lastchange',
      'rating',
      'status',
      'title',
      'user',
    ])
    .optional(),
  sort: z.enum(['asc', 'desc']).optional(),
  state: z
    .enum(['normal', 'archived', 'deleted'])
    .optional()
    .describe('State filter (default: normal).'),
  limit: z.number().int().min(1).max(200).optional().describe('Default 25.'),
  offset: z.number().int().min(0).optional(),
});

const scopeMap = { self: 1, team: 2, everything: 3 } as const;
const stateMap = { normal: 1, archived: 2, deleted: 3 } as const;

export function registerReadTools(
  server: McpServer,
  registry: ClientRegistry,
  _config: ElabMcpConfig
): void {
  server.tool(
    'elab_search',
    'Search experiments, items, templates, or items_types within one team. Pass `team` to pick which configured key/team to query; omit for the default team. Results are filtered to that team. Use `extended` for the elabftw DSL (rating:, tag:, date:, category:) when you need precise filters.',
    listInput.shape as Record<string, unknown>,
    async (args) => {
      const input = args as z.infer<typeof listInput>;
      const team = effectiveTeam(registry, input.team);
      const client = clientFor(registry, input.team);
      return guard(
        async () => {
          const rows = await client.list(input.entityType as ElabEntityType, {
            q: input.q,
            extended: input.extended,
            cat: input.category,
            status: input.status,
            tags: input.tags,
            owner: input.owner,
            scope: input.scope ? scopeMap[input.scope] : undefined,
            order: input.order,
            sort: input.sort,
            state: input.state ? stateMap[input.state] : undefined,
            limit: input.limit ?? 25,
            offset: input.offset,
          });
          return filterByTeam(rows, team);
        },
        (rows) =>
          text(
            rows.length
              ? `${rows.length} result(s) in team ${team}:\n${formatEntityList(rows)}`
              : `No matches in team ${team}.`
          )
      );
    }
  );

  server.tool(
    'elab_get',
    'Fetch a single entity with full body, category, status, tags, and parsed extra_fields. HTML body is stripped to plain text for readability. Pass `team` to scope the lookup.',
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
        () => assertTeam(client, entityType, id, t),
        (entity) => text(formatEntityFull(entity, client.parseMetadata(entity)))
      );
    }
  );

  server.tool(
    'elab_list_attachments',
    'List files attached to an entity. Returns id, filename, size, and any caption. Use `elab_download_attachment` to fetch bytes.',
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
          return client.listUploads(entityType, id);
        },
        (uploads) => text(formatUploads(uploads))
      );
    }
  );

  server.tool(
    'elab_download_attachment',
    'Download the raw bytes of an attachment. Text files are returned as text; binary files return as base64 with their MIME type and size. Large files (>2 MB) are truncated with a note.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      uploadId: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, uploadId, team } = args as {
        entityType: ElabEntityType;
        id: number;
        uploadId: number;
        team?: number;
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          const meta = await client.getUpload(entityType, id, uploadId);
          const resp = await client.downloadUpload(entityType, id, uploadId);
          const buf = await resp.arrayBuffer();
          return { meta, buf };
        },
        ({ meta, buf }) => {
          const ct = meta.type ?? 'application/octet-stream';
          const name = meta.real_name ?? meta.long_name ?? `upload-${uploadId}`;
          const size = buf.byteLength;
          const MAX = 2 * 1024 * 1024;

          const isTextLike =
            typeof ct === 'string' &&
            (ct.startsWith('text/') ||
              ct.includes('json') ||
              ct.includes('xml') ||
              ct.includes('csv'));

          if (isTextLike && size <= MAX) {
            const decoded = new TextDecoder('utf-8', { fatal: false }).decode(
              new Uint8Array(buf)
            );
            return text(`${name} (${ct}, ${size} bytes):\n\n${decoded}`);
          }

          const capped = size > MAX ? buf.slice(0, MAX) : buf;
          const base64 = Buffer.from(capped).toString('base64');
          const suffix = size > MAX ? ` (truncated from ${size} bytes)` : '';
          return text(
            `${name} (${ct}, ${size} bytes)${suffix}\nbase64:\n${base64}`
          );
        }
      );
    }
  );

  server.tool(
    'elab_list_comments',
    'List comments on an entity in creation order.',
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
          return client.listComments(entityType, id);
        },
        (comments) => text(formatComments(comments))
      );
    }
  );

  server.tool(
    'elab_list_steps',
    'List checklist steps on an entity. Unfinished steps are shown as [ ], finished as [x].',
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
          return client.listSteps(entityType, id);
        },
        (steps) => text(formatSteps(steps))
      );
    }
  );

  server.tool(
    'elab_list_links',
    'List cross-entity links. `targetKind=experiments` returns linked experiments; `targetKind=items` returns linked items. Run both if you need everything.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      targetKind: z.enum(['experiments', 'items']),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, targetKind, team } = args as {
        entityType: ElabEntityType;
        id: number;
        targetKind: 'experiments' | 'items';
        team?: number;
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          return client.listLinks(entityType, id, targetKind);
        },
        (links) => text(formatLinks(links))
      );
    }
  );

  server.tool(
    'elab_list_templates',
    'List experiment templates available in a team. Useful for discovering what template id to pass to `elab_create_entity`.',
    {
      q: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
      team: teamParamSchema,
    },
    async (args) => {
      const { q, limit, offset, team } = args as {
        q?: string;
        limit?: number;
        offset?: number;
        team?: number;
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          const rows = await client.listTemplates({
            q,
            limit: limit ?? 25,
            offset,
          });
          return filterByTeam(rows, t);
        },
        (rows) => text(formatEntityList(rows))
      );
    }
  );

  server.tool(
    'elab_list_items_types',
    'List items_types (the category schemas that define what kinds of items exist in this team, e.g. "Antibody", "Reagent", "Instrument").',
    {
      q: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      team: teamParamSchema,
    },
    async (args) => {
      const { q, limit, team } = args as {
        q?: string;
        limit?: number;
        team?: number;
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          const rows = await client.listItemsTypes({ q, limit: limit ?? 50 });
          return filterByTeam(rows, t);
        },
        (rows) => text(formatEntityList(rows))
      );
    }
  );

  server.tool(
    'elab_list_tags',
    'List tags in a team, optionally filtered by a query string.',
    {
      q: z.string().optional(),
      team: teamParamSchema,
    },
    async (args) => {
      const { q, team } = args as { q?: string; team?: number };
      const client = clientFor(registry, team);
      return guard(
        () => client.listTags({ q }),
        (tags) =>
          text(
            tags.length
              ? tags
                  .map(
                    (tag) =>
                      `#${tag.id} ${tag.tag}${tag.item_count != null ? ` (${tag.item_count})` : ''}`
                  )
                  .join('\n')
              : 'No tags.'
          )
      );
    }
  );

  server.tool(
    'elab_list_events',
    'List scheduler / booking events. Pass `start` and `end` as ISO dates (YYYY-MM-DD or full ISO 8601) to bound the range. Filter by `item` to see bookings for one bookable resource.',
    {
      start: z.string().optional(),
      end: z.string().optional(),
      item: z.number().int().optional(),
      team: teamParamSchema,
    },
    async (args) => {
      const input = args as {
        start?: string;
        end?: string;
        item?: number;
        team?: number;
      };
      const t = effectiveTeam(registry, input.team);
      const client = clientFor(registry, input.team);
      return guard(
        async () => {
          const events = await client.listEvents({
            start: input.start,
            end: input.end,
            item: input.item,
          });
          return filterByTeam(events, t);
        },
        (events) =>
          text(
            events.length
              ? events
                  .map(
                    (e) =>
                      `#${e.id} ${e.title ?? '(untitled)'} | item=${e.item} | ${e.start} → ${e.end}`
                  )
                  .join('\n')
              : 'No events in range.'
          )
      );
    }
  );

  server.tool(
    'elab_me',
    'Return the authenticated caller\u2019s user record: userid, name, email, team memberships, admin flags. Pass `team` to query via a specific configured key; omit to use the default key.',
    { team: teamParamSchema },
    async (args) => {
      const { team } = args as { team?: number };
      const client = clientFor(registry, team);
      return guard(
        () => client.me(),
        (user) =>
          text(
            [
              `userid=${user.userid}`,
              `name=${user.fullname ?? `${user.firstname ?? ''} ${user.lastname ?? ''}`.trim()}`,
              `email=${user.email ?? '?'}`,
              `current_team=${user.team ?? '?'}`,
              user.is_sysadmin
                ? 'role=sysadmin'
                : user.is_admin
                  ? 'role=admin'
                  : 'role=user',
            ]
              .filter(Boolean)
              .join(' | ')
          )
      );
    }
  );

  server.tool(
    'elab_info',
    'Return instance metadata: elabftw version, PHP version, and aggregate counts. Useful as a sanity-check call before heavy operations.',
    {},
    async () =>
      guard(
        () => registry.getDefault().info(),
        (info) => text(JSON.stringify(info, null, 2))
      )
  );

  server.tool(
    'elab_list_teams',
    'List teams on the instance the caller has access to. Returns id + name so you can map the `team=<id>` field in search results back to a group name.',
    {},
    async () =>
      guard(
        () => registry.getDefault().listTeams(),
        (teams) => {
          const configured = new Set(registry.teams());
          return text(
            teams.length
              ? teams
                  .map((t) => {
                    const marker = configured.has(t.id) ? ' ★ key configured' : '';
                    const orgid = t.orgid ? ` (orgid=${t.orgid})` : '';
                    return `#${t.id} ${t.name}${orgid}${marker}`;
                  })
                  .join('\n')
              : 'No teams visible.'
          );
        }
      )
  );

  server.tool(
    'elab_configured_teams',
    'List the teams this MCP server has API keys configured for. Use this to discover valid values for the `team` parameter on other tools.',
    {},
    async () => {
      const entries = [...registry.entries()];
      const defaultTeam = registry.defaultTeam();
      if (entries.length === 0) return text('No teams configured.');
      return text(
        entries
          .map(
            (e) =>
              `team=${e.team}${e.label ? ` (${e.label})` : ''}${e.team === defaultTeam ? ' [default]' : ''}`
          )
          .join('\n')
      );
    }
  );

  server.tool(
    'elab_export',
    'Export an entity to pdf / pdfa / zip / zipa / eln / elnhtml / qrpng / qrpdf / csv / json. Returns either text (for csv/json) or base64-encoded binary with its MIME type. Set `changelog=true` to include revision history in PDFs.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      format: z.enum([
        'csv',
        'json',
        'pdf',
        'pdfa',
        'zip',
        'zipa',
        'eln',
        'elnhtml',
        'qrpdf',
        'qrpng',
      ]),
      changelog: z.boolean().optional(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, format, changelog, team } = args as {
        entityType: ElabEntityType;
        id: number;
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
          | 'qrpng';
        changelog?: boolean;
        team?: number;
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          const resp = await client.export(entityType, id, format, {
            changelog,
          });
          const ct = resp.headers.get('content-type') ?? 'application/octet-stream';
          const buf = await resp.arrayBuffer();
          return { ct, buf };
        },
        ({ ct, buf }) => {
          const size = buf.byteLength;
          const MAX = 2 * 1024 * 1024;
          if (format === 'csv' || format === 'json' || format === 'elnhtml') {
            const decoded = new TextDecoder('utf-8', { fatal: false }).decode(
              new Uint8Array(buf)
            );
            return text(`${ct} (${size} bytes):\n\n${decoded}`);
          }
          const capped = size > MAX ? buf.slice(0, MAX) : buf;
          const base64 = Buffer.from(capped).toString('base64');
          const suffix = size > MAX ? ` (truncated from ${size} bytes)` : '';
          return text(`${ct} (${size} bytes)${suffix}\nbase64:\n${base64}`);
        }
      );
    }
  );
}
