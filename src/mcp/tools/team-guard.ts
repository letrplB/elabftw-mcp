import type {
  ElabEntity,
  ElabEntityType,
  ElabftwClient,
} from '../../client';
import type { ClientRegistry } from '../clients';
import { z } from 'zod';

/**
 * Team scoping for the multi-key registry.
 *
 * Each tool accepts an optional `team` argument. When set, it picks the
 * key to authenticate with AND filters any list response / asserts any
 * single-entity read to match that team. When unset, the default team
 * is used.
 *
 * This is a soft guardrail — it runs in the MCP process, not in
 * elabftw. For hard isolation, rely on key-level access the user's
 * elabftw account grants.
 */

export class TeamScopeViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamScopeViolation';
  }
}

export const teamParamSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    'Team id to scope the call to. Uses the matching ELABFTW_KEY_<team> API key, ' +
      'and filters results / asserts entity team membership accordingly. ' +
      'Omit to use the default team.'
  );

interface HasTeam {
  team?: number | null;
  [key: string]: unknown;
}

/**
 * Filter list rows to the given team. When `team` is undefined the
 * caller wants the default — we still filter to the registry's default
 * team so cross-team bleed (entries visible via a key outside its team
 * scope) doesn't leak into the result.
 */
export function filterByTeam<T extends HasTeam>(
  rows: T[],
  team: number
): T[] {
  return rows.filter((row) => row.team === undefined || row.team === team);
}

/**
 * Resolve the effective team for a call: the `team` argument if present,
 * else the registry's default.
 */
export function effectiveTeam(
  registry: ClientRegistry,
  team: number | undefined
): number {
  return team ?? registry.defaultTeam();
}

/**
 * Get the client for a call. Thin wrapper kept so call sites stay
 * consistent.
 */
export function clientFor(
  registry: ClientRegistry,
  team: number | undefined
): ElabftwClient {
  return registry.get(team);
}

/**
 * Fetch an entity and assert its team matches the expected one. Returns
 * the fetched entity so callers that were already going to GET can
 * re-use it instead of paying for a second round-trip.
 */
export async function assertTeam(
  client: ElabftwClient,
  entityType: ElabEntityType,
  id: number,
  expectedTeam: number
): Promise<ElabEntity> {
  const entity = await client.get(entityType, id);
  if (entity.team !== undefined && entity.team !== expectedTeam) {
    throw new TeamScopeViolation(
      `Entity ${entityType}/${id} is in team ${entity.team}, but this call is scoped to team ${expectedTeam}. ` +
        `Retry with team=${entity.team} (if you have a key for that team), or omit the team parameter.`
    );
  }
  return entity;
}
