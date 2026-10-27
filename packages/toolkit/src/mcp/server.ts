/**
 * Top-level factory for the elabftw MCP server.
 *
 * Used by both the stdio CLI (one config, one server lifetime) and the
 * hosted-mode HTTP wrapper (one server per registered token, built lazily
 * on first connect). Centralising tool registration here means hosted code
 * doesn't need to know which tools exist or how they're wired.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PACKAGE_VERSION } from '../client/http';
import { ClientRegistry } from './clients';
import type { ElabMcpConfig } from './config';
import { registerFanoutTools } from './tools/fanout';
import { registerReadTools } from './tools/read';
import { filterTools } from './toolsets';
import { registerWriteTools } from './tools/write';

export interface BuildServerOptions {
  /** Server name announced over MCP. */
  name?: string;
  /** Server version announced over MCP. Defaults to the package version. */
  version?: string;
  /**
   * Registry to route tool calls through, e.g. one already checked by
   * `validateRegistry`. Built from `config` when omitted.
   */
  registry?: ClientRegistry;
}

/**
 * Build an `McpServer` fully wired with the elabftw read/write tool set.
 * Fanout tools (cross-team aggregators) are only registered if the
 * registry holds more than one key — useless and confusing on
 * single-team configs.
 */
export function buildElabMcpServer(
  config: ElabMcpConfig,
  options: BuildServerOptions = {}
): McpServer {
  const registry = options.registry ?? new ClientRegistry(config);
  if (!options.registry) {
    // Start the /users/me team lookup early when the key's team is unknown.
    void registry.ensureResolved();
  }
  const multiTeam = registry.size > 1;
  const server = new McpServer(
    {
      name: options.name ?? 'sura-elabftw',
      version: options.version ?? PACKAGE_VERSION,
    },
    { instructions: serverInstructions(multiTeam) }
  );
  const tools = filterTools(server, {
    toolsets: config.toolsets,
    hideTeamParam: !multiTeam,
    beforeCall: () => registry.ensureResolved(),
  });

  registerReadTools(tools, registry, config);
  registerWriteTools(tools, registry, config);
  if (multiTeam) registerFanoutTools(tools, registry);

  return server;
}

/**
 * Shared vocabulary, stated once here instead of in every tool's
 * parameter descriptions.
 */
function serverInstructions(multiTeam: boolean): string {
  const lines = [
    'elabftw electronic lab notebook. Entity kinds (`entityType`): `experiments` = notebook entries; `items` = resources (samples, chemicals, equipment, protocols); `experiments_templates` = experiment templates; `items_types` = resource templates.',
    'Write entry bodies in markdown; they are stored as rich text so lab members can keep editing them in the elabftw editor.',
    'Structured data lives in extra fields (`metadata.extra_fields`); read them with `elab_get`, write them with the extra-field tools.',
  ];
  if (multiTeam) {
    lines.push(
      'Several teams are configured: every tool takes an optional `team` (team id) selecting which team\'s API key to use; omit it for the default team. `elab_configured_teams` lists them.'
    );
  }
  return lines.join('\n');
}
