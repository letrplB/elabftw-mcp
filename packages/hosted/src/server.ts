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
import { ElabftwClient, loadConfig } from '@sura_ai/elabftw';
import { buildMcpServerForToken } from './runtime';
import { SessionPool } from './sessions';
import { openRegistrationStore, type StoreBackend } from './store';
import {
  HIDDEN_KEY_PLACEHOLDER,
  type JustMintedFlash,
  type ManageUser,
  renderError,
  renderJustMinted,
  renderJustMintedEmpty,
  renderJustRevoked,
  renderManageList,
  renderManageLogin,
  renderRegisterForm,
  renderRegisterSuccess,
  renderTeamAdded,
  renderTeamRemoved,
} from './views';

const MCP_SESSION_HEADER = 'mcp-session-id';
const DEFAULT_REG_PATH = './registrations.json';
const DEFAULT_PORT = 8000;
const DEFAULT_HOST = '0.0.0.0';
const AUTH_REALM = 'elabftw-mcp';
const WWW_AUTHENTICATE = `Bearer realm="${AUTH_REALM}"`;

interface HostedEnv {
  host: string;
  port: number;
  publicUrl?: string;
  registrationsPath: string;
  storeBackend: StoreBackend;
  allowedHosts: string[];
  allowedOrigins: string[];
}

/**
 * Resolve the effective DNS-rebind allow-lists.
 *
 *   - `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` win when set.
 *   - Otherwise derive from `MCP_PUBLIC_URL` so a typical deployment is
 *     spec-compliant by default (the spec says servers MUST validate
 *     the Origin header).
 *   - As a last resort, allow the bind address — operators running
 *     locally for testing get a usable default without disabling
 *     protection.
 *
 * Always-allow `127.0.0.1` and `localhost` so the container's own
 * healthcheck (and curl from the host during dev) keeps working.
 */
function resolveAllowLists(
  bindHost: string,
  bindPort: number,
  publicUrl: string | undefined,
  hostsEnv: string | undefined,
  originsEnv: string | undefined
): { hosts: string[]; origins: string[]; warnings: string[] } {
  const warnings: string[] = [];

  const explicitHosts = splitList(hostsEnv);
  const explicitOrigins = splitList(originsEnv);

  let publicHost: string | undefined;
  let publicOrigin: string | undefined;
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      publicHost = u.host;
      publicOrigin = u.origin;
    } catch {
      warnings.push(`Could not parse MCP_PUBLIC_URL=${publicUrl}; ignoring.`);
    }
  }

  const localHostFallbacks =
    bindHost === '0.0.0.0' || bindHost === '::'
      ? [`127.0.0.1:${bindPort}`, `localhost:${bindPort}`]
      : [`${bindHost}:${bindPort}`];

  const hosts = explicitHosts ?? [
    ...(publicHost ? [publicHost] : []),
    ...localHostFallbacks,
  ];

  const origins = explicitOrigins ?? [
    ...(publicOrigin ? [publicOrigin] : []),
    ...localHostFallbacks.map((h) => `http://${h}`),
    ...localHostFallbacks.map((h) => `https://${h}`),
  ];

  if (!explicitHosts && !publicHost) {
    warnings.push(
      'No MCP_PUBLIC_URL or MCP_ALLOWED_HOSTS configured — DNS rebinding ' +
        'protection falls back to the bind address only. Set MCP_PUBLIC_URL ' +
        '(recommended) or MCP_ALLOWED_HOSTS for production.'
    );
  }

  return { hosts, origins, warnings };
}

function readHostedEnv(): HostedEnv {
  const portRaw = process.env.MCP_PORT?.trim();
  const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`MCP_PORT must be a positive integer ≤ 65535, got: ${portRaw}`);
  }
  const host = process.env.MCP_HOST?.trim() || DEFAULT_HOST;
  const publicUrl = process.env.MCP_PUBLIC_URL?.trim() || undefined;
  const { hosts, origins, warnings } = resolveAllowLists(
    host,
    port,
    publicUrl,
    process.env.MCP_ALLOWED_HOSTS,
    process.env.MCP_ALLOWED_ORIGINS
  );
  for (const w of warnings) {
    // biome-ignore lint/suspicious/noConsole: startup diagnostic
    console.error(`[elabftw-mcp] ${w}`);
  }
  const backendRaw = process.env.MCP_STORE_BACKEND?.trim().toLowerCase();
  let storeBackend: StoreBackend;
  if (!backendRaw || backendRaw === 'json') {
    storeBackend = 'json';
  } else if (backendRaw === 'sqlite') {
    storeBackend = 'sqlite';
  } else {
    throw new Error(
      `MCP_STORE_BACKEND must be 'json' or 'sqlite', got: ${backendRaw}`
    );
  }
  return {
    host,
    port,
    publicUrl,
    registrationsPath:
      process.env.MCP_REGISTRATIONS_PATH?.trim() || DEFAULT_REG_PATH,
    storeBackend,
    allowedHosts: hosts,
    allowedOrigins: origins,
  };
}

function splitList(raw: string | undefined): string[] | undefined {
  if (!raw || !raw.trim()) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

interface ExtractedToken {
  token: string;
  source: 'header' | 'query';
}

/**
 * Pull a registration token from a request: `Authorization: Bearer …`
 * header preferred, then `?token=` query string as a fallback for
 * clients (e.g. older Claude Desktop builds) that only accept a URL.
 *
 * Query-string secrets leak via access logs, browser history, and
 * referrer headers. Callers that hit the query path get a
 * `Deprecation` header on the response.
 */
function extractToken(req: Request): ExtractedToken | undefined {
  const auth = req.headers.authorization;
  if (auth) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (m?.[1]) return { token: m[1], source: 'header' };
  }
  const q = req.query.token;
  if (typeof q === 'string' && q) return { token: q, source: 'query' };
  return undefined;
}

/**
 * Send a 401 with a spec-compliant `WWW-Authenticate` challenge, so
 * MCP clients can discover the auth scheme.
 */
function send401(
  res: Response,
  message: string,
  errorCode?: string
): void {
  const challenge = errorCode
    ? `${WWW_AUTHENTICATE}, error="${errorCode}"`
    : WWW_AUTHENTICATE;
  res.set('WWW-Authenticate', challenge);
  res.status(401).json({ error: message });
}

function deriveOrigin(req: Request, fallback?: string): string {
  if (fallback) return fallback.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
  return `${proto}://${host}`;
}

interface ProbeResult {
  userid: number;
  team: number;
  user: ManageUser;
}

/**
 * Validate an eLabFTW API key by calling `/users/me` and pull the bits
 * we need (userid, team, friendly name). Throws with a human-readable
 * message on any failure — caller renders the error page.
 *
 * Used by /register (mint a fresh token under this user) and by every
 * /manage action (the eLabFTW key *is* the auth credential for the
 * manage page; we re-probe it on every request rather than carrying a
 * session cookie).
 */
async function probeAndAuth(
  apiKey: string,
  baseUrl: string,
  userAgent: string | undefined,
  timeoutMs: number | undefined
): Promise<ProbeResult> {
  const probe = new ElabftwClient({
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    userAgent,
    timeoutMs,
  });
  const me = await probe.me();
  if (!me.userid || !Number.isFinite(me.userid) || me.userid <= 0) {
    throw new Error(
      `eLabFTW returned no usable user id for this key. me.userid=${String(me.userid)}.`
    );
  }
  if (!me.team || !Number.isFinite(me.team) || me.team <= 0) {
    throw new Error(
      `eLabFTW returned no usable team for this key. me.team=${String(me.team)}.`
    );
  }
  return {
    userid: me.userid,
    team: me.team,
    user: {
      userid: me.userid,
      fullname: me.fullname,
      email: me.email,
    },
  };
}

/**
 * Per-IP sliding-window rate limiter for /manage POSTs. In-memory only;
 * resets on process restart. eLabFTW's own API rate-limits failed key
 * lookups, so this is belt-and-braces.
 */
class RateLimiter {
  private readonly windowMs: number;
  private readonly limit: number;
  private readonly hits = new Map<string, number[]>();

  constructor(windowMs: number, limit: number) {
    this.windowMs = windowMs;
    this.limit = limit;
  }

  check(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const record = this.hits.get(key) ?? [];
    const recent = record.filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

const FLASH_MINT_COOKIE = 'mcp_just_minted';
const FLASH_REVOKE_COOKIE = 'mcp_just_revoked';
const FLASH_TEAM_ADDED_COOKIE = 'mcp_team_added';
const FLASH_TEAM_REMOVED_COOKIE = 'mcp_team_removed';
const FLASH_MAX_AGE_S = 120;

/**
 * Parse Cookie request header into a flat record. Tiny, dep-free —
 * we only ever read two cookies, both server-set and JSON-encoded.
 */
function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (name) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        // ignore malformed cookies
      }
    }
  }
  return out;
}

/**
 * Set a one-shot HttpOnly flash cookie. Scoped to /manage so it never
 * leaks onto /mcp or /register. Marked Secure when the request came
 * over https (works behind Caddy / Coolify Traefik via the
 * `trust proxy` setting + `x-forwarded-proto`).
 */
function setFlashCookie(
  res: Response,
  req: Request,
  name: string,
  value: object
): void {
  res.cookie(name, JSON.stringify(value), {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    path: '/manage',
    maxAge: FLASH_MAX_AGE_S * 1000,
  });
}

/**
 * Clear a flash cookie unconditionally. Cookies are read once and
 * burned — refreshing the success page after that shows an empty
 * state, never a duplicate action.
 */
function clearFlashCookie(res: Response, name: string): void {
  res.clearCookie(name, { path: '/manage' });
}

/**
 * Parse a checkbox value from a form POST. HTML checkboxes only send
 * a value when checked, so an absent field means false. Common
 * truthy strings ("on" — the default checkbox value, "true", "1",
 * "yes") all map to true.
 */
function parseCheckbox(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  return v === 'on' || v === 'true' || v === '1' || v === 'yes';
}

/**
 * Replace the hidden-key placeholder in rendered HTML with the real
 * eLabFTW API key. Centralised here so views never see the key — they
 * emit the marker, the route fills it in.
 */
function injectHiddenKey(html: string, apiKey: string): string {
  // Escape the same way views.escape does — the hidden input is inside
  // a value="…" attribute.
  const escaped = apiKey
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return html.replaceAll(HIDDEN_KEY_PLACEHOLDER, escaped);
}

export async function main(): Promise<void> {
  const baseConfig = loadConfig({ requireKeys: false });
  const env = readHostedEnv();
  const store = await openRegistrationStore({
    path: env.registrationsPath,
    backend: env.storeBackend,
  });
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

    // Validate the key by calling /users/me before minting a token.
    // Catches typos, revoked keys, and instance-mismatch up front;
    // also resolves the user + team ids so list responses aren't
    // silently filtered to an empty set, and so the manage page can
    // recognise this user even after their eLabFTW key rotates.
    let probe: ProbeResult;
    try {
      probe = await probeAndAuth(
        apiKey,
        baseUrl,
        baseConfig.userAgent,
        baseConfig.timeoutMs
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res
        .status(400)
        .type('html')
        .send(
          renderError(
            `Could not validate API key against ${baseUrl}: ${msg}. ` +
              `Check the key, base URL, and that this server can reach the instance.`
          )
        );
      return;
    }

    const allowWrites = parseCheckbox(req.body.allowWrites);
    const rawDestructive = parseCheckbox(req.body.allowDestructive);
    // allowDestructive requires allowWrites — UI tries to enforce
    // this with disabled-when-unchecked logic but we belt-and-braces
    // it server-side too.
    const allowDestructive = rawDestructive && allowWrites;
    const revealUserIdentities = parseCheckbox(req.body.revealUserIdentities);

    try {
      const reg = await store.create({
        apiKey,
        baseUrl,
        userid: probe.userid,
        team: probe.team,
        label,
        allowWrites,
        allowDestructive,
        revealUserIdentities,
      });
      const origin = deriveOrigin(req, env.publicUrl);
      const personalUrl = `${origin}/mcp?token=${reg.token}`;
      const bearerUrl = `${origin}/mcp`;
      res
        .type('html')
        .send(renderRegisterSuccess(personalUrl, bearerUrl, reg.token));
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: server diagnostic
      console.error('[elabftw-mcp] /register failed:', err);
      res
        .status(500)
        .type('html')
        .send(renderError('Failed to persist registration. Check server logs.'));
    }
  });

  // ---- /manage — self-service token management ----
  // Auth model: every action submits the eLabFTW API key, which we
  // re-probe via /users/me. No session cookies, no CSRF token plumbing.
  // Tokens are scoped by (userid, baseUrl) so cross-instance / cross-
  // user leakage is impossible from this surface.
  const manageLimiter = new RateLimiter(60_000, 10);

  function rateLimitOrFail(req: Request, res: Response): boolean {
    const key = req.ip ?? 'unknown';
    if (!manageLimiter.check(key)) {
      res
        .status(429)
        .type('html')
        .send(
          renderError(
            'Too many attempts from this address. Wait a minute and try again.'
          )
        );
      return false;
    }
    return true;
  }

  app.get('/manage', (_req, res) => {
    res.type('html').send(renderManageLogin(baseConfig.baseUrl));
  });

  app.post('/manage', formBody, async (req, res) => {
    if (!rateLimitOrFail(req, res)) return;
    const apiKey = (req.body.apiKey as string | undefined)?.trim();
    const baseUrl = (req.body.baseUrl as string | undefined)?.trim();
    if (!apiKey || !baseUrl) {
      res
        .status(400)
        .type('html')
        .send(
          renderManageLogin(
            baseConfig.baseUrl,
            'Both API key and base URL are required.'
          )
        );
      return;
    }

    let probe: ProbeResult;
    try {
      probe = await probeAndAuth(
        apiKey,
        baseUrl,
        baseConfig.userAgent,
        baseConfig.timeoutMs
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res
        .status(401)
        .type('html')
        .send(renderManageLogin(baseConfig.baseUrl, msg));
      return;
    }

    const tokens = store.listForUser(probe.userid, baseUrl);
    const html = renderManageList(baseUrl.replace(/\/+$/, ''), probe.user, tokens);
    res.type('html').send(injectHiddenKey(html, apiKey));
  });

  app.post('/manage/revoke', formBody, async (req, res) => {
    if (!rateLimitOrFail(req, res)) return;
    const apiKey = (req.body.apiKey as string | undefined)?.trim();
    const baseUrl = (req.body.baseUrl as string | undefined)?.trim();
    const token = (req.body.token as string | undefined)?.trim();
    if (!apiKey || !baseUrl || !token) {
      res
        .status(400)
        .type('html')
        .send(renderError('Missing fields on revoke form.'));
      return;
    }

    let probe: ProbeResult;
    try {
      probe = await probeAndAuth(
        apiKey,
        baseUrl,
        baseConfig.userAgent,
        baseConfig.timeoutMs
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res
        .status(401)
        .type('html')
        .send(renderManageLogin(baseConfig.baseUrl, msg));
      return;
    }

    const target = store.get(token);
    const labelForFlash = target?.label ?? `${token.slice(0, 8)}…`;
    await store.revokeForUser(probe.userid, baseUrl, token);

    // Drop any live MCP sessions that belonged to this token so
    // in-flight tool calls fail closed.
    pool.closeForToken(token);

    setFlashCookie(res, req, FLASH_REVOKE_COOKIE, { label: labelForFlash });
    res.redirect(303, '/manage/revoked');
  });

  app.post('/manage/mint', formBody, async (req, res) => {
    if (!rateLimitOrFail(req, res)) return;
    const apiKey = (req.body.apiKey as string | undefined)?.trim();
    const baseUrl = (req.body.baseUrl as string | undefined)?.trim();
    const label = (req.body.label as string | undefined)?.trim() || undefined;
    if (!apiKey || !baseUrl) {
      res
        .status(400)
        .type('html')
        .send(renderError('Missing fields on mint form.'));
      return;
    }

    let probe: ProbeResult;
    try {
      probe = await probeAndAuth(
        apiKey,
        baseUrl,
        baseConfig.userAgent,
        baseConfig.timeoutMs
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res
        .status(401)
        .type('html')
        .send(renderManageLogin(baseConfig.baseUrl, msg));
      return;
    }

    const allowWrites = parseCheckbox(req.body.allowWrites);
    const allowDestructive =
      parseCheckbox(req.body.allowDestructive) && allowWrites;
    const revealUserIdentities = parseCheckbox(req.body.revealUserIdentities);

    const reg = await store.create({
      apiKey,
      baseUrl,
      userid: probe.userid,
      team: probe.team,
      label,
      allowWrites,
      allowDestructive,
      revealUserIdentities,
    });
    const origin = deriveOrigin(req, env.publicUrl);
    const flash: JustMintedFlash = {
      personalUrl: `${origin}/mcp?token=${reg.token}`,
      bearerUrl: `${origin}/mcp`,
      token: reg.token,
      label: reg.label,
    };
    setFlashCookie(res, req, FLASH_MINT_COOKIE, flash);
    res.redirect(303, '/manage/minted');
  });

  // ---- /manage/add-team ----
  // Append another (apiKey, team) pair to an existing token. The
  // session apiKey authenticates the action; the new key is probed
  // separately and rejected unless it resolves to the same `userid`.
  app.post('/manage/add-team', formBody, async (req, res) => {
    if (!rateLimitOrFail(req, res)) return;
    const apiKey = (req.body.apiKey as string | undefined)?.trim();
    const baseUrl = (req.body.baseUrl as string | undefined)?.trim();
    const token = (req.body.token as string | undefined)?.trim();
    const newApiKey = (req.body.newApiKey as string | undefined)?.trim();
    const keyLabel =
      (req.body.keyLabel as string | undefined)?.trim() || undefined;
    if (!apiKey || !baseUrl || !token || !newApiKey) {
      res
        .status(400)
        .type('html')
        .send(renderError('Missing fields on add-team form.'));
      return;
    }

    let auth: ProbeResult;
    try {
      auth = await probeAndAuth(
        apiKey,
        baseUrl,
        baseConfig.userAgent,
        baseConfig.timeoutMs
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res
        .status(401)
        .type('html')
        .send(renderManageLogin(baseConfig.baseUrl, msg));
      return;
    }

    const target = store.get(token);
    if (
      !target ||
      target.userid !== auth.userid ||
      target.baseUrl !== baseUrl.replace(/\/+$/, '')
    ) {
      res
        .status(404)
        .type('html')
        .send(renderError('Token not found under this user / base URL.'));
      return;
    }

    let newKeyProbe: ProbeResult;
    try {
      newKeyProbe = await probeAndAuth(
        newApiKey,
        baseUrl,
        baseConfig.userAgent,
        baseConfig.timeoutMs
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res
        .status(400)
        .type('html')
        .send(
          renderError(
            `Could not validate the new API key: ${msg}. The token was not changed.`
          )
        );
      return;
    }

    if (newKeyProbe.userid !== auth.userid) {
      res
        .status(400)
        .type('html')
        .send(
          renderError(
            `The new key resolves to a different eLabFTW user (userid ` +
              `${newKeyProbe.userid}) than this token (${auth.userid}). ` +
              `Tokens cannot mix identities — pick a key from your own account.`
          )
        );
      return;
    }

    if (target.keys.some((k) => k.team === newKeyProbe.team)) {
      res
        .status(400)
        .type('html')
        .send(
          renderError(
            `This token already covers team ${newKeyProbe.team}. ` +
              `Adding another key for the same team is a no-op.`
          )
        );
      return;
    }

    await store.addKey(auth.userid, baseUrl, {
      token,
      apiKey: newApiKey,
      team: newKeyProbe.team,
      label: keyLabel,
    });

    // Drop live MCP sessions for this token so the next connect
    // picks up the new ClientRegistry with the additional team.
    pool.closeForToken(token);

    setFlashCookie(res, req, FLASH_TEAM_ADDED_COOKIE, {
      tokenLabel: target.label ?? `${token.slice(0, 8)}…`,
      team: newKeyProbe.team,
    });
    res.redirect(303, '/manage/team-added');
  });

  app.get('/manage/team-added', (req, res) => {
    const cookies = parseCookies(req);
    const raw = cookies[FLASH_TEAM_ADDED_COOKIE];
    clearFlashCookie(res, FLASH_TEAM_ADDED_COOKIE);
    if (!raw) {
      res.redirect(302, '/manage');
      return;
    }
    try {
      const flash = JSON.parse(raw) as { tokenLabel: string; team: number };
      res
        .type('html')
        .send(renderTeamAdded(flash.tokenLabel ?? 'token', flash.team));
    } catch {
      res.redirect(302, '/manage');
    }
  });

  // ---- /manage/remove-team ----
  app.post('/manage/remove-team', formBody, async (req, res) => {
    if (!rateLimitOrFail(req, res)) return;
    const apiKey = (req.body.apiKey as string | undefined)?.trim();
    const baseUrl = (req.body.baseUrl as string | undefined)?.trim();
    const token = (req.body.token as string | undefined)?.trim();
    const teamRaw = (req.body.team as string | undefined)?.trim();
    const team = teamRaw ? Number.parseInt(teamRaw, 10) : Number.NaN;
    if (!apiKey || !baseUrl || !token || !Number.isFinite(team)) {
      res
        .status(400)
        .type('html')
        .send(renderError('Missing fields on remove-team form.'));
      return;
    }

    let auth: ProbeResult;
    try {
      auth = await probeAndAuth(
        apiKey,
        baseUrl,
        baseConfig.userAgent,
        baseConfig.timeoutMs
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res
        .status(401)
        .type('html')
        .send(renderManageLogin(baseConfig.baseUrl, msg));
      return;
    }

    const target = store.get(token);
    if (
      !target ||
      target.userid !== auth.userid ||
      target.baseUrl !== baseUrl.replace(/\/+$/, '')
    ) {
      res
        .status(404)
        .type('html')
        .send(renderError('Token not found under this user / base URL.'));
      return;
    }
    if (target.keys.length <= 1) {
      res
        .status(400)
        .type('html')
        .send(
          renderError(
            'A token must keep at least one team. Use revoke if you want to delete the whole token.'
          )
        );
      return;
    }
    if (!target.keys.some((k) => k.team === team)) {
      res
        .status(400)
        .type('html')
        .send(renderError(`Team ${team} is not on this token.`));
      return;
    }

    await store.removeKey(auth.userid, baseUrl, token, team);
    pool.closeForToken(token);

    setFlashCookie(res, req, FLASH_TEAM_REMOVED_COOKIE, {
      tokenLabel: target.label ?? `${token.slice(0, 8)}…`,
      team,
    });
    res.redirect(303, '/manage/team-removed');
  });

  app.get('/manage/team-removed', (req, res) => {
    const cookies = parseCookies(req);
    const raw = cookies[FLASH_TEAM_REMOVED_COOKIE];
    clearFlashCookie(res, FLASH_TEAM_REMOVED_COOKIE);
    if (!raw) {
      res.redirect(302, '/manage');
      return;
    }
    try {
      const flash = JSON.parse(raw) as { tokenLabel: string; team: number };
      res
        .type('html')
        .send(renderTeamRemoved(flash.tokenLabel ?? 'token', flash.team));
    } catch {
      res.redirect(302, '/manage');
    }
  });

  app.get('/manage/minted', (req, res) => {
    const cookies = parseCookies(req);
    const raw = cookies[FLASH_MINT_COOKIE];
    clearFlashCookie(res, FLASH_MINT_COOKIE);
    if (!raw) {
      res.type('html').send(renderJustMintedEmpty());
      return;
    }
    let flash: JustMintedFlash;
    try {
      flash = JSON.parse(raw) as JustMintedFlash;
    } catch {
      res.type('html').send(renderJustMintedEmpty());
      return;
    }
    res.type('html').send(renderJustMinted(flash));
  });

  app.get('/manage/revoked', (req, res) => {
    const cookies = parseCookies(req);
    const raw = cookies[FLASH_REVOKE_COOKIE];
    clearFlashCookie(res, FLASH_REVOKE_COOKIE);
    if (!raw) {
      res.redirect(302, '/manage');
      return;
    }
    try {
      const flash = JSON.parse(raw) as { label: string };
      res.type('html').send(renderJustRevoked(flash.label ?? 'token'));
    } catch {
      res.redirect(302, '/manage');
    }
  });

  // ---- MCP endpoint ----
  // The SDK's StreamableHTTPServerTransport consumes JSON itself; we
  // pre-parse with express.json so it can use the body as `parsedBody`
  // (cheaper than re-reading the request stream).
  const mcpAuth = (req: Request, res: Response, next: NextFunction): void => {
    const extracted = extractToken(req);
    if (!extracted) {
      send401(res, 'Missing bearer token.', 'invalid_request');
      return;
    }
    const reg = store.get(extracted.token);
    if (!reg) {
      send401(res, 'Unknown token.', 'invalid_token');
      return;
    }
    if (extracted.source === 'query') {
      // RFC 8594 — signal that this auth path is deprecated. Header
      // is unconditional so clients see it on every reply.
      res.set('Deprecation', 'true');
      res.set(
        'Link',
        '<https://datatracker.ietf.org/doc/html/rfc6750#section-2.1>; rel="successor-version"'
      );
    }
    (req as Request & { token: string }).token = extracted.token;
    next();
  };

  app.post('/mcp', jsonBody, mcpAuth, async (req, res) => {
    const token = (req as Request & { token: string }).token;
    const reg = store.get(token);
    if (!reg) {
      send401(res, 'Token revoked.', 'invalid_token');
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
      // Spec: "Servers MUST validate the Origin header on all incoming
      // connections to prevent DNS rebinding attacks." Always on; the
      // allow-lists carry sensible defaults derived from MCP_PUBLIC_URL.
      enableDnsRebindingProtection: true,
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
    // biome-ignore lint/suspicious/noConsole: startup diagnostic
    console.error(
      `[elabftw-mcp] DNS rebinding protection: hosts=[${env.allowedHosts.join(
        ', '
      )}] origins=[${env.allowedOrigins.join(', ')}]`
    );
  });

  const shutdown = async (signal: string) => {
    // biome-ignore lint/suspicious/noConsole: shutdown diagnostic
    console.error(`[elabftw-mcp] received ${signal}, shutting down`);
    httpServer.close();
    await pool.closeAll();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
