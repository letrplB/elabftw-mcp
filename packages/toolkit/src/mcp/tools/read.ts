import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type ElabEntity,
  type ElabEntityType,
  type ElabUser,
  type ElabftwClient,
  type EntityExtras,
  formatComments,
  formatEntityFull,
  formatEntityList,
  formatLinks,
  formatRevisionBody,
  formatRevisions,
  formatSteps,
  formatUploads,
  formatUser,
  formatUserList,
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

/**
 * Check whether a user belongs to the given team. `/users` returns
 * both a `team` scalar (current team under the key) and a `teams`
 * array (full membership). Either may be missing depending on the
 * instance version; we accept both.
 */
function userInTeam(user: ElabUser, team: number): boolean {
  if (user.team === team) return true;
  if (Array.isArray(user.teams) && user.teams.some((t) => t.id === team))
    return true;
  return false;
}

type IncludeKey = 'steps' | 'comments' | 'attachments' | 'links';

/**
 * Fetch one entity + its sub-resources. Assumes `assertTeam` already
 * validated the team. Reused by `elab_get` and `elab_get_bulk`.
 */
async function fetchEntityWithExtras(
  client: ElabftwClient,
  entityType: ElabEntityType,
  id: number,
  include: readonly IncludeKey[] | undefined
): Promise<{ entity: ElabEntity; extras: EntityExtras }> {
  const entity = await client.get(entityType, id);
  if (!include || include.length === 0) {
    return { entity, extras: {} };
  }
  const want = new Set(include);
  const [steps, comments, attachments, linksExp, linksItems] =
    await Promise.all([
      want.has('steps') ? client.listSteps(entityType, id) : undefined,
      want.has('comments') ? client.listComments(entityType, id) : undefined,
      want.has('attachments') ? client.listUploads(entityType, id) : undefined,
      want.has('links')
        ? client.listLinks(entityType, id, 'experiments')
        : undefined,
      want.has('links')
        ? client.listLinks(entityType, id, 'items')
        : undefined,
    ]);
  const links = want.has('links')
    ? [...(linksExp ?? []), ...(linksItems ?? [])]
    : undefined;
  return {
    entity,
    extras: { steps, comments, attachments, links },
  };
}

/**
 * Run an array of async factories in chunks of `size`, sequentially
 * between chunks, parallel within one. Used by bulk fetch to avoid
 * opening 50 sockets at once.
 */
async function chunkedAll<T>(
  factories: Array<() => Promise<T>>,
  size: number
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < factories.length; i += size) {
    const slice = factories.slice(i, i + size).map((fn) => fn());
    const results = await Promise.all(slice);
    for (const r of results) out.push(r);
  }
  return out;
}

export function registerReadTools(
  server: McpServer,
  registry: ClientRegistry,
  config: ElabMcpConfig
): void {
  const revealUsers = config.revealUserIdentities;
  const formatOpts = { revealUsers };
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
    'Fetch a single entity with full body, category, status, tags, and parsed extra_fields. ' +
      'For reviewing a cohort, set `include=["attachments","steps","comments","links"]` to get everything in one round-trip instead of 4 tool calls per entity. ' +
      'Body rendering: `format="markdown"` (default) preserves tables (as GFM pipes) and link hrefs — use this for quantitative review. `format="text"` is the legacy stripped-plain-text behaviour. `format="html"` returns the raw HTML body. ' +
      'Pass `team` to scope the lookup.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
      include: z
        .array(z.enum(['steps', 'comments', 'attachments', 'links']))
        .optional()
        .describe(
          'Sub-resources to fetch in parallel and render under H2 sections. Omit to skip all (default). `links` fetches both `experiments`- and `items`-kinded links.'
        ),
      format: z
        .enum(['text', 'markdown', 'html'])
        .optional()
        .describe(
          'Body rendering: `markdown` (default) lossless HTML→markdown with tables+links. `text` legacy stripped plaintext. `html` raw body.'
        ),
    },
    async (args) => {
      const { entityType, id, team, include, format } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
        include?: Array<'steps' | 'comments' | 'attachments' | 'links'>;
        format?: 'text' | 'markdown' | 'html';
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          return fetchEntityWithExtras(client, entityType, id, include);
        },
        ({ entity, extras }) =>
          text(
            formatEntityFull(
              entity,
              client.parseMetadata(entity),
              extras,
              { ...formatOpts, format: format ?? 'markdown' }
            )
          )
      );
    }
  );

  server.tool(
    'elab_get_bulk',
    'Fetch up to 50 entities of the same kind in one call with shared `include` and `format` options. Ideal for cohort review (40 students × 4 round-trips → 1 call). ' +
      'Each id is validated against the resolved team before fetch; a cross-team id fails the whole call (same rule as `elab_get`). ' +
      'Requests are chunked into groups of 8 to avoid opening 50 sockets at once.',
    {
      entityType: entityTypeSchema,
      ids: z
        .array(z.number().int().positive())
        .min(1)
        .max(50)
        .describe('Entity ids (max 50) — same `entityType` for all.'),
      team: teamParamSchema,
      include: z
        .array(z.enum(['steps', 'comments', 'attachments', 'links']))
        .optional()
        .describe(
          'Sub-resources to fetch for every id. Same semantics as `elab_get`.'
        ),
      format: z
        .enum(['text', 'markdown', 'html'])
        .optional()
        .describe('Body rendering. Same options as `elab_get`.'),
    },
    async (args) => {
      const { entityType, ids, team, include, format } = args as {
        entityType: ElabEntityType;
        ids: number[];
        team?: number;
        include?: Array<'steps' | 'comments' | 'attachments' | 'links'>;
        format?: 'text' | 'markdown' | 'html';
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          const factories = ids.map((id) => async () => {
            await assertTeam(client, entityType, id, t);
            return fetchEntityWithExtras(client, entityType, id, include);
          });
          return chunkedAll(factories, 8);
        },
        (results) => {
          if (results.length === 0) return text('No entities requested.');
          const blocks = results.map(({ entity, extras }, i) => {
            const body = formatEntityFull(
              entity,
              client.parseMetadata(entity),
              extras,
              { ...formatOpts, format: format ?? 'markdown' }
            );
            return `<!-- result ${i + 1}/${results.length} -->\n${body}`;
          });
          return text(blocks.join('\n\n---\n\n'));
        }
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
        (comments) => text(formatComments(comments, formatOpts))
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
    'List cross-entity links. `targetKind=experiments` returns linked experiments; `targetKind=items` returns linked items; `targetKind=all` (default) returns both kinds merged.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      targetKind: z
        .enum(['experiments', 'items', 'all'])
        .optional()
        .describe('Default `all` — fetches both kinds in parallel and concatenates.'),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, targetKind, team } = args as {
        entityType: ElabEntityType;
        id: number;
        targetKind?: 'experiments' | 'items' | 'all';
        team?: number;
      };
      const kind = targetKind ?? 'all';
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          if (kind === 'all') {
            const [exp, items] = await Promise.all([
              client.listLinks(entityType, id, 'experiments'),
              client.listLinks(entityType, id, 'items'),
            ]);
            return [...exp, ...items];
          }
          return client.listLinks(entityType, id, kind);
        },
        (links) => text(formatLinks(links))
      );
    }
  );

  server.tool(
    'elab_list_unfinished_steps',
    'List open checklist steps across all entities visible to the configured team key, grouped by entity kind. Useful for cohort triage (e.g. which students still have unfinished safety-check steps). Pass `team` to pick the configured key/team.',
    {
      team: teamParamSchema,
    },
    async (args) => {
      const { team } = args as { team?: number };
      const client = clientFor(registry, team);
      return guard(
        async () => client.listUnfinishedSteps(),
        (data) => {
          const lines: string[] = [];
          const render = (
            kind: 'experiments' | 'items',
            entries: Array<{ id: number; title: string; steps: Array<[string, string]> }>
          ): void => {
            if (!entries || entries.length === 0) return;
            lines.push(`## ${kind} (${entries.length})`);
            for (const e of entries) {
              lines.push(`- ${kind}/${e.id} ${e.title}`);
              for (const [sid, body] of e.steps ?? []) {
                const trimmed = String(body ?? '').replace(/\s+/g, ' ').trim();
                const snippet =
                  trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
                lines.push(`  - #${sid}: ${snippet}`);
              }
            }
          };
          render('experiments', data.experiments ?? []);
          render('items', data.items ?? []);
          return text(lines.length === 0 ? 'No unfinished steps.' : lines.join('\n'));
        }
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
    'elab_list_revisions',
    'List body revisions for an entity in chronological order. Reveals when the body was edited and by whom — useful for cohort review to spot last-minute edits or copy-paste between students. Availability is per-instance (elabftw can disable revisions in config); 400/404 is returned as a "no history" error.',
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
          return client.listRevisions(entityType, id);
        },
        (revisions) => text(formatRevisions(revisions, formatOpts))
      );
    }
  );

  server.tool(
    'elab_get_revision',
    'Fetch the body of a specific revision. Body is rendered through the same markdown path as `elab_get` (tables + link hrefs preserved). Pair with `elab_list_revisions` to pick a `revisionId`.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      revisionId: z.number().int().positive(),
      team: teamParamSchema,
      format: z
        .enum(['text', 'markdown', 'html'])
        .optional()
        .describe(
          'Body rendering: `markdown` (default) lossless HTML→markdown; `text` legacy stripped plaintext; `html` raw body.'
        ),
    },
    async (args) => {
      const { entityType, id, revisionId, team, format } = args as {
        entityType: ElabEntityType;
        id: number;
        revisionId: number;
        team?: number;
        format?: 'text' | 'markdown' | 'html';
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          await assertTeam(client, entityType, id, t);
          return client.getRevision(entityType, id, revisionId);
        },
        (rev) =>
          text(
            formatRevisionBody(rev, {
              ...formatOpts,
              format: format ?? 'markdown',
            })
          )
      );
    }
  );

  server.tool(
    'elab_list_extra_field_names',
    'List every `extra_fields` key the instance has any data for (instance-wide). Useful for cohort review: discovers which structured fields (yield, mass, observation) students are expected to fill across templates. Rows render as `name | type | options=[...]`. Pair with `elab_get` on an `experiments_templates` id to see the schema of a specific template.',
    {},
    async () =>
      guard(
        () => registry.getDefault().listExtraFieldNames(),
        (descriptors) =>
          text(
            descriptors.length
              ? descriptors
                  .map((d) => {
                    const opts =
                      Array.isArray(d.options) && d.options.length
                        ? ` | options=[${d.options.join(', ')}]`
                        : '';
                    return `${d.name} | ${d.type}${opts}`;
                  })
                  .join('\n')
              : 'No extra_fields keys on this instance.'
          )
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
    'elab_search_users',
    'Search users by name/email (empty `q` lists everyone visible). Returns the mapping from `userid` to identity for cross-referencing entity owners in cohort review. ' +
      (revealUsers
        ? 'Identity reveal is ENABLED (`ELABFTW_REVEAL_USER_IDENTITIES=true`): rows include name + email.'
        : 'Identity reveal is DISABLED (default): rows include only `userid` and team memberships. Set `ELABFTW_REVEAL_USER_IDENTITIES=true` to surface names/emails.') +
      ' `/users` is sysadmin-broad; team-admin keys typically succeed but are limited to users visible via team membership. 403 means the key is not admin.',
    {
      q: z
        .string()
        .optional()
        .describe('Search string. Matches against name/email. Use "" (empty) to list every user the caller can see.'),
      team: teamParamSchema,
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Cap on rows returned (default 100).'),
    },
    async (args) => {
      const input = args as { q?: string; team?: number; limit?: number };
      const t = effectiveTeam(registry, input.team);
      const client = clientFor(registry, input.team);
      const limit = input.limit ?? 100;
      return guard(
        async () => {
          const users = await client.searchUsers(input.q ?? '');
          const scoped = users.filter((u) => userInTeam(u, t));
          return scoped.slice(0, limit);
        },
        (users) =>
          text(
            users.length
              ? `${users.length} user(s) in team ${t}:\n${formatUserList(users, formatOpts)}`
              : `No users visible in team ${t}. (If you expected results, check that the API key is admin: \`/users\` requires team-admin or sysadmin.)`
          )
      );
    }
  );

  server.tool(
    'elab_get_user',
    'Fetch one user by `userid`. Resolves the opaque `userid` field seen on experiments/items/comments to identity + role. ' +
      (revealUsers
        ? 'Identity reveal is ENABLED: output includes name + email.'
        : 'Identity reveal is DISABLED (default): output includes userid + team memberships + role only. Set `ELABFTW_REVEAL_USER_IDENTITIES=true` to surface names/emails.'),
    {
      userid: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { userid, team } = args as { userid: number; team?: number };
      const client = clientFor(registry, team);
      return guard(
        () => client.getUser(userid),
        (user) => text(formatUser(user, formatOpts))
      );
    }
  );

  server.tool(
    'elab_list_team_users',
    'List every user who is a member of a team. Works by calling `/users` under the team\'s admin key and filtering by team membership client-side (eLabFTW has no dedicated team-roster endpoint). Requires a team-admin key for the given team. ' +
      (revealUsers
        ? 'Identity reveal is ENABLED: rows include name + email.'
        : 'Identity reveal is DISABLED (default): rows include userid + role only.'),
    {
      team: teamParamSchema,
    },
    async (args) => {
      const { team } = args as { team?: number };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          const users = await client.searchUsers('');
          return users.filter((u) => userInTeam(u, t));
        },
        (users) =>
          text(
            users.length
              ? `${users.length} member(s) in team ${t}:\n${formatUserList(users, formatOpts)}`
              : `No members visible in team ${t}. The API key likely lacks team-admin privileges; mint a key from a team-admin account.`
          )
      );
    }
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
