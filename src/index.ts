/**
 * Public library entry for `@sura_ai/elabftw`.
 *
 * Programmatic access to elabftw v2 without running the MCP server:
 *
 * ```ts
 * import { ElabftwClient } from '@sura_ai/elabftw';
 *
 * const client = new ElabftwClient({
 *   baseUrl: 'https://elab.example.com',
 *   apiKey: '3-<rest of your key>',
 * });
 *
 * const me = await client.me();
 * const experiments = await client.list('experiments', { q: 'stöber' });
 * ```
 *
 * To run the MCP server instead, invoke the `sura-elabftw-mcp` binary
 * (or `npx @sura_ai/elabftw`) with the env vars documented in the
 * README.
 */

export * from './client';
