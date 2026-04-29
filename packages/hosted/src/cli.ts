#!/usr/bin/env node
/**
 * @module @sura_ai/elabftw-hosted — CLI entry
 *
 * Hosted-mode HTTP server for the elabftw MCP toolkit. Serves a
 * registration UI, mints per-user bearer tokens, and exposes MCP over
 * Streamable HTTP. Each token gets its own MCP server instance, fully
 * isolated from other tokens.
 *
 * Run via Docker (recommended) or `npx @sura_ai/elabftw-hosted` if the
 * package is published. See README for env-var documentation.
 */

import { main } from './server';

main().catch((error) => {
  // biome-ignore lint/suspicious/noConsole: CLI entry point, stderr is appropriate
  console.error('elabftw-mcp-hosted failed to start:', error);
  process.exit(1);
});
