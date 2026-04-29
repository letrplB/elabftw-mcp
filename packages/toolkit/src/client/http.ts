import type { ElabftwConfig } from './types';

/**
 * Thrown for any non-2xx response from the elabftw instance.
 * `statusCode` is the HTTP status; `body` is the raw response text (often
 * JSON with a `description` field from elabftw's error middleware).
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
    body: string
  ) {
    super(`elabftw API error: ${message} (${method} ${url})`);
    this.name = 'ElabftwApiError';
    this.url = url;
    this.method = method;
    this.statusCode = statusCode;
    this.body = body;
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

/**
 * `BodyInit` is not ambient in the bun-types-only build. Widen to the
 * subset we actually accept (json-serialized string is handled via `body`).
 */
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

/**
 * Low-level fetch with auth, timeout, and consistent error shape.
 * Handles two elabftw quirks:
 *
 *   1. Auth header is the bare API key — no `Bearer` prefix.
 *   2. Some POST/PATCH endpoints return `Location:` with an id but no body;
 *      callers that need the new id should use {@link extractLocationId}.
 */
export async function elabFetch(
  config: ElabftwConfig,
  path: string,
  query: Record<string, unknown> | undefined,
  options: RequestOptions = {}
): Promise<Response> {
  const url = buildUrl(config, path, query);
  const method = options.method ?? 'GET';

  const headers: Record<string, string> = {
    Authorization: config.apiKey,
    Accept: options.accept ?? 'application/json',
    'User-Agent': config.userAgent ?? 'sura-elabftw/1.0',
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

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? 30_000
  );

  const fetchImpl = config.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new ElabftwApiError(
        `${response.status} ${response.statusText}`,
        url,
        method,
        response.status,
        errBody
      );
    }

    return response;
  } finally {
    clearTimeout(timeout);
  }
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
  return JSON.parse(text) as T;
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
