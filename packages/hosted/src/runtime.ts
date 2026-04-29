/**
 * Per-token MCP server factory.
 *
 * Each registered token gets its own `McpServer` instance, lazily built
 * on first connect. Tool wiring is delegated to the toolkit's
 * `buildElabMcpServer` factory so this package never has to know which
 * tools exist.
 *
 * Cost: one `McpServer` + tool-registration pass per active token.
 * Trade-off vs. shared-server-with-per-call-creds: simpler, immune to
 * cross-token bleed, costs a few KB per token. Acceptable at
 * institutional scale.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildElabMcpServer, type ElabMcpConfig } from '@sura_ai/elabftw';
import type { Registration } from './store';

/**
 * Project a base config + a registration into the per-token config that
 * tools see. Replaces `baseUrl` and `keys` with the registration's own.
 *
 * Per-token flags (`allowWrites`, `allowDestructive`,
 * `revealUserIdentities`) are AND-ed against the base config — the
 * operator's env-var settings are the upper bound, the registration is
 * the user's opt-in subset.
 *
 * Multi-key registrations route the toolkit's existing per-team
 * registry: every tool gets a `team` parameter, and the
 * `elab_search_all_teams` fanout tool auto-registers on >1 keys.
 */
export function buildTokenConfig(
  base: ElabMcpConfig,
  reg: Registration
): ElabMcpConfig {
  return {
    ...base,
    baseUrl: reg.baseUrl,
    keys: reg.keys.map((k) => ({
      team: k.team,
      key: k.apiKey,
      label: k.label,
    })),
    defaultTeam: reg.defaultTeam,
    teamDeclaredByUser: true,
    allowWrites: base.allowWrites && reg.allowWrites,
    allowDestructive:
      base.allowDestructive && reg.allowDestructive && reg.allowWrites,
    revealUserIdentities:
      base.revealUserIdentities && reg.revealUserIdentities,
  };
}

/**
 * Build an `McpServer` for one registration. The server is fully
 * configured with read/write tools (gated by base `allowWrites`) and
 * ready to be wired to a transport.
 */
export function buildMcpServerForToken(
  base: ElabMcpConfig,
  reg: Registration
): McpServer {
  return buildElabMcpServer(buildTokenConfig(base, reg));
}
