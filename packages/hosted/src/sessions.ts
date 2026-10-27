/**
 * MCP-protocol session pool.
 *
 * One entry per live MCP session (the kind tracked by the
 * `Mcp-Session-Id` HTTP header). Each entry binds a transport, the
 * `McpServer` instance it serves, and the hash of the registration
 * token that authenticated it.
 *
 * The pool is in-memory by design. MCP sessions are ephemeral: clients
 * reconnect cheaply, and persisting them across process restarts buys
 * us nothing.
 *
 * Bounded so a token holder can't exhaust memory by spamming
 * `initialize`:
 *   - per-token cap: adding past it evicts that token's least-recently
 *     used session;
 *   - global cap: adding past it evicts the least-recently used session
 *     overall;
 *   - idle sweep: sessions with no request for `idleMs` are closed.
 * Evicted clients get a 404 on their next request and re-initialize.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface PooledSession {
  sessionId: string;
  tokenHash: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

interface Entry extends PooledSession {
  lastSeen: number;
}

export interface SessionPoolOptions {
  maxPerToken: number;
  maxTotal: number;
  idleMs: number;
  /** How often the idle sweep runs. Defaults to a minute. */
  sweepIntervalMs?: number;
}

export class SessionPool {
  // Map iteration order is insertion order; `touch` re-inserts, so the
  // first entry is always the least recently used.
  private readonly sessions = new Map<string, Entry>();
  private readonly options: SessionPoolOptions;
  private readonly sweeper: NodeJS.Timeout;

  constructor(options: SessionPoolOptions) {
    this.options = options;
    this.sweeper = setInterval(
      () => this.sweepIdle(),
      options.sweepIntervalMs ?? 60_000
    );
    this.sweeper.unref();
  }

  add(session: PooledSession): void {
    const forToken = [...this.sessions.values()].filter(
      (s) => s.tokenHash === session.tokenHash
    );
    // Oldest-first, so slicing off the head evicts the LRU ones.
    for (const s of forToken.slice(
      0,
      Math.max(0, forToken.length - this.options.maxPerToken + 1)
    )) {
      this.evict(s, 'per-token session cap');
    }
    while (this.sessions.size >= this.options.maxTotal) {
      const oldest = this.sessions.values().next().value;
      if (!oldest) break;
      this.evict(oldest, 'global session cap');
    }
    this.sessions.set(session.sessionId, { ...session, lastSeen: Date.now() });
  }

  /** Look up a session and mark it as used. */
  touch(sessionId: string): PooledSession | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    entry.lastSeen = Date.now();
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, entry);
    return entry;
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  size(): number {
    return this.sessions.size;
  }

  /** Close every transport; intended for graceful shutdown. */
  async closeAll(): Promise<void> {
    clearInterval(this.sweeper);
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(all.map((s) => s.transport.close()));
  }

  /**
   * Close every live session belonging to a single token. Called when
   * the manage page revokes or reshapes a token so in-flight tool calls
   * fail closed instead of running with stale credentials / flags.
   */
  closeForToken(tokenHash: string): void {
    for (const s of [...this.sessions.values()]) {
      if (s.tokenHash === tokenHash) this.close(s);
    }
  }

  private sweepIdle(): void {
    const cutoff = Date.now() - this.options.idleMs;
    for (const s of [...this.sessions.values()]) {
      if (s.lastSeen < cutoff) this.close(s);
    }
  }

  private evict(s: Entry, reason: string): void {
    // biome-ignore lint/suspicious/noConsole: operational diagnostic
    console.error(`[elabftw-mcp] evicting MCP session (${reason})`);
    this.close(s);
  }

  private close(s: Entry): void {
    this.sessions.delete(s.sessionId);
    // Best-effort close; the transport's own onclose handler runs
    // after this and may try to remove() again — tolerated.
    void s.transport.close();
  }
}
