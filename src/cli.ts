#!/usr/bin/env node
/**
 * @module elabftw MCP Server — CLI entry
 *
 * Standalone MCP server that wraps the elabftw v2 REST API. Run it as a
 * stdio child process of any MCP-aware client (Claude Desktop, Claude
 * Code, Cursor, etc.). See README for full env-var documentation.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ClientRegistry, validateRegistry } from './mcp/clients';
import { loadConfig } from './mcp/config';
import { registerFanoutTools } from './mcp/tools/fanout';
import { registerReadTools } from './mcp/tools/read';
import { registerWriteTools } from './mcp/tools/write';

async function main(): Promise<void> {
  const config = loadConfig();
  const registry = new ClientRegistry(config);

  await validateRegistry(registry, config.teamDeclaredByUser);

  const server = new McpServer({
    name: 'sura-elabftw',
    version: '0.1.0',
  });

  registerReadTools(server, registry, config);
  registerWriteTools(server, registry, config);
  if (registry.teams().length > 1) {
    registerFanoutTools(server, registry);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  // biome-ignore lint/suspicious/noConsole: CLI entry point, stderr is appropriate
  console.error('elabftw MCP server failed to start:', error);
  process.exit(1);
});
