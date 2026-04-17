import { ElabftwClient } from '../client';
import type { ElabKeyConfig, ElabMcpConfig } from './config';

/**
 * One `ElabftwClient` per configured API key, indexed by team id.
 *
 * The registry is the single place the rest of the server asks "give me
 * the client for team X". Tools thread a `team?: number` argument
 * through and call `registry.get(team)`; when `team` is undefined, the
 * default team's client is returned.
 *
 * Team pinning / scope-guard logic lives on top of this, not inside.
 */
export class ClientRegistry {
  private readonly clients: Map<number, ElabftwClient>;
  private readonly labels: Map<number, string | undefined>;
  private defaultTeamId: number;

  constructor(
    private readonly config: ElabMcpConfig,
    keys: ElabKeyConfig[] = config.keys,
    defaultTeam: number = config.defaultTeam
  ) {
    this.clients = new Map();
    this.labels = new Map();
    for (const entry of keys) {
      this.clients.set(entry.team, this.makeClient(entry));
      this.labels.set(entry.team, entry.label);
    }
    this.defaultTeamId = defaultTeam;
  }

  private makeClient(entry: ElabKeyConfig): ElabftwClient {
    return new ElabftwClient({
      baseUrl: this.config.baseUrl,
      apiKey: entry.key,
      userAgent: this.config.userAgent,
      timeoutMs: this.config.timeoutMs,
    });
  }

  /** Resolve a team id to its client. `undefined` returns the default. */
  get(team: number | undefined): ElabftwClient {
    const t = team ?? this.defaultTeamId;
    const client = this.clients.get(t);
    if (!client) {
      const available = [...this.clients.keys()].sort((a, b) => a - b);
      throw new Error(
        `No elabftw API key configured for team ${t}. ` +
          `Configured teams: ${available.join(', ')}. ` +
          'Mint a key while viewing that team in the elabftw UI and set ELABFTW_KEY_<team>=<key>.'
      );
    }
    return client;
  }

  getDefault(): ElabftwClient {
    return this.get(undefined);
  }

  defaultTeam(): number {
    return this.defaultTeamId;
  }

  teams(): number[] {
    return [...this.clients.keys()].sort((a, b) => a - b);
  }

  labelFor(team: number): string | undefined {
    return this.labels.get(team);
  }

  /**
   * Yield `(team, client)` for every configured key. Used by fan-out
   * tools like `elab_search_all_teams`.
   */
  *entries(): IterableIterator<{
    team: number;
    client: ElabftwClient;
    label?: string;
  }> {
    for (const team of this.teams()) {
      yield {
        team,
        client: this.clients.get(team)!,
        label: this.labels.get(team),
      };
    }
  }

  /**
   * Replace a team id (used for the single-key-no-team-declared flow,
   * where we swap the sentinel `0` for the real team discovered via
   * `/users/me`).
   */
  rekey(oldTeam: number, newTeam: number, label?: string): void {
    if (oldTeam === newTeam) return;
    const client = this.clients.get(oldTeam);
    if (!client) return;
    this.clients.delete(oldTeam);
    this.labels.delete(oldTeam);
    this.clients.set(newTeam, client);
    this.labels.set(newTeam, label);
    if (this.defaultTeamId === oldTeam) this.defaultTeamId = newTeam;
  }
}

/**
 * Validate every configured key against `/users/me`.
 *
 *   - If the env declared a team id explicitly, verify it matches the
 *     user's current team under that key. Mismatch is a warning, not an
 *     error — elabftw still returns data but creation flows will land
 *     entries in the user's actual current team, not the declared one.
 *   - If the env did NOT declare a team (single-key `ELABFTW_API_KEY`
 *     with no `ELABFTW_TEAM_ID`), discover the team and rekey.
 *
 * Warnings go to stderr; failures are thrown.
 */
export async function validateRegistry(
  registry: ClientRegistry,
  teamDeclaredByUser: boolean
): Promise<void> {
  for (const { team: declared, client } of registry.entries()) {
    let resolved: number | undefined;
    try {
      const me = await client.me();
      resolved = me.team;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // biome-ignore lint/suspicious/noConsole: startup diagnostic
      console.error(
        `[elabftw-mcp] Key for team ${declared} failed /users/me: ${msg}. The key is likely invalid or the instance unreachable.`
      );
      continue;
    }

    if (!teamDeclaredByUser && declared === 0 && resolved !== undefined) {
      registry.rekey(0, resolved);
      continue;
    }

    if (resolved !== undefined && resolved !== declared) {
      // biome-ignore lint/suspicious/noConsole: startup diagnostic
      console.error(
        `[elabftw-mcp] Key for team ${declared}: /users/me reports current team ${resolved}. ` +
          'Reads still work, but elab_create_entity will land new entries in team ' +
          `${resolved}, not ${declared}. Switch your current team in the elabftw UI to fix.`
      );
    }
  }
}
