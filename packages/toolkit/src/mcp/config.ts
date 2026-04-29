/**
 * Env-var parsing for the elabftw MCP server.
 *
 * Two mutually-exclusive input shapes are supported:
 *
 *   1. Multi-key mode (indexed): `ELABFTW_KEY_<teamId>=<apiKey>`
 *      Every env var matching that pattern becomes one entry. The
 *      environment variable name *is* the team id. Optional
 *      `ELABFTW_DEFAULT_TEAM` names the default; otherwise the
 *      numerically smallest team id is used.
 *
 *   2. Single-key mode (legacy / simple): `ELABFTW_API_KEY=<key>`
 *      Optional `ELABFTW_TEAM_ID=<n>` pins the team; otherwise the
 *      team is resolved at startup via `/users/me`.
 *
 * Both modes produce the same internal shape: a list of `ElabKeyConfig`
 * entries and a numeric `defaultTeam`. Tools route through a registry
 * keyed by team id.
 */

export interface ElabKeyConfig {
  /** The numeric team id the key unlocks. */
  team: number;
  /** The elabftw API key (raw, sent as the `Authorization` header). */
  key: string;
  /** Optional human-readable label (e.g. "Main Lab"). */
  label?: string;
}

export interface ElabMcpConfig {
  /** Instance root URL, no trailing slash, no `/api/v2` suffix. */
  baseUrl: string;
  userAgent?: string;
  timeoutMs?: number;
  allowWrites: boolean;
  allowDestructive: boolean;
  /**
   * When true, formatters may surface user names, emails, and orcids
   * through MCP tool output. When false (default), user fields are
   * redacted to `user <id>` and team membership ids. `elab_me` is
   * exempt — the caller's own identity is not a privacy concern.
   *
   * Controlled by `ELABFTW_REVEAL_USER_IDENTITIES` env var.
   */
  revealUserIdentities: boolean;
  /**
   * One entry per API key. Non-empty in stdio mode. May be empty in hosted
   * mode, where per-request tokens supply credentials at call time and the
   * boot-time config is only used as a flag carrier (`baseUrl`,
   * `allowWrites`, etc.). Hosted-mode code constructs a fresh
   * single-entry config per registered token and never reads the empty
   * shell's `keys`.
   */
  keys: ElabKeyConfig[];
  /** Team id used when a tool call doesn't specify `team`. Always present in `keys` (stdio mode). */
  defaultTeam: number;
  /**
   * When true, the team field on each key was supplied by the user in
   * the env; when false it was inferred via a /users/me lookup at
   * startup. Used only for better error messages.
   */
  teamDeclaredByUser: boolean;
}

class ElabMcpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElabMcpConfigError';
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new ElabMcpConfigError(
      `Missing required env var ${name}. See the README of @sura_ai/elabftw.`
    );
  }
  return value.trim();
}

function optionalBool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function parsePositiveInt(raw: string, label: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ElabMcpConfigError(
      `${label} must be a positive integer, got: ${raw}`
    );
  }
  return parsed;
}

/**
 * Collect `ELABFTW_KEY_<teamId>` env vars. Optional sibling labels
 * `ELABFTW_KEY_<teamId>_LABEL` attach a human-readable name.
 */
function collectIndexedKeys(): ElabKeyConfig[] {
  const out: ElabKeyConfig[] = [];
  for (const [name, raw] of Object.entries(process.env)) {
    const match = /^ELABFTW_KEY_(\d+)$/.exec(name);
    if (!match || !match[1] || !raw || !raw.trim()) continue;
    const team = parsePositiveInt(match[1], name);
    const labelEnv = process.env[`ELABFTW_KEY_${team}_LABEL`];
    out.push({
      team,
      key: raw.trim(),
      label: labelEnv?.trim() || undefined,
    });
  }
  return out.sort((a, b) => a.team - b.team);
}

export interface LoadConfigOptions {
  /**
   * In hosted mode, per-request tokens supply API keys at call time, so
   * boot-time `ELABFTW_API_KEY` / `ELABFTW_KEY_<n>` are not required. We
   * still load the rest of the config (base URL, flags) and synthesize a
   * placeholder `keys` entry so downstream types stay happy; hosted-mode
   * code never reads from it.
   */
  requireKeys?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): ElabMcpConfig {
  const requireKeys = options.requireKeys ?? true;
  const baseUrl = requireEnv('ELABFTW_BASE_URL').replace(/\/+$/, '');

  const timeoutRaw = process.env.ELABFTW_TIMEOUT_MS;
  const parsedTimeout = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : undefined;
  const timeoutMs = Number.isFinite(parsedTimeout) ? parsedTimeout : undefined;
  const userAgent = process.env.ELABFTW_USER_AGENT ?? 'sura-elabftw-mcp/0.1.0';
  const allowWrites = optionalBool('ELABFTW_ALLOW_WRITES');
  const allowDestructive = optionalBool('ELABFTW_ALLOW_DESTRUCTIVE');
  const revealUserIdentities = optionalBool('ELABFTW_REVEAL_USER_IDENTITIES');

  const indexedKeys = collectIndexedKeys();
  const legacyKey = process.env.ELABFTW_API_KEY?.trim();

  if (!requireKeys && indexedKeys.length === 0 && !legacyKey) {
    return {
      baseUrl,
      userAgent,
      timeoutMs,
      allowWrites,
      allowDestructive,
      revealUserIdentities,
      keys: [],
      defaultTeam: 0,
      teamDeclaredByUser: false,
    };
  }

  if (indexedKeys.length > 0 && legacyKey) {
    throw new ElabMcpConfigError(
      'Both ELABFTW_KEY_<team> and ELABFTW_API_KEY are set. Use one or the other — ' +
        'indexed env vars are the recommended multi-team shape.'
    );
  }

  if (indexedKeys.length > 0) {
    const defaultRaw = process.env.ELABFTW_DEFAULT_TEAM?.trim();
    const defaultTeam = defaultRaw
      ? parsePositiveInt(defaultRaw, 'ELABFTW_DEFAULT_TEAM')
      : indexedKeys[0]!.team;
    if (!indexedKeys.some((k) => k.team === defaultTeam)) {
      throw new ElabMcpConfigError(
        `ELABFTW_DEFAULT_TEAM=${defaultTeam} does not match any configured ELABFTW_KEY_<team> env var. ` +
          `Available teams: ${indexedKeys.map((k) => k.team).join(', ')}.`
      );
    }
    return {
      baseUrl,
      userAgent,
      timeoutMs,
      allowWrites,
      allowDestructive,
      revealUserIdentities,
      keys: indexedKeys,
      defaultTeam,
      teamDeclaredByUser: true,
    };
  }

  if (!legacyKey) {
    throw new ElabMcpConfigError(
      'No elabftw API keys configured. Set either ELABFTW_API_KEY (single-team) ' +
        'or one-or-more ELABFTW_KEY_<teamId>=... (multi-team).'
    );
  }

  const teamIdRaw = process.env.ELABFTW_TEAM_ID?.trim();
  if (teamIdRaw) {
    const team = parsePositiveInt(teamIdRaw, 'ELABFTW_TEAM_ID');
    return {
      baseUrl,
      userAgent,
      timeoutMs,
      allowWrites,
      allowDestructive,
      revealUserIdentities,
      keys: [{ team, key: legacyKey }],
      defaultTeam: team,
      teamDeclaredByUser: true,
    };
  }

  // Single-key, no team declared. Use a sentinel (0) that the startup
  // self-check replaces with the real team from /users/me.
  return {
    baseUrl,
    userAgent,
    timeoutMs,
    allowWrites,
    allowDestructive,
    revealUserIdentities,
    keys: [{ team: 0, key: legacyKey }],
    defaultTeam: 0,
    teamDeclaredByUser: false,
  };
}
