/**
 * Hosted-mode HTTP server.
 *
 * Architecture: one `McpServer` per registered token, lazily built on
 * first MCP connect. Each MCP protocol session (tracked by
 * `Mcp-Session-Id`) belongs to one token; the existing tools see a
 * `ClientRegistry` constructed from that token's API key only.
 *
 * Routes:
 *   GET  /              → 302 → /register
 *   GET  /register      → registration form
 *   POST /register      → mint token, persist, render personal URL
 *   GET  /healthz       → 200 OK
 *   POST /mcp           → MCP request (initialize or follow-up)
 *   GET  /mcp           → MCP server-sent stream
 *   DELETE /mcp         → close MCP session
 *
 * Auth on `/mcp`: `Authorization: Bearer <token>` is preferred;
 * `?token=<token>` query param is accepted for clients that only take
 * a URL (e.g. Claude Desktop's custom-MCP field).
 */

import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../mcp/config';
import { buildMcpServerForToken } from './runtime';
import { SessionPool } from './sessions';
import { RegistrationStore } from './store';
import {
  renderError,
  renderRegisterForm,
  renderRegisterSuccess,
} from './views';

const MCP_SESSION_HEADER = 'mcp-session-id';
const DEFAULT_REG_PATH = './registrations.json';
const DEFAULT_PORT = 8000;
const DEFAULT_HOST = '0.0.0.0';

interface HostedEnv {
  host: string;
  port: number;
  publicUrl?: string;
  registrationsPath: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
}

function readHostedEnv(): HostedEnv {
  const portRaw = process.env.MCP_PORT?.trim();
  const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`MCP_PORT must be a positive integer ≤ 65535, got: ${portRaw}`);
  }
  return {
    host: process.env.MCP_HOST?.trim() || DEFAULT_HOST,
    port,
    publicUrl: process.env.MCP_PUBLIC_URL?.trim() || undefined,
    registrationsPath:
      process.env.MCP_REGISTRATIONS_PATH?.trim() || DEFAULT_REG_PATH,
    allowedHosts: splitList(process.env.MCP_ALLOWED_HOSTS),
    allowedOrigins: splitList(process.env.MCP_ALLOWED_ORIGINS),
  };
}

function splitList(raw: string | undefined): string[] | undefined {
  if (!raw || !raw.trim()) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pull a registration token from a request: header first (preferred),
 * then `?token=` query string. Returns undefined if neither is set.
 */
function extractToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (m?.[1]) return m[1];
  }
  const q = req.query.token;
  if (typeof q === 'string' && q) return q;
  return undefined;
}

function deriveOrigin(req: Request, fallback?: string): string {
  if (fallback) return fallback.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
  return `${proto}://${host}`;
}

export async function main(): Promise<void> {
  const baseConfig = loadConfig({ requireKeys: false });
  const env = readHostedEnv();
  const store = await RegistrationStore.open(env.registrationsPath);
  const pool = new SessionPool();

  const app = express();
  app.disable('x-powered-by');

  // Trust the first hop (Caddy / similar). Without this, req.protocol
  // and req.ip would reflect the proxy, not the client.
  app.set('trust proxy', 1);

  // Body parsers — applied per-route so we don't pay for them on /mcp,
  // where the MCP SDK consumes the raw stream.
  const jsonBody = express.json({ limit: '4mb' });
  const formBody = express.urlencoded({ extended: false, limit: '64kb' });

  app.get('/healthz', (_req, res) => {
    res.type('text/plain').send('ok');
  });

  app.get('/', (_req, res) => {
    res.redirect(302, '/register');
  });

  app.get('/register', (_req, res) => {
    res.type('html').send(renderRegisterForm(baseConfig.baseUrl));
  });

  app.post('/register', formBody, async (req, res) => {
    const apiKey = (req.body.apiKey as string | undefined)?.trim();
    const baseUrl = (req.body.baseUrl as string | undefined)?.trim();
    const label = (req.body.label as string | undefined)?.trim() || undefined;

    if (!apiKey) {
      res.status(400).type('html').send(renderError('API key is required.'));
      return;
    }
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
      res
        .status(400)
        .type('html')
        .send(renderError('Base URL must be http(s)://… and is required.'));
      return;
    }

    try {
      const reg = await store.create({ apiKey, baseUrl, label });
      const origin = deriveOrigin(req, env.publicUrl);
      const personalUrl = `${origin}/mcp?token=${reg.token}`;
      res.type('html').send(renderRegisterSuccess(personalUrl));
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: server diagnostic
      console.error('[elabftw-mcp] /register failed:', err);
      res
        .status(500)
        .type('html')
        .send(renderError('Failed to persist registration. Check server logs.'));
    }
  });

  // ---- MCP endpoint ----
  // The SDK's StreamableHTTPServerTransport consumes JSON itself; we
  // pre-parse with express.json so it can use the body as `parsedBody`
  // (cheaper than re-reading the request stream).
  const mcpAuth = (req: Request, res: Response, next: NextFunction): void => {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ error: 'Missing bearer token.' });
      return;
    }
    const reg = store.get(token);
    if (!reg) {
      res.status(401).json({ error: 'Unknown token.' });
      return;
    }
    (req as Request & { token: string }).token = token;
    next();
  };

  app.post('/mcp', jsonBody, mcpAuth, async (req, res) => {
    const token = (req as Request & { token: string }).token;
    const reg = store.get(token);
    if (!reg) {
      res.status(401).json({ error: 'Token revoked.' });
      return;
    }

    const sessionId = req.headers[MCP_SESSION_HEADER] as string | undefined;

    if (sessionId) {
      const existing = pool.get(sessionId);
      if (!existing) {
        res
          .status(404)
          .json({ error: `Unknown MCP session: ${sessionId}` });
        return;
      }
      if (existing.token !== token) {
        // Session ID exists but belongs to a different token. Treat as
        // not found rather than leak that the ID is valid.
        res
          .status(404)
          .json({ error: `Unknown MCP session: ${sessionId}` });
        return;
      }
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'No Mcp-Session-Id header and request is not initialize.',
        },
        id: null,
      });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection:
        !!(env.allowedHosts || env.allowedOrigins),
      allowedHosts: env.allowedHosts,
      allowedOrigins: env.allowedOrigins,
      onsessioninitialized: (id) => {
        pool.add({ sessionId: id, token, transport, server });
      },
      onsessionclosed: (id) => {
        pool.remove(id);
      },
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) pool.remove(id);
    };

    const server = buildMcpServerForToken(baseConfig, reg);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    // Best-effort touch — never blocks the response.
    void store.touch(token);
  });

  app.get('/mcp', mcpAuth, async (req, res) => {
    const token = (req as Request & { token: string }).token;
    const sessionId = req.headers[MCP_SESSION_HEADER] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing Mcp-Session-Id header.' });
      return;
    }
    const session = pool.get(sessionId);
    if (!session || session.token !== token) {
      res.status(404).json({ error: `Unknown MCP session: ${sessionId}` });
      return;
    }
    await session.transport.handleRequest(req, res);
  });

  app.delete('/mcp', mcpAuth, async (req, res) => {
    const token = (req as Request & { token: string }).token;
    const sessionId = req.headers[MCP_SESSION_HEADER] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing Mcp-Session-Id header.' });
      return;
    }
    const session = pool.get(sessionId);
    if (!session || session.token !== token) {
      res.status(404).json({ error: `Unknown MCP session: ${sessionId}` });
      return;
    }
    await session.transport.handleRequest(req, res);
  });

  app.use(((err, _req, res, _next) => {
    // biome-ignore lint/suspicious/noConsole: server diagnostic
    console.error('[elabftw-mcp] unhandled:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Internal server error.' });
  }) satisfies express.ErrorRequestHandler);

  const httpServer = app.listen(env.port, env.host, () => {
    // biome-ignore lint/suspicious/noConsole: startup diagnostic
    console.error(
      `[elabftw-mcp] hosted mode listening on http://${env.host}:${env.port}`
    );
    // biome-ignore lint/suspicious/noConsole: startup diagnostic
    console.error(
      `[elabftw-mcp] registration: ${env.publicUrl ?? `http://${env.host}:${env.port}`}/register`
    );
    // biome-ignore lint/suspicious/noConsole: startup diagnostic
    console.error(
      `[elabftw-mcp] registrations file: ${env.registrationsPath} ` +
        `(${store.list().length} loaded)`
    );
  });

  const shutdown = async (signal: string) => {
    // biome-ignore lint/suspicious/noConsole: shutdown diagnostic
    console.error(`[elabftw-mcp] received ${signal}, shutting down`);
    httpServer.close();
    await pool.closeAll();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
