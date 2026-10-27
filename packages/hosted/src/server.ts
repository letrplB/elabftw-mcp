/**
 * Hosted-mode HTTP server.
 *
 * Architecture: one `McpServer` per MCP protocol session (tracked by
 * `Mcp-Session-Id`), each bound to one registered token; the tools see
 * a `ClientRegistry` constructed from that token's API keys only.
 *
 * Routes:
 *   GET  /                  → 302 → /register
 *   GET  /register          → registration form
 *   POST /register          → mint token, persist, render personal URL (once)
 *   GET  /manage            → login form, or token list when logged in
 *   POST /manage            → log in with an eLabFTW API key (one probe)
 *   POST /manage/{mint,edit,revoke,add-team,remove-team,logout}
 *                           → session + CSRF protected actions (PRG)
 *   GET  /manage/{minted,edited,revoked,team-added,team-removed}
 *                           → one-shot result pages
 *   GET  /healthz           → 200 OK
 *   POST /mcp               → MCP request (initialize or follow-up)
 *   GET  /mcp               → MCP server-sent stream
 *   DELETE /mcp             → close MCP session
 *
 * Auth on `/mcp`: `Authorization: Bearer <token>` is preferred;
 * `?token=<token>` query param is accepted for clients that only take
 * a URL (e.g. Claude Desktop's custom-MCP field). Tokens are looked up
 * by `sha256(token)` — the store never holds the token itself.
 *
 * Only eLabFTW instances on the operator's allow-list
 * (`MCP_ALLOWED_BASE_URLS` / `ELABFTW_BASE_URL`) are ever contacted.
 */

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ElabftwApiError, ElabftwClient, loadConfig } from '@sura_ai/elabftw';
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { readHostedEnv } from './env';
import { hostOriginGuard, htmlSecurityHeaders, RateLimiter } from './guards';
import {
  type ManageSession,
  ManageSessionStore,
  clearSessionCookie,
  csrfMatches,
  setSessionCookie,
  takeFlash,
} from './manage-sessions';
import { buildMcpServerForToken } from './runtime';
import { SessionPool } from './sessions';
import {
  type Registration,
  TokenLimitError,
  canonicaliseBaseUrl,
  normaliseBaseUrl,
  openRegistrationStore,
  tokenIdOf,
} from './store';
import { hashToken, loadStoreKey } from './store/crypto';
import {
  type ManageUser,
  type PermissionCaps,
  renderError,
  renderJustMinted,
  renderJustMintedEmpty,
  renderJustRevoked,
  renderManageEdited,
  renderManageList,
  renderManageLogin,
  renderRegisterForm,
  renderRegisterSuccess,
  renderTeamAdded,
  renderTeamRemoved,
} from './views';

const MCP_SESSION_HEADER = 'mcp-session-id';
const AUTH_REALM = 'elabftw-mcp';
const WWW_AUTHENTICATE = `Bearer realm="${AUTH_REALM}"`;
const MANAGE_IDLE_MS = 30 * 60_000;
const MCP_IDLE_MS = 30 * 60_000;
const MAX_LABEL_LENGTH = 200;
const BACK_TO_MANAGE = { href: '/manage', label: 'Back to manage' };

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
function send401(res: Response, message: string, errorCode?: string): void {
  const challenge = errorCode
    ? `${WWW_AUTHENTICATE}, error="${errorCode}"`
    : WWW_AUTHENTICATE;
  res.set('WWW-Authenticate', challenge);
  res.status(401).json({ error: message });
}

interface ProbeResult {
  userid: number;
  team: number;
  user: ManageUser;
}

/**
 * Probe failure safe to show in the browser. The detailed cause goes
 * to the server log only — echoing upstream errors back would turn
 * /register into an oracle for whatever the base URL points at.
 */
class ProbeError extends Error {
  constructor(
    readonly publicMessage: string,
    readonly status: 401 | 502
  ) {
    super(publicMessage);
    this.name = 'ProbeError';
  }
}

/**
 * Validate an eLabFTW API key by calling `/users/me` and pull the bits
 * we need (userid, team, friendly name). `baseUrl` must already be a
 * member of the allow-list. Throws `ProbeError` on any failure.
 *
 * Used by /register (mint a fresh token under this user), by the
 * /manage login, and by /manage/add-team (validate the extra key).
 */
async function probeAndAuth(
  apiKey: string,
  baseUrl: string,
  userAgent: string | undefined,
  timeoutMs: number | undefined
): Promise<ProbeResult> {
  let me: Awaited<ReturnType<ElabftwClient['me']>>;
  try {
    me = await new ElabftwClient({ baseUrl, apiKey, userAgent, timeoutMs }).me();
  } catch (err) {
    const status = err instanceof ElabftwApiError ? err.statusCode : undefined;
    const body = err instanceof ElabftwApiError && err.body ? ` — ${err.body.slice(0, 300)}` : '';
    // biome-ignore lint/suspicious/noConsole: server diagnostic (never includes the key)
    console.error(
      `[elabftw-mcp] /users/me probe against ${baseUrl} failed: ${
        err instanceof Error ? err.message : String(err)
      }${body}`
    );
    if (status === 401 || status === 403) {
      throw new ProbeError(`eLabFTW at ${baseUrl} rejected this API key.`, 401);
    }
    throw new ProbeError(`Could not verify this API key against ${baseUrl}.`, 502);
  }
  if (!me.userid || !Number.isFinite(me.userid) || me.userid <= 0 || !me.team || !Number.isFinite(me.team) || me.team <= 0) {
    // biome-ignore lint/suspicious/noConsole: server diagnostic
    console.error(
      `[elabftw-mcp] /users/me against ${baseUrl} returned no usable ` +
        `userid/team (userid=${String(me.userid)}, team=${String(me.team)}).`
    );
    throw new ProbeError(`Could not verify this API key against ${baseUrl}.`, 502);
  }
  return {
    userid: me.userid,
    team: me.team,
    user: { userid: me.userid, fullname: me.fullname, email: me.email },
  };
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

/** Trimmed, length-capped optional text field; empty → undefined. */
function optText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().slice(0, MAX_LABEL_LENGTH);
  return t || undefined;
}

function reqText(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function displayLabel(reg: Registration): string {
  return reg.label ?? `id ${tokenIdOf(reg.tokenHash)}`;
}

/** Human-readable diff for the /manage/edited page. */
function describeChanges(before: Registration, after: Registration): string[] {
  const changes: string[] = [];
  if (before.label !== after.label) {
    changes.push(
      after.label
        ? `label set to "${after.label}"`
        : before.label
          ? `label cleared (was "${before.label}")`
          : 'label cleared'
    );
  }
  const flags: string[] = [];
  if (before.allowWrites !== after.allowWrites)
    flags.push(`writes ${after.allowWrites ? 'on' : 'off'}`);
  if (before.allowDestructive !== after.allowDestructive)
    flags.push(`destructive ${after.allowDestructive ? 'on' : 'off'}`);
  if (before.revealUserIdentities !== after.revealUserIdentities)
    flags.push(`reveal-names ${after.revealUserIdentities ? 'on' : 'off'}`);
  if (flags.length) changes.push(`flags: ${flags.join(', ')}`);
  if (before.defaultTeam !== after.defaultTeam)
    changes.push(`default team → ${after.defaultTeam}`);
  return changes;
}

/** Typed access to what the /manage and /mcp middleware attach. */
interface ManageLocals {
  manage: ManageSession;
  target: Registration;
}
interface McpLocals {
  tokenHash: string;
  registration: Registration;
}
function manageLocals(res: Response): ManageLocals {
  return res.locals as ManageLocals;
}
function mcpLocals(res: Response): McpLocals {
  return res.locals as McpLocals;
}

export async function main(): Promise<void> {
  // Everything this process creates (store, SQLite -wal/-shm, key file,
  // tmp files) is private to the service user.
  process.umask(0o077);

  const env = readHostedEnv();
  // The toolkit's loadConfig insists on ELABFTW_BASE_URL. It's only a
  // default here (every token carries its own base URL), so fill it in
  // from the allow-list when the operator only set MCP_ALLOWED_BASE_URLS.
  if (!process.env.ELABFTW_BASE_URL?.trim()) {
    process.env.ELABFTW_BASE_URL = env.allowedBaseUrls[0];
  }
  const baseConfig = loadConfig({ requireKeys: false });
  const caps: PermissionCaps = {
    allowWrites: baseConfig.allowWrites,
    allowDestructive: baseConfig.allowWrites && baseConfig.allowDestructive,
    revealUserIdentities: baseConfig.revealUserIdentities,
  };
  const allowedBaseUrls = new Set(env.allowedBaseUrls);

  const storePath = resolve(env.registrationsPath);
  await mkdir(dirname(storePath), { recursive: true, mode: 0o700 });
  const secrets = await loadStoreKey(storePath, env.storeKey);
  const store = await openRegistrationStore({
    path: storePath,
    backend: env.storeBackend,
    secrets,
  });
  const pool = new SessionPool({
    maxPerToken: env.maxSessionsPerToken,
    maxTotal: env.maxSessions,
    idleMs: MCP_IDLE_MS,
  });
  const manageSessions = new ManageSessionStore({
    idleMs: MANAGE_IDLE_MS,
    maxSessions: 10_000,
  });

  const probe = (apiKey: string, baseUrl: string) =>
    probeAndAuth(apiKey, baseUrl, baseConfig.userAgent, baseConfig.timeoutMs);

  /**
   * Map a submitted base URL onto the allow-list. With a single allowed
   * instance the form omits the field and we fill it in; anything not
   * on the list (after canonicalisation) is refused.
   */
  const resolveBaseUrl = (raw: unknown): string | undefined => {
    if (raw === undefined || raw === '') {
      return env.allowedBaseUrls.length === 1 ? env.allowedBaseUrls[0] : undefined;
    }
    if (typeof raw !== 'string') return undefined;
    try {
      const canonical = canonicaliseBaseUrl(raw);
      return allowedBaseUrls.has(canonical) ? canonical : undefined;
    } catch {
      return undefined;
    }
  };

  const publicOrigin = (req: Request): string =>
    env.publicUrl
      ? env.publicUrl.replace(/\/+$/, '')
      : // Host was already checked against the allow-list by the guard.
        `${req.protocol}://${req.headers.host}`;

  const app = express();
  app.disable('x-powered-by');

  // Trust N proxy hops (Caddy / Traefik / …) for req.ip, req.protocol,
  // and req.secure. Configure with MCP_TRUST_PROXY; 0 = direct exposure.
  app.set('trust proxy', env.trustProxy);

  // Body parsers — applied per-route. On /mcp the JSON parser runs only
  // after bearer auth, so unauthenticated callers can't make us buffer
  // and parse 4 MB bodies.
  const jsonBody = express.json({ limit: '4mb' });
  // Express 5's urlencoded middleware leaves req.body undefined when
  // the request's Content-Type doesn't match application/x-www-form-
  // urlencoded. Wrap it so req.body is always at least {} afterwards.
  const urlencoded = express.urlencoded({ extended: false, limit: '64kb' });
  const formBody: RequestHandler = (req, res, next) => {
    urlencoded(req, res, (err?: unknown) => {
      if (err) return next(err as Error);
      if (!req.body || typeof req.body !== 'object') req.body = {};
      next();
    });
  };

  // Probe-backed endpoints (each hit costs an eLabFTW round trip) get a
  // tight per-IP budget; session-authenticated actions a looser one.
  const probeLimiter = new RateLimiter(60_000, 10);
  const actionLimiter = new RateLimiter(60_000, 60);
  const limit =
    (limiter: RateLimiter): RequestHandler =>
    (req, res, next) => {
      if (limiter.check(req.ip ?? 'unknown')) return next();
      res
        .status(429)
        .type('html')
        .send(renderError('Too many attempts from this address. Wait a minute and try again.'));
    };

  app.get('/healthz', (_req, res) => {
    res.type('text/plain').send('ok');
  });

  app.get('/', (_req, res) => {
    res.redirect(302, '/register');
  });

  const guard = hostOriginGuard(env.allowedHosts, env.allowedOrigins);
  app.use(['/register', '/manage'], guard, htmlSecurityHeaders);
  app.use('/mcp', guard);

  app.get('/register', (_req, res) => {
    res.type('html').send(renderRegisterForm(env.allowedBaseUrls, caps));
  });

  app.post('/register', limit(probeLimiter), formBody, async (req, res) => {
    const apiKey = reqText(req.body.apiKey);
    const baseUrl = resolveBaseUrl(req.body.baseUrl);
    const label = optText(req.body.label);

    if (!apiKey) {
      res.status(400).type('html').send(renderError('API key is required.'));
      return;
    }
    if (!baseUrl) {
      res
        .status(400)
        .type('html')
        .send(renderError('That eLabFTW instance is not served by this MCP server.'));
      return;
    }

    // Validate the key by calling /users/me before minting a token.
    // Catches typos and revoked keys up front; also resolves the user +
    // team ids so the manage page can recognise this user even after
    // their eLabFTW key rotates.
    let who: ProbeResult;
    try {
      who = await probe(apiKey, baseUrl);
    } catch (err) {
      const pe = err instanceof ProbeError ? err : new ProbeError('Could not verify this API key.', 502);
      res.status(pe.status).type('html').send(renderError(pe.publicMessage));
      return;
    }

    // allowDestructive requires allowWrites — the UI enforces it with
    // disabled-when-unchecked logic, the store enforces it again.
    const allowWrites = caps.allowWrites && parseCheckbox(req.body.allowWrites);
    try {
      const { registration, token } = await store.create({
        apiKey,
        baseUrl,
        userid: who.userid,
        team: who.team,
        label,
        allowWrites,
        allowDestructive: caps.allowDestructive && allowWrites && parseCheckbox(req.body.allowDestructive),
        revealUserIdentities: caps.revealUserIdentities && parseCheckbox(req.body.revealUserIdentities),
        maxTokensPerUser: env.maxTokensPerUser,
      });
      const origin = publicOrigin(req);
      res
        .type('html')
        .send(
          renderRegisterSuccess(
            `${origin}/mcp?token=${token}`,
            `${origin}/mcp`,
            token,
            tokenIdOf(registration.tokenHash)
          )
        );
    } catch (err) {
      if (err instanceof TokenLimitError) {
        res
          .status(409)
          .type('html')
          .send(
            renderError(
              `You already have ${err.limit} tokens on this instance. Revoke one from the manage page first.`,
              BACK_TO_MANAGE
            )
          );
        return;
      }
      // biome-ignore lint/suspicious/noConsole: server diagnostic
      console.error('[elabftw-mcp] /register failed:', err);
      res
        .status(500)
        .type('html')
        .send(renderError('Failed to persist registration. Check server logs.'));
    }
  });

  // ---- /manage — self-service token management ----
  // Auth model: one login with an eLabFTW API key (probed via
  // /users/me) creates a server-side session; actions then need the
  // session cookie + CSRF token. Tokens are scoped by (userid, baseUrl)
  // so cross-instance / cross-user access is impossible from here.

  const renderList = (s: ManageSession): string =>
    renderManageList({
      baseUrl: s.baseUrl,
      user: s.user,
      registrations: store.listForUser(s.userid, s.baseUrl),
      csrf: s.csrf,
      caps,
      maxTokens: env.maxTokensPerUser,
    });

  app.get('/manage', (req, res) => {
    const session = manageSessions.fromRequest(req);
    if (!session) {
      res.type('html').send(renderManageLogin(env.allowedBaseUrls));
      return;
    }
    res.type('html').send(renderList(session));
  });

  app.post('/manage', limit(probeLimiter), formBody, async (req, res) => {
    const apiKey = reqText(req.body.apiKey);
    const baseUrl = resolveBaseUrl(req.body.baseUrl);
    if (!apiKey || !baseUrl) {
      res
        .status(400)
        .type('html')
        .send(
          renderManageLogin(
            env.allowedBaseUrls,
            apiKey
              ? 'That eLabFTW instance is not served by this MCP server.'
              : 'API key is required.'
          )
        );
      return;
    }

    let who: ProbeResult;
    try {
      who = await probe(apiKey, baseUrl);
    } catch (err) {
      const msg = err instanceof ProbeError ? err.publicMessage : 'Could not verify this API key.';
      res.status(401).type('html').send(renderManageLogin(env.allowedBaseUrls, msg));
      return;
    }

    const previous = manageSessions.fromRequest(req);
    if (previous) manageSessions.destroy(previous.id);
    const session = manageSessions.create({
      userid: who.userid,
      baseUrl,
      user: who.user,
      apiKey,
      team: who.team,
    });
    setSessionCookie(req, res, session.id);
    res.redirect(303, '/manage');
  });

  /**
   * Shared front half of every /manage POST action: rate limit → parse
   * form → require a live session → require the session's CSRF token.
   */
  const manageAction = (limiter: RateLimiter): RequestHandler[] => [
    limit(limiter),
    formBody,
    (req, res, next) => {
      const session = manageSessions.fromRequest(req);
      if (!session) {
        res
          .status(401)
          .type('html')
          .send(
            renderManageLogin(
              env.allowedBaseUrls,
              'Your manage session has expired. Log in again.'
            )
          );
        return;
      }
      if (!csrfMatches(session, req.body.csrf)) {
        res
          .status(403)
          .type('html')
          .send(
            renderError(
              'Invalid or missing form token. Reload the manage page and try again.',
              BACK_TO_MANAGE
            )
          );
        return;
      }
      res.locals.manage = session;
      next();
    },
  ];

  /**
   * Resolve the form's `id` to one of the session user's tokens; 404
   * when it doesn't exist or belongs to someone else (indistinguishable
   * on purpose).
   */
  const ownedToken: RequestHandler = (req, res, next) => {
    const { manage } = manageLocals(res);
    const id = req.body.id;
    const matches =
      typeof id === 'string' && /^[0-9a-f]{12}$/.test(id)
        ? store
            .listForUser(manage.userid, manage.baseUrl)
            .filter((r) => tokenIdOf(r.tokenHash) === id)
        : [];
    if (matches.length !== 1) {
      res
        .status(404)
        .type('html')
        .send(renderError('Token not found under this user / instance.', BACK_TO_MANAGE));
      return;
    }
    res.locals.target = matches[0];
    next();
  };

  app.post('/manage/logout', ...manageAction(actionLimiter), (req, res) => {
    manageSessions.destroy(manageLocals(res).manage.id);
    clearSessionCookie(req, res);
    res.redirect(303, '/manage');
  });

  app.post('/manage/revoke', ...manageAction(actionLimiter), ownedToken, async (_req, res) => {
    const { manage, target } = manageLocals(res);
    const revoked = await store.revokeForUser(manage.userid, manage.baseUrl, target.tokenHash);
    if (!revoked) {
      res
        .status(404)
        .type('html')
        .send(renderError('Token not found under this user / instance.', BACK_TO_MANAGE));
      return;
    }
    // Drop any live MCP sessions that belonged to this token so
    // in-flight tool calls fail closed.
    pool.closeForToken(target.tokenHash);
    manage.flash = { kind: 'revoked', label: displayLabel(target) };
    res.redirect(303, '/manage/revoked');
  });

  app.post('/manage/mint', ...manageAction(actionLimiter), async (req, res) => {
    const { manage } = manageLocals(res);
    const allowWrites = caps.allowWrites && parseCheckbox(req.body.allowWrites);
    let created: Awaited<ReturnType<typeof store.create>>;
    try {
      created = await store.create({
        apiKey: manage.apiKey,
        baseUrl: manage.baseUrl,
        userid: manage.userid,
        team: manage.team,
        label: optText(req.body.label),
        allowWrites,
        allowDestructive: caps.allowDestructive && allowWrites && parseCheckbox(req.body.allowDestructive),
        revealUserIdentities: caps.revealUserIdentities && parseCheckbox(req.body.revealUserIdentities),
        maxTokensPerUser: env.maxTokensPerUser,
      });
    } catch (err) {
      if (!(err instanceof TokenLimitError)) throw err;
      res
        .status(409)
        .type('html')
        .send(
          renderError(
            `You already have ${err.limit} tokens on this instance. Revoke one first.`,
            BACK_TO_MANAGE
          )
        );
      return;
    }
    const origin = publicOrigin(req);
    manage.flash = {
      kind: 'minted',
      personalUrl: `${origin}/mcp?token=${created.token}`,
      bearerUrl: `${origin}/mcp`,
      token: created.token,
      tokenId: tokenIdOf(created.registration.tokenHash),
      label: created.registration.label,
    };
    res.redirect(303, '/manage/minted');
  });

  // ---- /manage/add-team ----
  // Append another (apiKey, team) pair to an existing token. The new
  // key is probed and rejected unless it resolves to the session's
  // `userid`. Costs an eLabFTW round trip, hence the probe limiter.
  app.post('/manage/add-team', ...manageAction(probeLimiter), ownedToken, async (req, res) => {
    const { manage, target } = manageLocals(res);
    const newApiKey = reqText(req.body.newApiKey);
    if (!newApiKey) {
      res.status(400).type('html').send(renderError('The additional API key is required.', BACK_TO_MANAGE));
      return;
    }

    let newKey: ProbeResult;
    try {
      newKey = await probe(newApiKey, manage.baseUrl);
    } catch (err) {
      const msg = err instanceof ProbeError ? err.publicMessage : 'Could not verify this API key.';
      res
        .status(400)
        .type('html')
        .send(renderError(`${msg} The token was not changed.`, BACK_TO_MANAGE));
      return;
    }

    if (newKey.userid !== manage.userid) {
      res
        .status(400)
        .type('html')
        .send(
          renderError(
            'The new key belongs to a different eLabFTW user than this token. ' +
              'Tokens cannot mix identities — pick a key from your own account.',
            BACK_TO_MANAGE
          )
        );
      return;
    }

    if (target.keys.some((k) => k.team === newKey.team)) {
      res
        .status(400)
        .type('html')
        .send(
          renderError(
            `This token already covers team ${newKey.team}. ` +
              'Adding another key for the same team is a no-op.',
            BACK_TO_MANAGE
          )
        );
      return;
    }

    const updated = await store.addKey(manage.userid, manage.baseUrl, {
      tokenHash: target.tokenHash,
      apiKey: newApiKey,
      team: newKey.team,
      label: optText(req.body.keyLabel),
    });
    if (!updated) {
      res
        .status(404)
        .type('html')
        .send(renderError('Token not found under this user / instance.', BACK_TO_MANAGE));
      return;
    }

    // Drop live MCP sessions for this token so the next connect
    // picks up the new ClientRegistry with the additional team.
    pool.closeForToken(target.tokenHash);
    manage.flash = { kind: 'team-added', tokenLabel: displayLabel(target), team: newKey.team };
    res.redirect(303, '/manage/team-added');
  });

  // ---- /manage/remove-team ----
  app.post('/manage/remove-team', ...manageAction(actionLimiter), ownedToken, async (req, res) => {
    const { manage, target } = manageLocals(res);
    const teamRaw = reqText(req.body.team);
    const team = teamRaw && /^\d+$/.test(teamRaw) ? Number(teamRaw) : Number.NaN;
    if (!Number.isFinite(team)) {
      res.status(400).type('html').send(renderError('Missing team on remove-team form.', BACK_TO_MANAGE));
      return;
    }
    if (target.keys.length <= 1) {
      res
        .status(400)
        .type('html')
        .send(
          renderError(
            'A token must keep at least one team. Use revoke if you want to delete the whole token.',
            BACK_TO_MANAGE
          )
        );
      return;
    }
    if (!target.keys.some((k) => k.team === team)) {
      res.status(400).type('html').send(renderError(`Team ${team} is not on this token.`, BACK_TO_MANAGE));
      return;
    }

    const updated = await store.removeKey(manage.userid, manage.baseUrl, target.tokenHash, team);
    if (!updated) {
      res
        .status(404)
        .type('html')
        .send(renderError('Token not found under this user / instance.', BACK_TO_MANAGE));
      return;
    }
    pool.closeForToken(target.tokenHash);
    manage.flash = { kind: 'team-removed', tokenLabel: displayLabel(target), team };
    res.redirect(303, '/manage/team-removed');
  });

  // ---- /manage/edit — combined edit endpoint ----
  // Single form, single button, one atomic store write for whatever
  // changed (label, flags, default team). The change summary is a diff
  // of the before/after copies. Drops live MCP sessions only when the
  // change is functional (flags, default team).
  app.post('/manage/edit', ...manageAction(actionLimiter), ownedToken, async (req, res) => {
    const { manage, target } = manageLocals(res);

    // Flags whose operator cap is off render disabled (and so aren't
    // submitted); keep the stored opt-in rather than silently clearing it.
    const allowWrites = caps.allowWrites ? parseCheckbox(req.body.allowWrites) : target.allowWrites;
    const allowDestructive = caps.allowDestructive
      ? parseCheckbox(req.body.allowDestructive)
      : target.allowDestructive;
    const revealUserIdentities = caps.revealUserIdentities
      ? parseCheckbox(req.body.revealUserIdentities)
      : target.revealUserIdentities;

    const defaultRaw = reqText(req.body.defaultTeam);
    const defaultTeam = defaultRaw && /^\d+$/.test(defaultRaw) ? Number(defaultRaw) : undefined;

    const updated = await store.update(manage.userid, manage.baseUrl, target.tokenHash, {
      label: typeof req.body.label === 'string' ? { value: optText(req.body.label) } : undefined,
      flags: { allowWrites, allowDestructive, revealUserIdentities },
      defaultTeam,
    });
    if (!updated) {
      res
        .status(404)
        .type('html')
        .send(renderError('Token not found under this user / instance.', BACK_TO_MANAGE));
      return;
    }

    const changes = describeChanges(target, updated);
    const functional =
      target.allowWrites !== updated.allowWrites ||
      target.allowDestructive !== updated.allowDestructive ||
      target.revealUserIdentities !== updated.revealUserIdentities ||
      target.defaultTeam !== updated.defaultTeam;
    if (functional) {
      // Drop live sessions so the next reconnect picks up the new
      // ClientRegistry / tool surface.
      pool.closeForToken(target.tokenHash);
    }

    manage.flash = {
      kind: 'edited',
      tokenLabel: displayLabel(updated),
      changes: changes.length ? changes : ['no changes'],
    };
    res.redirect(303, '/manage/edited');
  });

  // ---- one-shot result pages (PRG targets) ----
  // Each reads and clears its flash from the server-side session;
  // refreshing falls back to /manage (or the empty minted page).

  app.get('/manage/minted', (req, res) => {
    const flash = takeFlash(manageSessions.fromRequest(req), 'minted');
    res.type('html').send(flash ? renderJustMinted(flash) : renderJustMintedEmpty());
  });

  app.get('/manage/revoked', (req, res) => {
    const flash = takeFlash(manageSessions.fromRequest(req), 'revoked');
    if (!flash) return res.redirect(302, '/manage');
    res.type('html').send(renderJustRevoked(flash.label));
  });

  app.get('/manage/team-added', (req, res) => {
    const flash = takeFlash(manageSessions.fromRequest(req), 'team-added');
    if (!flash) return res.redirect(302, '/manage');
    res.type('html').send(renderTeamAdded(flash.tokenLabel, flash.team));
  });

  app.get('/manage/team-removed', (req, res) => {
    const flash = takeFlash(manageSessions.fromRequest(req), 'team-removed');
    if (!flash) return res.redirect(302, '/manage');
    res.type('html').send(renderTeamRemoved(flash.tokenLabel, flash.team));
  });

  app.get('/manage/edited', (req, res) => {
    const flash = takeFlash(manageSessions.fromRequest(req), 'edited');
    if (!flash) return res.redirect(302, '/manage');
    res.type('html').send(renderManageEdited(flash.tokenLabel, flash.changes));
  });

  // ---- MCP endpoint ----
  // Order on every /mcp route: Host/Origin guard (above) → bearer auth →
  // (POST only) JSON body parse → handler. The SDK transport consumes
  // the pre-parsed body as `parsedBody`.
  const mcpAuth = (req: Request, res: Response, next: NextFunction): void => {
    const extracted = extractToken(req);
    if (!extracted) {
      send401(res, 'Missing bearer token.', 'invalid_request');
      return;
    }
    const tokenHash = hashToken(extracted.token);
    const reg = store.get(tokenHash);
    if (!reg) {
      send401(res, 'Unknown token.', 'invalid_token');
      return;
    }
    if (!allowedBaseUrls.has(normaliseBaseUrl(reg.baseUrl))) {
      // Registered before the allow-list existed (or the operator has
      // since removed the instance). Never relay to it.
      res.status(403).json({
        error: "This token's eLabFTW instance is not served by this MCP server.",
      });
      return;
    }
    if (extracted.source === 'query') {
      // Signal that this auth path is deprecated. Header is
      // unconditional so clients see it on every reply.
      res.set('Deprecation', 'true');
    }
    res.locals.tokenHash = tokenHash;
    res.locals.registration = reg;
    next();
  };

  const unknownSession = (res: Response, sessionId: string): void => {
    res.status(404).json({ error: `Unknown MCP session: ${sessionId}` });
  };

  app.post('/mcp', mcpAuth, jsonBody, async (req, res) => {
    const { tokenHash, registration } = mcpLocals(res);
    const sessionId = req.headers[MCP_SESSION_HEADER] as string | undefined;

    if (sessionId) {
      const existing = pool.touch(sessionId);
      // A session id that belongs to a different token is reported as
      // not found rather than leaking that the id is valid.
      if (!existing || existing.tokenHash !== tokenHash) {
        unknownSession(res, sessionId);
        return;
      }
      await existing.transport.handleRequest(req, res, req.body);
      void store.touch(tokenHash);
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

    const server = buildMcpServerForToken(baseConfig, registration);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        pool.add({ sessionId: id, tokenHash, transport, server });
      },
      onsessionclosed: (id) => {
        pool.remove(id);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) pool.remove(id);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    // Best-effort touch — never blocks the response.
    void store.touch(tokenHash);
  });

  const streamOrClose = async (req: Request, res: Response): Promise<void> => {
    const { tokenHash } = mcpLocals(res);
    const sessionId = req.headers[MCP_SESSION_HEADER] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing Mcp-Session-Id header.' });
      return;
    }
    const session = pool.touch(sessionId);
    if (!session || session.tokenHash !== tokenHash) {
      unknownSession(res, sessionId);
      return;
    }
    await session.transport.handleRequest(req, res);
  };
  app.get('/mcp', mcpAuth, streamOrClose);
  app.delete('/mcp', mcpAuth, streamOrClose);

  app.use(((err, _req, res, _next) => {
    // Body-parser errors (malformed JSON, too large) carry a 4xx status.
    const status =
      typeof (err as { status?: unknown }).status === 'number' &&
      (err as { status: number }).status >= 400 &&
      (err as { status: number }).status < 500
        ? (err as { status: number }).status
        : 500;
    if (status === 500) {
      // biome-ignore lint/suspicious/noConsole: server diagnostic
      console.error('[elabftw-mcp] unhandled:', err);
    }
    if (res.headersSent) return;
    res.status(status).json({ error: status === 500 ? 'Internal server error.' : 'Bad request.' });
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
      `[elabftw-mcp] allowed eLabFTW instances: ${env.allowedBaseUrls.join(', ')}`
    );
    // biome-ignore lint/suspicious/noConsole: startup diagnostic
    console.error(
      `[elabftw-mcp] registrations (${env.storeBackend}): ${storePath} ` +
        `(${store.list().length} loaded)`
    );
    // biome-ignore lint/suspicious/noConsole: startup diagnostic
    console.error(
      `[elabftw-mcp] Host/Origin allow-list: hosts=[${env.allowedHosts.join(
        ', '
      )}] origins=[${env.allowedOrigins.join(', ')}]; trust proxy=${env.trustProxy}`
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
