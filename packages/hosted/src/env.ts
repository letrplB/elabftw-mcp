/**
 * Hosted-mode environment parsing.
 *
 * Everything the HTTP layer needs from `process.env` is read and
 * validated here, once, at startup. The toolkit's own `loadConfig`
 * still owns the `ELABFTW_*` flags (writes / destructive / reveal,
 * timeouts, user agent).
 */

import { canonicaliseBaseUrl, type StoreBackend } from './store';

const DEFAULT_REG_PATH = './registrations.json';
const DEFAULT_PORT = 8000;
const DEFAULT_HOST = '0.0.0.0';

export interface HostedEnv {
  host: string;
  port: number;
  publicUrl?: string;
  registrationsPath: string;
  storeBackend: StoreBackend;
  /** Raw `MCP_STORE_KEY` (validated when the store opens). */
  storeKey?: string;
  /**
   * Canonical eLabFTW base URLs users may register against. Never
   * empty. Anything else is rejected, which keeps the server from
   * being used as an open relay / SSRF probe.
   */
  allowedBaseUrls: string[];
  allowedHosts: string[];
  allowedOrigins: string[];
  /** Express `trust proxy` hop count. */
  trustProxy: number;
  maxSessions: number;
  maxSessionsPerToken: number;
  maxTokensPerUser: number;
}

/**
 * Resolve the base-URL allow-list: `MCP_ALLOWED_BASE_URLS`
 * (comma-separated) or, failing that, `ELABFTW_BASE_URL`. Throws when
 * neither is set or an entry isn't a plain http(s) URL.
 */
export function resolveAllowedBaseUrls(
  listEnv: string | undefined,
  defaultEnv: string | undefined
): string[] {
  const raw = splitList(listEnv) ?? splitList(defaultEnv);
  if (!raw?.length) {
    throw new Error(
      'Set MCP_ALLOWED_BASE_URLS (comma-separated) or ELABFTW_BASE_URL — ' +
        'hosted mode only talks to eLabFTW instances on an explicit allow-list.'
    );
  }
  const out: string[] = [];
  for (const entry of raw) {
    let canonical: string;
    try {
      canonical = canonicaliseBaseUrl(entry);
    } catch (err) {
      throw new Error(
        `Invalid eLabFTW base URL in allow-list: ${entry} (${
          err instanceof Error ? err.message : String(err)
        })`
      );
    }
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/**
 * Resolve the effective Host / Origin allow-lists used by the
 * DNS-rebinding guard.
 *
 *   - `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` win when set.
 *   - Otherwise derive from `MCP_PUBLIC_URL` so a typical deployment is
 *     spec-compliant by default (the spec says servers MUST validate
 *     the Origin header).
 *   - The bind address (or 127.0.0.1 / localhost for a wildcard bind)
 *     is always added, so local testing and in-container probes work.
 *     A rebinding attacker can't present those Host values.
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

  const hosts = [
    ...new Set(
      [...(explicitHosts ?? (publicHost ? [publicHost] : [])), ...localHostFallbacks].map(
        (h) => h.toLowerCase()
      )
    ),
  ];

  const origins = explicitOrigins ?? [
    ...new Set([
      ...(publicOrigin ? [publicOrigin] : []),
      ...localHostFallbacks.map((h) => `http://${h}`),
      ...localHostFallbacks.map((h) => `https://${h}`),
    ]),
  ];

  if (!explicitHosts && !publicHost) {
    warnings.push(
      'No MCP_PUBLIC_URL or MCP_ALLOWED_HOSTS configured — only requests ' +
        'addressed to the bind address are accepted. Set MCP_PUBLIC_URL ' +
        '(recommended) or MCP_ALLOWED_HOSTS for production.'
    );
  }

  return { hosts, origins, warnings };
}

export function readHostedEnv(): HostedEnv {
  const port = intEnv('MCP_PORT', DEFAULT_PORT, 1, 65535);
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
    storeKey: process.env.MCP_STORE_KEY?.trim() || undefined,
    allowedBaseUrls: resolveAllowedBaseUrls(
      process.env.MCP_ALLOWED_BASE_URLS,
      process.env.ELABFTW_BASE_URL
    ),
    allowedHosts: hosts,
    allowedOrigins: origins,
    trustProxy: intEnv('MCP_TRUST_PROXY', 1, 0, 32),
    maxSessions: intEnv('MCP_MAX_SESSIONS', 500, 1, 1_000_000),
    maxSessionsPerToken: intEnv('MCP_MAX_SESSIONS_PER_TOKEN', 5, 1, 1000),
    maxTokensPerUser: intEnv('MCP_MAX_TOKENS_PER_USER', 20, 1, 10_000),
  };
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}], got: ${raw}`);
  }
  return n;
}

function splitList(raw: string | undefined): string[] | undefined {
  if (!raw || !raw.trim()) return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}
