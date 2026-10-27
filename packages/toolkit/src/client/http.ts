import type { ElabftwConfig } from './types';

/** Injected by tsup from package.json; absent when the sources run unbundled. */
declare const __PKG_VERSION__: string | undefined;

export const PACKAGE_VERSION: string =
  typeof __PKG_VERSION__ === 'string' ? __PKG_VERSION__ : '0.0.0-dev';

export const DEFAULT_USER_AGENT = `sura-elabftw-mcp/${PACKAGE_VERSION}`;

const DEFAULT_TIMEOUT_MS = 30_000;

/** Upper bound for the eLabFTW response text carried by an error. */
const MAX_ERROR_BODY_CHARS = 1024;

/**
 * Thrown for any non-2xx response from the elabftw instance.
 * `statusCode` is the HTTP status; `body` is an excerpt of the response
 * text (often JSON with a `description` field from elabftw's error
 * middleware), capped at about 1 KB with the API key redacted.
 */
export class ElabftwApiError extends Error {
  readonly url: string;
  readonly statusCode: number;
  readonly method: string;
  readonly body: string;

  constructor(
    message: string,
    url: string,
    method: string,
    statusCode: number,
    body: string,
    options?: { cause?: unknown }
  ) {
    super(`elabftw API error: ${message} (${method} ${url})`, options);
    this.name = 'ElabftwApiError';
    this.url = url;
    this.method = method;
    this.statusCode = statusCode;
    this.body = body;
  }
}

/**
 * Thrown when no usable HTTP response arrived: the request (including
 * reading the body) exceeded the timeout, the instance answered with a
 * redirect, or the connection failed. `statusCode` is 0.
 */
export class ElabftwTransportError extends ElabftwApiError {
  readonly kind: 'timeout' | 'redirect' | 'network';

  constructor(
    kind: 'timeout' | 'redirect' | 'network',
    message: string,
    url: string,
    method: string,
    options?: { cause?: unknown }
  ) {
    super(message, url, method, 0, '', options);
    this.name = 'ElabftwTransportError';
    this.kind = kind;
    this.message = message;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Build an absolute URL for an API v2 path plus optional query parameters.
 * Array values are serialized as repeated keys (`tags[]=1&tags[]=2`), which
 * is the form elabftw expects.
 */
export function buildUrl(
  config: ElabftwConfig,
  path: string,
  query?: Record<string, unknown>
): string {
  const base = normalizeBaseUrl(config.baseUrl);
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${base}/api/v2${cleanPath}`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item === undefined || item === null) continue;
          url.searchParams.append(`${key}[]`, String(item));
        }
      } else {
        url.searchParams.append(key, String(value));
      }
    }
  }

  return url.toString();
}

/** Body shapes the client sends as-is (JSON payloads go through `body`). */
type RawBody = FormData | Blob | ArrayBuffer | Uint8Array | string;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  /** Serialized to JSON with Content-Type: application/json. */
  body?: unknown;
  /** Pass a pre-built FormData / Blob / ArrayBuffer for binary uploads. */
  rawBody?: RawBody;
  /** Extra headers, merged with auth + default accept. */
  headers?: Record<string, string>;
  /** When true, returns the raw Response (don't parse JSON). */
  raw?: boolean;
  /** Override Accept. Defaults to application/json. */
  accept?: string;
}

function redact(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join('[redacted]') : text;
}

/**
 * Shorten an eLabFTW response body for inclusion in an error. HTML pages
 * (typically a reverse proxy's 502/504) are reduced to their text.
 */
function errorExcerpt(text: string, apiKey: string): string {
  let out = redact(text, apiKey).trim();
  if (/^<(!doctype|html)/i.test(out)) {
    out = out
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (out.length <= MAX_ERROR_BODY_CHARS) return out;
  return `${out.slice(0, MAX_ERROR_BODY_CHARS)}… [truncated, ${out.length} chars total]`;
}

function formatSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(3))}s`;
}

/**
 * Map a fetch / body-read failure onto an {@link ElabftwTransportError}.
 * The abort signal is the authoritative timeout indicator: once it fired,
 * whatever the runtime threw is a consequence of it.
 */
function transportError(
  error: unknown,
  signal: AbortSignal,
  ctx: { url: string; method: string; timeoutMs: number; apiKey: string }
): ElabftwApiError {
  if (error instanceof ElabftwApiError) return error;
  const { url, method } = ctx;
  if (signal.aborted) {
    return new ElabftwTransportError(
      'timeout',
      `Timed out after ${formatSeconds(ctx.timeoutMs)}: ${method} ${url}. ` +
        'Raise ELABFTW_TIMEOUT_MS if the instance is slow.',
      url,
      method,
      { cause: error }
    );
  }
  const cause = (error as { cause?: unknown } | null)?.cause;
  const detail = [error, cause]
    .map((e) => (e instanceof Error ? e.message : e ? String(e) : ''))
    .filter(Boolean)
    .join(': ');
  if (/redirect/i.test(detail)) {
    return new ElabftwTransportError(
      'redirect',
      `eLabFTW answered ${method} ${url} with a redirect, which is not followed ` +
        '(it would turn POST into GET and could send the API key to another host). ' +
        'Set ELABFTW_BASE_URL to the final URL the instance is served from ' +
        '(usually https://, exact host name, no trailing path).',
      url,
      method,
      { cause: error }
    );
  }
  return new ElabftwTransportError(
    'network',
    `Could not reach eLabFTW: ${method} ${url} failed (${redact(detail, ctx.apiKey) || 'unknown error'}).`,
    url,
    method,
    { cause: error }
  );
}

/**
 * Re-wrap a response so failures while the caller reads the body (the
 * timeout firing mid-download, a dropped connection) surface as
 * {@link ElabftwTransportError} instead of a bare `AbortError`.
 */
function withBodyErrorTranslation(
  response: Response,
  translate: (error: unknown) => unknown
): Response {
  const source = response.body;
  if (!source) return response;
  const reader = source.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(translate(error));
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Low-level fetch with auth, timeout, and consistent error shape.
 *
 *   - Auth header is the bare API key — no `Bearer` prefix.
 *   - The timeout covers the whole exchange, including reading the body
 *     of the returned `Response`; it is never cleared.
 *   - Redirects are refused (`redirect: 'error'`): following one turns
 *     POST into GET and can forward the API key to another origin.
 *   - Some POST/PATCH endpoints return `Location:` with an id but no body;
 *     callers that need the new id should use {@link extractLocationId}.
 */
export async function elabFetch(
  config: ElabftwConfig,
  path: string,
  query: Record<string, unknown> | undefined,
  options: RequestOptions = {}
): Promise<Response> {
  const url = buildUrl(config, path, query);
  const method = options.method ?? 'GET';
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = {
    Authorization: config.apiKey,
    Accept: options.accept ?? 'application/json',
    'User-Agent': config.userAgent ?? DEFAULT_USER_AGENT,
    ...options.headers,
  };

  let body: RawBody | undefined;
  if (options.rawBody !== undefined) {
    // FormData / Blob — let fetch set its own Content-Type (with boundary).
    body = options.rawBody;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  } else if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
    // elabftw rejects payloadless POSTs on some endpoints (e.g. creating
    // entity links) with "Incorrect content-type header" unless a JSON
    // Content-Type is present. Set it even with no body.
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }

  const signal = AbortSignal.timeout(timeoutMs);
  const ctx = { url, method, timeoutMs, apiKey: config.apiKey };
  const fetchImpl = config.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body,
      redirect: 'error',
      signal,
    });
  } catch (error) {
    throw transportError(error, signal, ctx);
  }

  if (!response.ok) {
    let errBody: string;
    try {
      errBody = await response.text();
    } catch (error) {
      if (signal.aborted) throw transportError(error, signal, ctx);
      errBody = '';
    }
    throw new ElabftwApiError(
      `${response.status} ${response.statusText}`,
      url,
      method,
      response.status,
      errorExcerpt(errBody, config.apiKey)
    );
  }

  return withBodyErrorTranslation(response, (error) =>
    transportError(error, signal, ctx)
  );
}

/**
 * JSON-returning convenience wrapper around {@link elabFetch}.
 */
export async function elabJson<T = unknown>(
  config: ElabftwConfig,
  path: string,
  query?: Record<string, unknown>,
  options: RequestOptions = {}
): Promise<T> {
  const response = await elabFetch(config, path, query, options);
  // elabftw returns 204 No Content for most DELETEs and some PATCHes.
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    const method = options.method ?? 'GET';
    const url = buildUrl(config, path, query);
    const type = response.headers.get('content-type') ?? 'no content-type';
    throw new ElabftwApiError(
      `expected JSON, got ${type}`,
      url,
      method,
      response.status,
      errorExcerpt(text, config.apiKey)
    );
  }
}

/**
 * After a POST that creates a resource, elabftw returns 201 with a `Location`
 * header like `/api/v2/experiments/42`. This extracts the trailing numeric id.
 * Returns null if the header is missing or malformed.
 *
 * The id must be anchored to the end of the URL — elabftw's Location header
 * otherwise contains the API version ("v2"), and a non-anchored regex would
 * match the "2" from the version instead of the real entity id.
 */
export function extractLocationId(response: Response): number | null {
  const loc = response.headers.get('location') ?? response.headers.get('Location');
  if (!loc) return null;
  const match = /(\d+)\/?$/.exec(loc);
  if (!match || !match[1]) return null;
  const id = Number.parseInt(match[1], 10);
  return Number.isNaN(id) ? null : id;
}
