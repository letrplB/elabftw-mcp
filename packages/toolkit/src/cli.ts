#!/usr/bin/env node
/**
 * @module elabftw MCP Server — stdio CLI entry
 *
 * Standalone MCP server that wraps the eLabFTW v2 REST API for stdio
 * clients (Claude Desktop, Claude Code, Cursor, …).
 *
 * For hosted-mode (multi-tenant HTTP server), install the separate
 * `@sura_ai/elabftw-hosted` package or run its Docker image.
 *
 * See README for full env-var documentation.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ClientRegistry, validateRegistry } from './mcp/clients';
import { loadConfig } from './mcp/config';
import { buildElabMcpServer } from './mcp/server';

async function main(): Promise<void> {
  const config = loadConfig();

  // Check the keys before the MCP handshake so problems show up in the
  // client's server log. Failures are logged, not fatal; the same registry
  // backs the server so a team resolved here is the one tools use.
  const registry = new ClientRegistry(config);
  await validateRegistry(registry, config.teamDeclaredByUser);

  const server = buildElabMcpServer(config, { registry });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  // biome-ignore lint/suspicious/noConsole: CLI entry point, stderr is appropriate
  console.error('elabftw MCP server failed to start:', error);
  process.exit(1);
});
