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
 * tools see. Inherits all flags (`allowWrites`, `userAgent`, etc.) from
 * the base; replaces `baseUrl` and `keys` with the registration's own.
 *
 * The team id is resolved at registration time by calling `/users/me`
 * with the supplied key. Falling back to `0` would leave the
 * registry's `defaultTeam` mismatched against eLabFTW's view of the
 * key, which silently filters every list response to an empty set.
 */
export function buildTokenConfig(
  base: ElabMcpConfig,
  reg: Registration
): ElabMcpConfig {
  return {
    ...base,
    baseUrl: reg.baseUrl,
    keys: [{ team: reg.team, key: reg.apiKey, label: reg.label }],
    defaultTeam: reg.team,
    teamDeclaredByUser: true,
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
