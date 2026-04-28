/**
 * Per-token MCP server factory.
 *
 * Each registered token gets its own `McpServer` instance, lazily built
 * on first connect. The instance carries a `ClientRegistry` constructed
 * from that token's API key only — so the existing tool registration
 * code (`registerReadTools`, etc.) keeps its `(server, registry, config)`
 * signature, with no async-local-storage tricks and no per-call client
 * lookup.
 *
 * Cost: one `McpServer` + tool-registration pass per active token.
 * Trade-off vs. shared-server-with-per-call-creds: simpler, immune to
 * cross-token bleed, costs a few KB per token. Acceptable at
 * institutional scale.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClientRegistry } from '../mcp/clients';
import type { ElabMcpConfig } from '../mcp/config';
import { registerFanoutTools } from '../mcp/tools/fanout';
import { registerReadTools } from '../mcp/tools/read';
import { registerWriteTools } from '../mcp/tools/write';
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
  const config = buildTokenConfig(base, reg);
  const registry = new ClientRegistry(config);

  const server = new McpServer({
    name: 'sura-elabftw',
    version: '0.2.0',
  });

  registerReadTools(server, registry, config);
  registerWriteTools(server, registry, config);
  // Fanout is multi-team only; per-token mode is single-team by
  // construction, so we deliberately skip it here.
  if (registry.teams().length > 1) {
    registerFanoutTools(server, registry);
  }

  return server;
}
