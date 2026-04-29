/**
 * MCP-protocol session pool.
 *
 * One entry per live MCP session (the kind tracked by the
 * `Mcp-Session-Id` HTTP header). Each entry binds a transport, the
 * `McpServer` instance it serves, and the registration token that
 * authenticated it.
 *
 * The pool is in-memory by design. MCP sessions are ephemeral: clients
 * reconnect cheaply, and persisting them across process restarts buys
 * us nothing.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface PooledSession {
  sessionId: string;
  token: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export class SessionPool {
  private readonly sessions = new Map<string, PooledSession>();

  add(session: PooledSession): void {
    this.sessions.set(session.sessionId, session);
  }

  get(sessionId: string): PooledSession | undefined {
    return this.sessions.get(sessionId);
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  countByToken(token: string): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.token === token) n++;
    }
    return n;
  }

  size(): number {
    return this.sessions.size;
  }

  /** Close every transport; intended for graceful shutdown. */
  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(all.map((s) => s.transport.close()));
  }

  /**
   * Close every live session belonging to a single token. Called when
   * the manage page revokes a token so in-flight tool calls fail
   * closed instead of running with the about-to-be-deleted credential.
   */
  closeForToken(token: string): void {
    for (const s of [...this.sessions.values()]) {
      if (s.token !== token) continue;
      this.sessions.delete(s.sessionId);
      // Best-effort close; the transport's own onclose handler runs
      // after this returns and may try to remove() again — tolerated.
      void s.transport.close();
    }
  }
}
