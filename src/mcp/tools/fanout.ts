import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type ElabEntity,
  type ElabEntityType,
  formatEntityList,
} from '../../client';
import { z } from 'zod';
import type { ClientRegistry } from '../clients';
import { entityTypeSchema, guard, text } from './helpers';
import { filterByTeam } from './team-guard';

const allTeamsInput = z.object({
  entityType: entityTypeSchema,
  q: z.string().optional(),
  extended: z.string().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Per-team limit. Merged result is at most limit × team_count rows.'),
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
  state: z.enum(['normal', 'archived', 'deleted']).optional(),
});

const stateMap = { normal: 1, archived: 2, deleted: 3 } as const;

export function registerFanoutTools(
  server: McpServer,
  registry: ClientRegistry
): void {
  server.tool(
    'elab_search_all_teams',
    'Search the same query across every configured team in parallel, then merge and dedupe by entity id. Each row carries `team=<id>` so you can tell them apart. Use this when you want a unified view across teaching groups / research groups — otherwise use `elab_search` with an explicit `team` for a single team.',
    allTeamsInput.shape as Record<string, unknown>,
    async (args) => {
      const input = args as z.infer<typeof allTeamsInput>;
      return guard(
        async () => {
          const tasks = [...registry.entries()].map(async ({ team, client }) => {
            try {
              const rows = await client.list(
                input.entityType as ElabEntityType,
                {
                  q: input.q,
                  extended: input.extended,
                  order: input.order,
                  sort: input.sort,
                  state: input.state ? stateMap[input.state] : undefined,
                  limit: input.limit ?? 25,
                }
              );
              return filterByTeam(rows, team);
            } catch (error) {
              // Non-fatal — one team failing shouldn't drop the rest.
              const msg = error instanceof Error ? error.message : String(error);
              // biome-ignore lint/suspicious/noConsole: operational diagnostic
              console.error(
                `[elabftw-mcp] team ${team} fan-out failed: ${msg}`
              );
              return [] as ElabEntity[];
            }
          });
          const results = await Promise.all(tasks);
          const merged: ElabEntity[] = [];
          const seen = new Set<string>();
          for (const page of results) {
            for (const row of page) {
              const key = `${row.team ?? '?'}/${row.id}`;
              if (seen.has(key)) continue;
              seen.add(key);
              merged.push(row);
            }
          }
          return merged;
        },
        (rows) =>
          text(
            rows.length
              ? `${rows.length} result(s) across ${registry.teams().length} team(s):\n${formatEntityList(rows)}`
              : 'No matches across any configured team.'
          )
      );
    }
  );
}
