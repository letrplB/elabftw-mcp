/**
 * Top-level factory for the elabftw MCP server.
 *
 * Used by both the stdio CLI (one config, one server lifetime) and the
 * hosted-mode HTTP wrapper (one server per registered token, built lazily
 * on first connect). Centralising tool registration here means hosted code
 * doesn't need to know which tools exist or how they're wired.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClientRegistry } from './clients';
import type { ElabMcpConfig } from './config';
import { registerFanoutTools } from './tools/fanout';
import { registerReadTools } from './tools/read';
import { registerWriteTools } from './tools/write';

export interface BuildServerOptions {
  /** Server name announced over MCP. */
  name?: string;
  /** Server version announced over MCP. */
  version?: string;
}

/**
 * Build an `McpServer` fully wired with the elabftw read/write tool set.
 * Fanout tools (cross-team aggregators) are only registered if the
 * registry exposes more than one team — useless and confusing on
 * single-team configs.
 */
export function buildElabMcpServer(
  config: ElabMcpConfig,
  options: BuildServerOptions = {}
): McpServer {
  const registry = new ClientRegistry(config);
  const server = new McpServer({
    name: options.name ?? 'sura-elabftw',
    version: options.version ?? '0.4.0',
  });

  registerReadTools(server, registry, config);
  registerWriteTools(server, registry, config);
  if (registry.teams().length > 1) {
    registerFanoutTools(server, registry);
  }

  return server;
}
