import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Optional tool groups, selected with `ELABFTW_TOOLSETS`. Every MCP client
 * without client-side tool search pays for the full tool list on every
 * request, so labs can drop groups they never use. Tools not listed here
 * belong to `core`, which is always on.
 */
const TOOLSET_OF: Record<string, Toolset> = {
  elab_list_extra_fields: 'extra_fields',
  elab_list_extra_field_names: 'extra_fields',
  elab_update_extra_field: 'extra_fields',
  elab_set_extra_field: 'extra_fields',
  elab_remove_extra_field: 'extra_fields',
  elab_clone_extra_fields_schema: 'extra_fields',
  elab_set_extra_field_groups: 'extra_fields',

  elab_list_steps: 'steps',
  elab_list_unfinished_steps: 'steps',
  elab_add_step: 'steps',
  elab_update_step: 'steps',
  elab_toggle_step: 'steps',
  elab_delete_step: 'steps',

  elab_list_comments: 'comments',
  elab_add_comment: 'comments',
  elab_update_comment: 'comments',
  elab_delete_comment: 'comments',

  elab_list_attachments: 'files',
  elab_download_attachment: 'files',
  elab_export: 'files',

  elab_search_compounds: 'compounds',
  elab_get_compound: 'compounds',
  elab_search_pubchem: 'compounds',
  elab_create_compound: 'compounds',
  elab_create_compound_from_pubchem: 'compounds',
  elab_update_compound: 'compounds',
  elab_delete_compound: 'compounds',

  elab_list_revisions: 'history',
  elab_get_revision: 'history',

  elab_search_users: 'users',
  elab_get_user: 'users',
  elab_list_team_users: 'users',

  elab_list_events: 'scheduler',

  elab_timestamp: 'integrity',
  elab_bloxberg: 'integrity',
};

export const TOOLSETS = [
  'core',
  'extra_fields',
  'steps',
  'comments',
  'files',
  'compounds',
  'history',
  'users',
  'scheduler',
  'integrity',
] as const;
export type Toolset = (typeof TOOLSETS)[number];

export function toolsetOf(toolName: string): Toolset {
  return TOOLSET_OF[toolName] ?? 'core';
}

export interface ToolFilterOptions {
  /** Enabled toolsets; `core` is implied. Undefined = all. */
  toolsets?: ReadonlySet<Toolset>;
  /**
   * Drop the `team` parameter from every tool schema. Used when only one
   * API key is configured: the parameter can only ever take one value.
   */
  hideTeamParam?: boolean;
  /** Awaited before every tool call (e.g. lazy team resolution). */
  beforeCall?: () => Promise<void>;
}

/**
 * Wrap `server` so `server.tool(name, …)` skips tools outside the enabled
 * toolsets, strips the `team` parameter if asked, and runs `beforeCall`
 * ahead of every handler. Tool modules keep registering everything
 * unconditionally.
 */
export function filterTools(
  server: McpServer,
  options: ToolFilterOptions
): McpServer {
  const { toolsets, hideTeamParam, beforeCall } = options;
  const register = (name: string, ...rest: unknown[]): unknown => {
    const set = toolsetOf(name);
    if (toolsets && set !== 'core' && !toolsets.has(set)) return undefined;
    if (hideTeamParam) {
      rest = rest.map((arg) => {
        if (!arg || typeof arg !== 'object' || !('team' in arg)) return arg;
        const { team: _team, ...schema } = arg as Record<string, unknown>;
        return schema;
      });
    }
    const handler = rest.at(-1);
    if (beforeCall && typeof handler === 'function') {
      rest[rest.length - 1] = async (...args: unknown[]) => {
        await beforeCall();
        return handler(...args);
      };
    }
    return (server.tool as (...args: unknown[]) => unknown).call(
      server,
      name,
      ...rest
    );
  };
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'tool') return register;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Parse `ELABFTW_TOOLSETS` (comma-separated, or `all`). */
export function parseToolsets(raw: string | undefined): Set<Toolset> | undefined {
  if (!raw || raw.trim() === '' || raw.trim() === 'all') return undefined;
  const out = new Set<Toolset>();
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!(TOOLSETS as readonly string[]).includes(part)) {
      throw new Error(
        `ELABFTW_TOOLSETS: unknown toolset "${part}". Valid: ${TOOLSETS.join(', ')}, or "all".`
      );
    }
    out.add(part as Toolset);
  }
  return out;
}
