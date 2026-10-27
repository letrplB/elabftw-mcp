/**
 * Server-side sessions for the /manage pages.
 *
 * The user logs in once with an eLabFTW API key (one `/users/me`
 * probe). From then on the browser holds only an opaque random session
 * id in an HttpOnly, SameSite=Strict cookie scoped to /manage; the API
 * key stays server-side and is never echoed back into the page. Every state-changing POST
 * must also carry the session's CSRF token.
 *
 * One-shot "flash" results (the freshly minted token, a revoke
 * confirmation, …) live in the session too, so nothing the browser
 * sends back is ever parsed as trusted data.
 *
 * In-memory, single process. Restarting the server logs everyone out of
 * /manage, which is harmless — MCP bearer tokens are unaffected.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { ManageUser } from './views';

export const MANAGE_COOKIE = 'mcp_manage';

export type ManageFlash =
  | {
      kind: 'minted';
      personalUrl: string;
      bearerUrl: string;
      token: string;
      tokenId: string;
      label?: string;
    }
  | { kind: 'revoked'; label: string }
  | { kind: 'team-added'; tokenLabel: string; team: number }
  | { kind: 'team-removed'; tokenLabel: string; team: number }
  | { kind: 'edited'; tokenLabel: string; changes: string[] };

export interface ManageSession {
  id: string;
  csrf: string;
  userid: number;
  /** Canonical, allow-listed base URL the user logged in against. */
  baseUrl: string;
  user: ManageUser;
  /**
   * The API key the user logged in with, and the team `/users/me`
   * reported for it — needed to mint new tokens. Held in server memory
   * only (the same key is already stored, encrypted, on the user's
   * tokens); it is never rendered into a page.
   */
  apiKey: string;
  team: number;
  lastSeen: number;
  flash?: ManageFlash;
}

export interface ManageSessionOptions {
  idleMs: number;
  /** Hard cap on concurrent sessions; the least recently used is dropped. */
  maxSessions: number;
}

export class ManageSessionStore {
  // Insertion-ordered; `get` re-inserts, so the head is the LRU entry.
  private readonly sessions = new Map<string, ManageSession>();
  private readonly options: ManageSessionOptions;

  constructor(options: ManageSessionOptions) {
    this.options = options;
    setInterval(() => this.sweep(), 60_000).unref();
  }

  create(
    identity: Pick<ManageSession, 'userid' | 'baseUrl' | 'user' | 'apiKey' | 'team'>
  ): ManageSession {
    while (this.sessions.size >= this.options.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const session: ManageSession = {
      ...identity,
      id: randomBytes(32).toString('base64url'),
      csrf: randomBytes(32).toString('base64url'),
      lastSeen: Date.now(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Resolve a live session from the request cookie and bump its idle timer. */
  fromRequest(req: Request): ManageSession | undefined {
    const id = readCookie(req, MANAGE_COOKIE);
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (Date.now() - session.lastSeen > this.options.idleMs) {
      this.sessions.delete(id);
      return undefined;
    }
    session.lastSeen = Date.now();
    this.sessions.delete(id);
    this.sessions.set(id, session);
    return session;
  }

  destroy(id: string): void {
    this.sessions.delete(id);
  }

  private sweep(): void {
    const cutoff = Date.now() - this.options.idleMs;
    for (const [id, s] of this.sessions) {
      if (s.lastSeen < cutoff) this.sessions.delete(id);
    }
  }
}

/** Read the session's flash of one kind, clearing it (read-once). */
export function takeFlash<K extends ManageFlash['kind']>(
  session: ManageSession | undefined,
  kind: K
): Extract<ManageFlash, { kind: K }> | undefined {
  const flash = session?.flash;
  if (!session || !flash || flash.kind !== kind) return undefined;
  session.flash = undefined;
  return flash as Extract<ManageFlash, { kind: K }>;
}

/** Constant-time comparison of a submitted CSRF token. */
export function csrfMatches(session: ManageSession, submitted: unknown): boolean {
  if (typeof submitted !== 'string') return false;
  const a = Buffer.from(session.csrf);
  const b = Buffer.from(submitted);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Set the session cookie. Secure whenever the request arrived over
 * https (behind a proxy this relies on `trust proxy` +
 * `X-Forwarded-Proto`). No Max-Age: the server-side idle TTL is
 * authoritative, and closing the browser drops the cookie anyway.
 */
export function setSessionCookie(req: Request, res: Response, id: string): void {
  res.cookie(MANAGE_COOKIE, id, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'strict',
    path: '/manage',
  });
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.clearCookie(MANAGE_COOKIE, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'strict',
    path: '/manage',
  });
}

/** Minimal Cookie-header reader — we only ever need one cookie. */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    if (pair.slice(0, idx).trim() !== name) continue;
    const value = pair.slice(idx + 1).trim();
    // Our ids are base64url — anything else is not ours.
    return /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : undefined;
  }
  return undefined;
}
