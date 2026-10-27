/**
 * Small, dependency-free Express guards: Host / Origin validation,
 * per-IP rate limiting, and response headers for the HTML pages.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * DNS-rebinding guard. Runs *before* any route work — in particular
 * before an `McpServer` is constructed for `/mcp`, which is why this
 * lives in Express rather than in the SDK transport's (deprecated)
 * `allowedHosts` / `allowedOrigins` options.
 *
 *   - `Host` must be one of `allowedHosts` (exact `host[:port]`,
 *     case-insensitive).
 *   - `Origin`, when present, must be one of `allowedOrigins`.
 *     Non-browser MCP clients send no Origin and pass.
 */
export function hostOriginGuard(
  allowedHosts: string[],
  allowedOrigins: string[]
): RequestHandler {
  const hosts = new Set(allowedHosts.map((h) => h.toLowerCase()));
  const origins = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = req.headers.host?.toLowerCase();
    if (!host || !hosts.has(host)) {
      res.status(403).json({ error: 'Host not allowed.' });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      res.status(403).json({ error: 'Origin not allowed.' });
      return;
    }
    next();
  };
}

/**
 * Headers for every /register and /manage response: never cache (the
 * pages carry freshly minted tokens and CSRF tokens), never frame, no
 * referrer. Caddy sets some of these too; repeating them here keeps
 * deployments behind other proxies covered.
 */
export const htmlSecurityHeaders: RequestHandler = (_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  next();
};

/**
 * Per-key sliding-window rate limiter. In-memory only; resets on
 * process restart. Expired entries are pruned on a timer so the map
 * can't grow without bound under a spray of source addresses.
 */
export class RateLimiter {
  private readonly windowMs: number;
  private readonly limit: number;
  private readonly hits = new Map<string, number[]>();

  constructor(windowMs: number, limit: number) {
    this.windowMs = windowMs;
    this.limit = limit;
    setInterval(() => this.prune(), windowMs).unref();
  }

  check(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, times] of this.hits) {
      if (!times.some((t) => t > cutoff)) this.hits.delete(key);
    }
  }
}
