import { ElabftwApiError, ElabftwClient } from '../client';
import type { ElabKeyConfig, ElabMcpConfig } from './config';

/** Placeholder team of a single key configured without `ELABFTW_TEAM_ID`. */
const UNRESOLVED_TEAM = 0;

/**
 * Thrown by the registry's team accessors while the team of a single
 * `ELABFTW_API_KEY` (no `ELABFTW_TEAM_ID`) has not been determined yet.
 */
export class TeamResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamResolutionError';
  }
}

function unresolvedMessage(reason: string): string {
  return (
    'Could not determine which eLabFTW team this API key belongs to: ' +
    `${reason.replace(/\.\s*$/, '')}. Set ELABFTW_TEAM_ID or check connectivity.`
  );
}

function describeFailure(error: unknown): string {
  if (error instanceof ElabftwApiError && error.body) {
    return `${error.message}: ${error.body.slice(0, 300)}`;
  }
  // Callers append their own sentence; drop a trailing period here.
  return (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');
}

/**
 * One `ElabftwClient` per configured API key, indexed by team id.
 *
 * The registry is the single place the rest of the server asks "give me
 * the client for team X". Tools thread a `team?: number` argument
 * through and call `registry.get(team)`; when `team` is undefined, the
 * default team's client is returned.
 *
 * A single key configured without a team starts out unresolved. Its team
 * is looked up via `/users/me` by {@link ClientRegistry.ensureResolved};
 * until that succeeds, every accessor that reports a team id throws a
 * {@link TeamResolutionError} instead of handing out a placeholder.
 *
 * Team pinning / scope-guard logic lives on top of this, not inside.
 */
export class ClientRegistry {
  private readonly clients: Map<number, ElabftwClient>;
  private readonly labels: Map<number, string | undefined>;
  private defaultTeamId: number;
  private unresolved: boolean;
  private resolving: Promise<void> | undefined;
  private lastResolutionFailure: string | undefined;

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
    this.unresolved =
      !config.teamDeclaredByUser && this.clients.has(UNRESOLVED_TEAM);
  }

  private makeClient(entry: ElabKeyConfig): ElabftwClient {
    return new ElabftwClient({
      baseUrl: this.config.baseUrl,
      apiKey: entry.key,
      userAgent: this.config.userAgent,
      timeoutMs: this.config.timeoutMs,
    });
  }

  /**
   * Resolve a team id to its client. `undefined` returns the default.
   * While the team is unresolved, the default client is still returned
   * (it authenticates fine), but an explicit `team` throws.
   */
  get(team: number | undefined): ElabftwClient {
    if (this.unresolved) {
      if (team === undefined) return this.clients.get(UNRESOLVED_TEAM)!;
      throw this.unresolvedError();
    }
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

  /** Throws {@link TeamResolutionError} while the team is unresolved. */
  defaultTeam(): number {
    if (this.unresolved) throw this.unresolvedError();
    return this.defaultTeamId;
  }

  /** Throws {@link TeamResolutionError} while the team is unresolved. */
  teams(): number[] {
    if (this.unresolved) throw this.unresolvedError();
    return [...this.clients.keys()].sort((a, b) => a - b);
  }

  /** Number of configured API keys, resolved or not. */
  get size(): number {
    return this.clients.size;
  }

  /** False while a key's team still has to be looked up via `/users/me`. */
  isResolved(): boolean {
    return !this.unresolved;
  }

  /**
   * Look up the team of an unresolved key via `/users/me`. Resolves
   * immediately when every team is known. Concurrent callers share one
   * in-flight lookup; after a failed lookup the next call tries again.
   *
   * Never rejects: a failure is recorded and reported by the team
   * accessors ({@link defaultTeam}, {@link teams}, {@link entries},
   * {@link get} with a team), which throw {@link TeamResolutionError}.
   */
  ensureResolved(): Promise<void> {
    if (!this.unresolved) return Promise.resolve();
    this.resolving ??= this.resolveTeam().finally(() => {
      this.resolving = undefined;
    });
    return this.resolving;
  }

  private async resolveTeam(): Promise<void> {
    const client = this.clients.get(UNRESOLVED_TEAM);
    if (!client) return;
    try {
      const me = await client.me();
      if (typeof me.team !== 'number' || me.team <= 0) {
        throw new Error('GET /users/me did not report a team');
      }
      this.rekey(UNRESOLVED_TEAM, me.team);
      this.lastResolutionFailure = undefined;
    } catch (error) {
      this.lastResolutionFailure = describeFailure(error);
    }
  }

  /** Why the last `/users/me` lookup failed, if it did. */
  get resolutionFailure(): string | undefined {
    return this.lastResolutionFailure;
  }

  private unresolvedError(): TeamResolutionError {
    const reason =
      this.lastResolutionFailure ??
      (this.resolving
        ? 'the GET /users/me lookup has not finished yet'
        : 'GET /users/me has not been attempted yet');
    // Start another attempt so a later call can succeed even when the
    // caller never awaits ensureResolved() itself.
    void this.ensureResolved();
    return new TeamResolutionError(unresolvedMessage(reason));
  }

  /**
   * Yield `(team, client)` for every configured key. Used by fan-out
   * tools like `elab_search_all_teams`. Throws
   * {@link TeamResolutionError} while the team is unresolved.
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
   * Move the key registered under `oldTeam` to `newTeam`. Used to replace
   * the placeholder team 0 with the team reported by `/users/me`.
   */
  rekey(oldTeam: number, newTeam: number): void {
    if (oldTeam === newTeam) return;
    const client = this.clients.get(oldTeam);
    if (!client) return;
    const label = this.labels.get(oldTeam);
    this.clients.delete(oldTeam);
    this.labels.delete(oldTeam);
    this.clients.set(newTeam, client);
    this.labels.set(newTeam, label);
    if (this.defaultTeamId === oldTeam) this.defaultTeamId = newTeam;
    if (!this.clients.has(UNRESOLVED_TEAM)) this.unresolved = false;
  }
}

/**
 * Startup self-check against `/users/me`. Never throws; problems go to
 * stderr and the server starts regardless.
 *
 *   - If the key's team was not declared (single-key `ELABFTW_API_KEY`
 *     with no `ELABFTW_TEAM_ID`), resolve it via
 *     {@link ClientRegistry.ensureResolved}. On failure the registry stays
 *     unresolved and retries when a tool needs the team.
 *   - If the env declared team ids, verify each matches the user's
 *     current team under that key. Mismatch is a warning, not an error —
 *     elabftw still returns data but creation flows will land entries in
 *     the user's actual current team, not the declared one.
 */
export async function validateRegistry(
  registry: ClientRegistry,
  teamDeclaredByUser: boolean
): Promise<void> {
  if (!registry.isResolved()) {
    await registry.ensureResolved();
    if (!registry.isResolved()) {
      const reason = unresolvedMessage(registry.resolutionFailure ?? 'unknown error');
      // biome-ignore lint/suspicious/noConsole: startup diagnostic
      console.error(
        `[elabftw-mcp] ${reason} The server starts anyway and retries the lookup when a tool needs the team.`
      );
    }
    return;
  }
  // A team resolved via /users/me cannot disagree with /users/me.
  if (!teamDeclaredByUser) return;

  await Promise.all(
    [...registry.entries()].map(async ({ team: declared, client }) => {
      let resolved: number | undefined;
      try {
        resolved = (await client.me()).team;
      } catch (error) {
        // biome-ignore lint/suspicious/noConsole: startup diagnostic
        console.error(
          `[elabftw-mcp] Key for team ${declared} failed /users/me: ${describeFailure(error)}. The key is likely invalid or the instance unreachable.`
        );
        return;
      }
      if (resolved !== undefined && resolved !== declared) {
        // biome-ignore lint/suspicious/noConsole: startup diagnostic
        console.error(
          `[elabftw-mcp] Key for team ${declared}: /users/me reports current team ${resolved}. ` +
            'Reads still work, but elab_create_entity will land new entries in team ' +
            `${resolved}, not ${declared}. Switch your current team in the elabftw UI to fix.`
        );
      }
    })
  );
}
