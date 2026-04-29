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

  // Validate the registry up front so the user sees a clear error before
  // the MCP handshake instead of a tool-call failure later.
  const registry = new ClientRegistry(config);
  await validateRegistry(registry, config.teamDeclaredByUser);

  const server = buildElabMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  // biome-ignore lint/suspicious/noConsole: CLI entry point, stderr is appropriate
  console.error('elabftw MCP server failed to start:', error);
  process.exit(1);
});
