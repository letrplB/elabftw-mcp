/**
 * Public library entry for `@sura_ai/elabftw`.
 *
 * Two consumption shapes:
 *
 *   1. Programmatic eLabFTW v2 client (no MCP):
 *
 *      ```ts
 *      import { ElabftwClient } from '@sura_ai/elabftw';
 *      const client = new ElabftwClient({ baseUrl, apiKey });
 *      const me = await client.me();
 *      ```
 *
 *   2. Embed the MCP server in another runtime (e.g. the hosted-mode
 *      HTTP wrapper in `@sura_ai/elabftw-hosted`):
 *
 *      ```ts
 *      import { buildElabMcpServer, loadConfig } from '@sura_ai/elabftw';
 *      const server = buildElabMcpServer(loadConfig());
 *      await server.connect(myTransport);
 *      ```
 *
 * To run the stdio MCP server, invoke the `sura-elabftw-mcp` binary
 * (or `npx @sura_ai/elabftw`) with the env vars documented in the README.
 */

export * from './client';
export type { ElabKeyConfig, ElabMcpConfig, LoadConfigOptions } from './mcp/config';
export { loadConfig } from './mcp/config';
export { ClientRegistry, validateRegistry } from './mcp/clients';
export { buildElabMcpServer } from './mcp/server';
export type { BuildServerOptions } from './mcp/server';
