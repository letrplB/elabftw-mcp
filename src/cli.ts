#!/usr/bin/env node
/**
 * @module elabftw MCP Server — CLI entry
 *
 * Standalone MCP server that wraps the elabftw v2 REST API.
 *
 * Two run modes:
 *   - stdio (default): run as a stdio child process of an MCP-aware
 *     client (Claude Desktop, Claude Code, Cursor, …).
 *   - hosted (`MCP_MODE=hosted`): run as an HTTP server with
 *     self-service registration; clients connect over Streamable HTTP.
 *
 * See README for full env-var documentation.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ClientRegistry, validateRegistry } from './mcp/clients';
import { loadConfig } from './mcp/config';
import { registerFanoutTools } from './mcp/tools/fanout';
import { registerReadTools } from './mcp/tools/read';
import { registerWriteTools } from './mcp/tools/write';

async function runStdio(): Promise<void> {
  const config = loadConfig();
  const registry = new ClientRegistry(config);

  await validateRegistry(registry, config.teamDeclaredByUser);

  const server = new McpServer({
    name: 'sura-elabftw',
    version: '0.2.0',
  });

  registerReadTools(server, registry, config);
  registerWriteTools(server, registry, config);
  if (registry.teams().length > 1) {
    registerFanoutTools(server, registry);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main(): Promise<void> {
  const mode = process.env.MCP_MODE?.trim().toLowerCase() || 'stdio';
  if (mode === 'hosted') {
    const { main: runHosted } = await import('./hosted/server');
    await runHosted();
    return;
  }
  if (mode !== 'stdio') {
    throw new Error(
      `Unknown MCP_MODE: ${mode}. Expected 'stdio' (default) or 'hosted'.`
    );
  }
  await runStdio();
}

main().catch((error) => {
  // biome-ignore lint/suspicious/noConsole: CLI entry point, stderr is appropriate
  console.error('elabftw MCP server failed to start:', error);
  process.exit(1);
});
