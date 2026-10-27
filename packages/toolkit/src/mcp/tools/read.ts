import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type ElabCategory,
  type ElabComment,
  type ElabCompound,
  type ElabEntity,
  type ElabEntityType,
  type ElabLink,
  type ElabStatus,
  type ElabStep,
  type ElabUpload,
  type ElabUser,
  type ElabftwClient,
  type EntityExtras,
  formatComments,
  formatCompound,
  formatCompoundList,
  formatPubchemHits,
  toNativeEntity,
  formatEntityFull,
  formatEntityList,
  formatLinks,
  formatRevisionBody,
  formatRevisions,
  formatSteps,
  formatUploads,
  formatUser,
  formatUserList,
} from '../../client';
import { z } from 'zod';
import type { ClientRegistry } from '../clients';
import type { ElabMcpConfig } from '../config';
import { entityTypeSchema, guard, text } from './helpers';
import {
  assertTeam,
  clientFor,
  effectiveTeam,
  entityScope,
  filterByTeam,
  teamParamSchema,
} from './team-guard';

const listInput = z.object({
  entityType: entityTypeSchema,
  team: teamParamSchema,
  q: z
    .string()
    .optional()
    .describe('Full-text search against title and body.'),
  extended: z
    .string()
    .optional()
    .describe(
      'Advanced elabftw query DSL, e.g. `rating:5 and tag:"buffer" and date:>2024-01-01`. Takes precedence over `q`.'
    ),
  category: z.number().int().optional().describe('Filter by category id.'),
  status: z.number().int().optional().describe('Filter by status id.'),
  tags: z
    .array(z.number().int())
    .optional()
    .describe('Filter by tag ids (AND).'),
  owner: z
    .number()
    .int()
    .optional()
    .describe('Restrict to a specific owner userid.'),
  scope: z
    .enum(['self', 'team', 'everything'])
    .optional()
    .describe('Visibility scope. Defaults to the instance default.'),
  order: z
    .enum([
      'cat',
      'comment',
      'customid',
      'date',
      'id',
      'lastchange',
      'rating',
      'status',
      'title',
      'user',
    ])
    .optional(),
  sort: z.enum(['asc', 'desc']).optional(),
  state: z
    .enum(['normal', 'archived', 'deleted'])
    .optional()
    .describe('State filter (default: normal).'),
  limit: z.number().int().min(1).max(200).optional().describe('Default 25.'),
  offset: z.number().int().min(0).optional(),
});

const scopeMap = { self: 1, team: 2, everything: 3 } as const;
const stateMap = { normal: 1, archived: 2, deleted: 3 } as const;

/**
 * Check whether a user belongs to the given team. `/users` returns
 * both a `team` scalar (current team under the key) and a `teams`
 * array (full membership). Either may be missing depending on the
 * instance version; we accept both.
 */
function userInTeam(user: ElabUser, team: number): boolean {
  if (user.team === team) return true;
  if (Array.isArray(user.teams) && user.teams.some((t) => t.id === team))
    return true;
  return false;
}

/**
 * Render an `ElabCategory[]` or `ElabStatus[]` as one row per line:
 *   `#<id> <title> (color=#<hex>) [default]`
 * The `(color=...)` segment is omitted when no color is defined. The
 * `[default]` marker only appears when `is_default` is truthy. elabftw
 * stores hex colors without a leading `#` on the wire; we prepend it.
 */
function formatCategoriesOrStatuses(
  rows: Array<ElabCategory | ElabStatus>,
  noun: 'categories' | 'statuses'
): string {
  if (!rows || rows.length === 0) return `No ${noun} defined for this team.`;
  return rows
    .map((r) => {
      const colorRaw = typeof r.color === 'string' ? r.color.trim() : '';
      const colorSegment = colorRaw
        ? ` (color=#${colorRaw.replace(/^#/, '')})`
        : '';
      const defaultMarker = r.is_default ? ' [default]' : '';
      return `#${r.id} ${r.title}${colorSegment}${defaultMarker}`;
    })
    .join('\n');
}

type IncludeKey = 'steps' | 'comments' | 'attachments' | 'links';
type UnfinishedEntry = {
  id: number;
  title: string;
  steps: Array<[string, string]>;
};
type LinkKind = 'experiments' | 'items' | 'compounds';

/**
 * A sub-resource array embedded in a single-entity GET. eLabFTW's
 * `AbstractEntity::readOne` inlines steps, uploads, comments and the
 * three link lists, so the entity fetched by `assertTeam` already carries
 * them; a separate sub-resource GET is only needed when a version omits
 * one (then this returns undefined).
 */
function embedded<T>(entity: ElabEntity, key: string): T[] | undefined {
  const value = entity[key];
  return Array.isArray(value) ? (value as T[]) : undefined;
}

/**
 * Links of one kind, from the entity GET when embedded, else from the
 * sub-resource endpoint.
 */
async function linksOf(
  client: ElabftwClient,
  entityType: ElabEntityType,
  entity: ElabEntity,
  kind: 'experiments' | 'items'
): Promise<ElabLink[]> {
  return (
    embedded<ElabLink>(entity, `${kind}_links`) ??
    client.listLinks(entityType, entity.id, kind)
  );
}

async function compoundLinksOf(
  client: ElabftwClient,
  entityType: ElabEntityType,
  entity: ElabEntity
): Promise<ElabCompound[]> {
  return (
    embedded<ElabCompound>(entity, 'compounds_links') ??
    client.listCompoundLinks(entityType, entity.id)
  );
}

/**
 * Collect the requested sub-resources of an entity already fetched (and
 * team-checked) by `assertTeam`, so each entity is fetched once. Reused by
 * `elab_get` and `elab_get_bulk`.
 */
async function fetchEntityWithExtras(
  client: ElabftwClient,
  entityType: ElabEntityType,
  entity: ElabEntity,
  include: readonly IncludeKey[] | undefined
): Promise<{ entity: ElabEntity; extras: EntityExtras }> {
  if (!include || include.length === 0) {
    return { entity, extras: {} };
  }
  const want = new Set(include);
  const id = entity.id;
  const wantLinks = want.has('links');
  const [steps, comments, attachments, linksExp, linksItems, compoundLinks] =
    await Promise.all([
      want.has('steps')
        ? (embedded<ElabStep>(entity, 'steps') ??
          client.listSteps(entityType, id))
        : undefined,
      want.has('comments')
        ? (embedded<ElabComment>(entity, 'comments') ??
          client.listComments(entityType, id))
        : undefined,
      want.has('attachments')
        ? (embedded<ElabUpload>(entity, 'uploads') ??
          client.listUploads(entityType, id))
        : undefined,
      wantLinks ? linksOf(client, entityType, entity, 'experiments') : undefined,
      wantLinks ? linksOf(client, entityType, entity, 'items') : undefined,
      wantLinks ? compoundLinksOf(client, entityType, entity) : undefined,
    ]);
  const links = wantLinks
    ? [...(linksExp ?? []), ...(linksItems ?? [])]
    : undefined;
  return {
    entity,
    extras: { steps, comments, attachments, links, compoundLinks },
  };
}

/** File extension per `elab_export` format, for the fallback filename. */
const EXPORT_EXTENSIONS = {
  csv: 'csv',
  json: 'json',
  pdf: 'pdf',
  pdfa: 'pdf',
  zip: 'zip',
  zipa: 'zip',
  eln: 'eln',
  elnhtml: 'eln',
  qrpdf: 'pdf',
  qrpng: 'png',
} as const;

/** Text returned inline up to this size; anything larger goes to disk. */
const MAX_INLINE_TEXT = 100 * 1024;

const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'csv', 'tsv', 'tab', 'json', 'jsonl', 'ndjson', 'md',
  'markdown', 'xml', 'html', 'htm', 'svg', 'log', 'yaml', 'yml', 'toml',
  'ini', 'cfg', 'conf', 'tex', 'bib', 'ris', 'rtf', 'sql', 'py', 'r', 'm',
  'js', 'ts', 'sh', 'jdx', 'dx', 'jcamp', 'cif', 'mol', 'sdf', 'mol2',
  'pdb', 'xyz', 'smi', 'fasta', 'fa', 'gb', 'gbk', 'asc', 'dat', 'out',
]);

function extensionOf(filename: string): string {
  return /\.([A-Za-z0-9]{1,10})$/.exec(filename)?.[1]?.toLowerCase() ?? '';
}

function isTextContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase().split(';')[0]!.trim();
  return (
    ct.startsWith('text/') ||
    /[/+](json|xml|csv)$/.test(ct) ||
    ct === 'application/x-yaml' ||
    ct === 'application/yaml'
  );
}

/**
 * Reduce an untrusted filename to a safe single path component: no
 * directories, no leading dots, only `[A-Za-z0-9._-]`, bounded length.
 */
function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-120);
  return cleaned || 'file';
}

/** `filename` from a Content-Disposition header (RFC 6266), if any. */
function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // fall through to the plain parameter
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(header);
  return plain?.[1]?.trim() || undefined;
}

interface DeliverInput {
  bytes: ArrayBuffer;
  /** Display filename (from upload metadata or Content-Disposition). */
  filename: string;
  /** Prefix that makes the on-disk name unique, e.g. `experiments-12-upload-34`. */
  diskPrefix: string;
  contentType: string | null;
  downloadDir: string | null | undefined;
}

/**
 * Return a downloaded file to the agent. Text (by extension or HTTP
 * Content-Type, and valid UTF-8) up to {@link MAX_INLINE_TEXT} is returned
 * inline. Everything else is written to `downloadDir` and the absolute path
 * returned; without a download dir (hosted mode) only metadata is returned.
 * Never base64: it costs ~1.3 tokens/byte and agents cannot use it.
 */
async function deliverFile(input: DeliverInput): Promise<string> {
  const { bytes, filename, contentType, downloadDir } = input;
  const size = bytes.byteLength;
  const ct = contentType?.split(';')[0]?.trim() || 'unknown';
  const header = `${filename} (${ct}, ${size} bytes)`;

  const textLike =
    TEXT_EXTENSIONS.has(extensionOf(filename)) || isTextContentType(contentType);
  if (textLike && size <= MAX_INLINE_TEXT) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
        new Uint8Array(bytes)
      );
      return `${header}:\n\n${decoded}`;
    } catch {
      // Not valid UTF-8 despite the name — treat as binary below.
    }
  }

  const why = !textLike
    ? 'binary'
    : size > MAX_INLINE_TEXT
      ? `text larger than the ${MAX_INLINE_TEXT / 1024} KB inline limit`
      : 'not valid UTF-8 text';
  if (!downloadDir) {
    return (
      `${header}\nNot returned: the file is ${why}, and this server has no download directory ` +
      '(hosted mode cannot hand files to the client). Open it in the elabftw web UI instead.'
    );
  }
  const dir = resolve(downloadDir);
  const target = resolve(
    dir,
    `${sanitizeFilename(input.diskPrefix)}-${sanitizeFilename(filename)}`
  );
  if (!target.startsWith(dir + sep)) {
    throw new Error(`Refusing to write outside the download directory: ${target}`);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(target, new Uint8Array(bytes));
  return `${header}\nSaved to: ${target}\n(${why}; read it from that path.)`;
}

/** Native view of an entity with the requested sub-resources nested in. */
function nativeWithExtras(
  entity: ElabEntity,
  extras: EntityExtras
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...toNativeEntity(entity) };
  if (extras.steps) out.steps = extras.steps;
  if (extras.comments) out.comments = extras.comments;
  if (extras.attachments) out.attachments = extras.attachments;
  if (extras.links) out.links = extras.links;
  if (extras.compoundLinks) out.compounds_links = extras.compoundLinks;
  return out;
}

/**
 * Run an array of async factories in chunks of `size`, sequentially
 * between chunks, parallel within one. Used by bulk fetch to avoid
 * opening 50 sockets at once.
 */
async function chunkedAll<T>(
  factories: Array<() => Promise<T>>,
  size: number
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < factories.length; i += size) {
    const slice = factories.slice(i, i + size).map((fn) => fn());
    const results = await Promise.all(slice);
    for (const r of results) out.push(r);
  }
  return out;
}

export function registerReadTools(
  server: McpServer,
  registry: ClientRegistry,
  config: ElabMcpConfig
): void {
  const revealUsers = config.revealUserIdentities;
  const formatOpts = { revealUsers };
  server.tool(
    'elab_search',
    'Search experiments, items, templates, or items_types within one team. Results are filtered to that team. Use `extended` for the elabftw DSL (rating:, tag:, date:, category:) when you need precise filters.',
    listInput.shape as Record<string, unknown>,
    async (args) => {
      const input = args as z.infer<typeof listInput>;
      const team = effectiveTeam(registry, input.team);
      const client = clientFor(registry, input.team);
      return guard(
        async () => {
          const rows = await client.list(input.entityType as ElabEntityType, {
            q: input.q,
            extended: input.extended,
            cat: input.category,
            status: input.status,
            tags: input.tags,
            owner: input.owner,
            scope: input.scope ? scopeMap[input.scope] : undefined,
            order: input.order,
            sort: input.sort,
            state: input.state ? stateMap[input.state] : undefined,
            limit: input.limit ?? 25,
            offset: input.offset,
          });
          return filterByTeam(rows, team);
        },
        (rows) =>
          text(
            rows.length
              ? `${rows.length} result(s) in team ${team}:\n${formatEntityList(rows)}`
              : `No matches in team ${team}.`
          )
      );
    }
  );

  server.tool(
    'elab_get',
    'Fetch one entity: body, category, status, tags, extra fields. `include` adds steps / comments / attachments / links in the same call. `format`: `markdown` (default; full body, safe to edit and write back), `html` (raw), `text` (2000-char preview). `view: \"native\"` returns the raw record as JSON, accepted back by `elab_update_entity({native})`.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
      include: z
        .array(z.enum(['steps', 'comments', 'attachments', 'links']))
        .optional()
        .describe(
          'Sub-resources to include.'
        ),
      format: z
        .enum(['text', 'markdown', 'html'])
        .optional()
        .describe(
          'Body format (prose view).'
        ),
      view: z
        .enum(['prose', 'native'])
        .optional()
        .describe(
          '`prose` (default) or `native` JSON.'
        ),
    },
    async (args) => {
      const { entityType, id, team, include, format, view } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
        include?: Array<'steps' | 'comments' | 'attachments' | 'links'>;
        format?: 'text' | 'markdown' | 'html';
        view?: 'prose' | 'native';
      };
      return guard(
        async () => {
          const { client, entity } = await entityScope(registry, team, entityType, id);
          const fetched = await fetchEntityWithExtras(client, entityType, entity, include);
          return { ...fetched, metadata: client.parseMetadata(fetched.entity) };
        },
        ({ entity, extras, metadata }) => {
          if (view === 'native') {
            return text(JSON.stringify(nativeWithExtras(entity, extras), null, 2));
          }
          return text(
            formatEntityFull(entity, metadata, extras, {
              ...formatOpts,
              format: format ?? 'markdown',
            })
          );
        }
      );
    }
  );

  server.tool(
    'elab_get_bulk',
    'Fetch up to 50 entities of one kind in one call, with the same `include` / `format` / `view` options as `elab_get`. Fails if any id belongs to another team.',
    {
      entityType: entityTypeSchema,
      ids: z
        .array(z.number().int().positive())
        .min(1)
        .max(50)
        .describe('Entity ids (max 50) — same `entityType` for all.'),
      team: teamParamSchema,
      include: z
        .array(z.enum(['steps', 'comments', 'attachments', 'links']))
        .optional()
        .describe(
          'Sub-resources to include.'
        ),
      format: z
        .enum(['text', 'markdown', 'html'])
        .optional()
        .describe('Body rendering. Same options as `elab_get`.'),
      view: z
        .enum(['prose', 'native'])
        .optional()
        .describe(
          '`prose` (default) or `native` JSON array.'
        ),
    },
    async (args) => {
      const { entityType, ids, team, include, format, view } = args as {
        entityType: ElabEntityType;
        ids: number[];
        team?: number;
        include?: Array<'steps' | 'comments' | 'attachments' | 'links'>;
        format?: 'text' | 'markdown' | 'html';
        view?: 'prose' | 'native';
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          const factories = ids.map((id) => async () => {
            const entity = await assertTeam(client, entityType, id, t);
            return fetchEntityWithExtras(client, entityType, entity, include);
          });
          return chunkedAll(factories, 8);
        },
        (results) => {
          if (results.length === 0) return text('No entities requested.');
          if (view === 'native') {
            const arr = results.map(({ entity, extras }) =>
              nativeWithExtras(entity, extras)
            );
            return text(JSON.stringify(arr, null, 2));
          }
          const blocks = results.map(({ entity, extras }, i) => {
            const body = formatEntityFull(
              entity,
              client.parseMetadata(entity),
              extras,
              { ...formatOpts, format: format ?? 'markdown' }
            );
            return `<!-- result ${i + 1}/${results.length} -->\n${body}`;
          });
          return text(blocks.join('\n\n---\n\n'));
        }
      );
    }
  );

  server.tool(
    'elab_list_attachments',
    'List files attached to an entity. Returns id, filename, size, and any caption. Use `elab_download_attachment` to fetch bytes.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, team } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          return client.listUploads(entityType, id);
        },
        (uploads) => text(formatUploads(uploads))
      );
    }
  );

  server.tool(
    'elab_download_attachment',
    'Download an attachment. Text files (by extension — txt, csv, tsv, json, md, xml, html, log, jcamp, … — or by Content-Type) up to 100 KB are returned inline. ' +
      (config.downloadDir
        ? 'Binary files and larger text files are saved to the local download directory and the tool returns the absolute path, size and filename — open the file from that path.'
        : 'Binary files and larger text files cannot be delivered by this server; the tool returns their metadata only.'),
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      uploadId: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, uploadId, team } = args as {
        entityType: ElabEntityType;
        id: number;
        uploadId: number;
        team?: number;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          const meta = await client.getUpload(entityType, id, uploadId);
          const resp = await client.downloadUpload(entityType, id, uploadId);
          const bytes = await resp.arrayBuffer();
          return deliverFile({
            bytes,
            filename:
              meta.real_name ?? meta.long_name ?? `upload-${uploadId}`,
            diskPrefix: `${entityType}-${id}-upload-${uploadId}`,
            contentType: resp.headers.get('content-type'),
            downloadDir: config.downloadDir,
          });
        },
        (out) => text(out)
      );
    }
  );

  server.tool(
    'elab_list_comments',
    'List comments on an entity in creation order.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, team } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          return client.listComments(entityType, id);
        },
        (comments) => text(formatComments(comments, formatOpts))
      );
    }
  );

  server.tool(
    'elab_list_steps',
    'List checklist steps on an entity. Unfinished steps are shown as [ ], finished as [x].',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, team } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          return client.listSteps(entityType, id);
        },
        (steps) => text(formatSteps(steps))
      );
    }
  );

  server.tool(
    'elab_list_links',
    'List an entity\u2019s outgoing links. `targetKind=experiments` → linked experiments; `items` → linked items (resources); `compounds` → linked compounds (from the compound catalog); `all` (default) → all three merged. Rows render as `<kind> #<id> <title> [<category>]`, compounds as `compounds #<id> <name> | <CAS or CID>`.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      targetKind: z
        .enum(['experiments', 'items', 'compounds', 'all'])
        .optional()
        .describe('Default `all`: experiment, item and compound links merged.'),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, targetKind, team } = args as {
        entityType: ElabEntityType;
        id: number;
        targetKind?: LinkKind | 'all';
        team?: number;
      };
      const kind = targetKind ?? 'all';
      return guard(
        async () => {
          const { client, entity } = await entityScope(registry, team, entityType, id);
          const [exp, items, compounds] = await Promise.all([
            kind === 'all' || kind === 'experiments'
              ? linksOf(client, entityType, entity, 'experiments')
              : [],
            kind === 'all' || kind === 'items'
              ? linksOf(client, entityType, entity, 'items')
              : [],
            kind === 'all' || kind === 'compounds'
              ? compoundLinksOf(client, entityType, entity)
              : [],
          ]);
          return { links: [...exp, ...items], compounds };
        },
        ({ links, compounds }) => text(formatLinks(links, compounds))
      );
    }
  );

  server.tool(
    'elab_list_unfinished_steps',
    'List open checklist steps in the team, grouped by entity kind. `scope=user` (default): entries you own; `scope=team`: every entry of the team you can read. Only entries belonging to the resolved team are returned. Useful for cohort triage (e.g. which students still have unfinished safety-check steps).',
    {
      scope: z
        .enum(['user', 'team'])
        .optional()
        .describe('`user` (default): your own entries. `team`: all readable entries of the team.'),
      team: teamParamSchema,
    },
    async (args) => {
      const { scope, team } = args as { scope?: 'user' | 'team'; team?: number };
      const client = clientFor(registry, team);
      return guard(
        async () => {
          // Rows carry no `team`, so `filterByTeam` can't apply. eLabFTW
          // only restricts `entity.team` to the key's team with
          // `scope=team`; the default (own entries) also returns the
          // user's entries from their other teams. Intersect the two.
          const teamRows = await client.listUnfinishedSteps({ scope: 'team' });
          if (scope === 'team') return teamRows;
          const own = await client.listUnfinishedSteps();
          const inTeam = (
            kind: 'experiments' | 'items'
          ): UnfinishedEntry[] => {
            const ids = new Set((teamRows[kind] ?? []).map((e) => e.id));
            return (own[kind] ?? []).filter((e) => ids.has(e.id));
          };
          return { experiments: inTeam('experiments'), items: inTeam('items') };
        },
        (data) => {
          const lines: string[] = [];
          const render = (
            kind: 'experiments' | 'items',
            entries: UnfinishedEntry[]
          ): void => {
            if (!entries || entries.length === 0) return;
            lines.push(`## ${kind} (${entries.length})`);
            for (const e of entries) {
              lines.push(`- ${kind}/${e.id} ${e.title}`);
              for (const [sid, body] of e.steps ?? []) {
                const trimmed = String(body ?? '').replace(/\s+/g, ' ').trim();
                const snippet =
                  trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
                lines.push(`  - #${sid}: ${snippet}`);
              }
            }
          };
          render('experiments', data.experiments ?? []);
          render('items', data.items ?? []);
          return text(lines.length === 0 ? 'No unfinished steps.' : lines.join('\n'));
        }
      );
    }
  );

  server.tool(
    'elab_list_templates',
    'List experiment templates (`experiments_templates`) available in a team. Instantiate one with `elab_create_entity(experiments, template=<id>)`. Resource templates are listed by `elab_list_items_types`.',
    {
      q: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
      team: teamParamSchema,
    },
    async (args) => {
      const { q, limit, offset, team } = args as {
        q?: string;
        limit?: number;
        offset?: number;
        team?: number;
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          const rows = await client.listTemplates({
            q,
            limit: limit ?? 25,
            offset,
          });
          return filterByTeam(rows, t);
        },
        (rows) => text(formatEntityList(rows))
      );
    }
  );

  server.tool(
    'elab_list_items_types',
    'List resource templates (`items_types`, e.g. \"Antibody\", \"Reagent\"); instantiate one with `elab_create_entity(items, template=<id>)`. Resource categories are a separate list (`elab_list_items_categories`).',
    {
      q: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      team: teamParamSchema,
    },
    async (args) => {
      const { q, limit, team } = args as {
        q?: string;
        limit?: number;
        team?: number;
      };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          const rows = await client.listItemsTypes({ q, limit: limit ?? 50 });
          return filterByTeam(rows, t);
        },
        (rows) => text(formatEntityList(rows))
      );
    }
  );

  server.tool(
    'elab_list_tags',
    'List tags in a team, optionally filtered by a query string.',
    {
      q: z.string().optional(),
      team: teamParamSchema,
    },
    async (args) => {
      const { q, team } = args as { q?: string; team?: number };
      const client = clientFor(registry, team);
      return guard(
        () => client.listTags({ q }),
        (tags) =>
          text(
            tags.length
              ? tags
                  .map(
                    (tag) =>
                      `#${tag.id} ${tag.tag}${tag.item_count != null ? ` (${tag.item_count})` : ''}`
                  )
                  .join('\n')
              : 'No tags.'
          )
      );
    }
  );

  server.tool(
    'elab_list_events',
    'List scheduler / booking events. Pass `start` and `end` as ISO dates (YYYY-MM-DD or full ISO 8601) to bound the range. Filter by `item` to see bookings for one bookable resource.',
    {
      start: z.string().optional(),
      end: z.string().optional(),
      item: z.number().int().optional(),
      team: teamParamSchema,
    },
    async (args) => {
      const input = args as {
        start?: string;
        end?: string;
        item?: number;
        team?: number;
      };
      const t = effectiveTeam(registry, input.team);
      const client = clientFor(registry, input.team);
      return guard(
        async () => {
          const events = await client.listEvents({
            start: input.start,
            end: input.end,
            item: input.item,
          });
          return filterByTeam(events, t);
        },
        (events) =>
          text(
            events.length
              ? events
                  .map(
                    (e) =>
                      `#${e.id} ${e.title ?? '(untitled)'} | item=${e.item} | ${e.start} → ${e.end}`
                  )
                  .join('\n')
              : 'No events in range.'
          )
      );
    }
  );

  server.tool(
    'elab_me',
    'Return the authenticated caller\u2019s user record: userid, name, email, team memberships, admin flags.',
    { team: teamParamSchema },
    async (args) => {
      const { team } = args as { team?: number };
      const client = clientFor(registry, team);
      return guard(
        () => client.me(),
        (user) =>
          text(
            [
              `userid=${user.userid}`,
              `name=${user.fullname ?? `${user.firstname ?? ''} ${user.lastname ?? ''}`.trim()}`,
              `email=${user.email ?? '?'}`,
              `current_team=${user.team ?? '?'}`,
              user.is_sysadmin
                ? 'role=sysadmin'
                : user.is_admin
                  ? 'role=admin'
                  : 'role=user',
            ]
              .filter(Boolean)
              .join(' | ')
          )
      );
    }
  );

  server.tool(
    'elab_info',
    'Return instance metadata: elabftw version, PHP version, and aggregate counts. Useful as a sanity-check call before heavy operations.',
    {},
    async () =>
      guard(
        () => registry.getDefault().info(),
        (info) => text(JSON.stringify(info, null, 2))
      )
  );

  server.tool(
    'elab_list_revisions',
    'List body revisions for an entity in chronological order. Reveals when the body was edited and by whom — useful for cohort review to spot last-minute edits or copy-paste between students. Availability is per-instance (elabftw can disable revisions in config); 400/404 is returned as a "no history" error.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, team } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          return client.listRevisions(entityType, id);
        },
        (revisions) => text(formatRevisions(revisions, formatOpts))
      );
    }
  );

  server.tool(
    'elab_get_revision',
    'Fetch the body of a specific revision. Body is rendered through the same markdown path as `elab_get` (tables + link hrefs preserved). Pair with `elab_list_revisions` to pick a `revisionId`.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      revisionId: z.number().int().positive(),
      team: teamParamSchema,
      format: z
        .enum(['text', 'markdown', 'html'])
        .optional()
        .describe(
          'Body format: `markdown` (default), `html` or `text`.'
        ),
    },
    async (args) => {
      const { entityType, id, revisionId, team, format } = args as {
        entityType: ElabEntityType;
        id: number;
        revisionId: number;
        team?: number;
        format?: 'text' | 'markdown' | 'html';
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          return client.getRevision(entityType, id, revisionId);
        },
        (rev) =>
          text(
            formatRevisionBody(rev, {
              ...formatOpts,
              format: format ?? 'markdown',
            })
          )
      );
    }
  );

  server.tool(
    'elab_list_extra_fields',
    'List an entity\'s extra fields with their full definition (type, options, units, group, position, required / readonly), grouped as in the UI. Use before changing a field\'s definition.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, team } = args as {
        entityType: ElabEntityType;
        id: number;
        team?: number;
      };
      return guard(
        async () => {
          const { client, entity } = await entityScope(registry, team, entityType, id);
          return client.parseMetadata(entity);
        },
        (metadata) => {
          if (!metadata || !metadata.extra_fields || Object.keys(metadata.extra_fields).length === 0) {
            return text(
              `No extra fields on ${entityType.slice(0, -1)} #${id}. ` +
                'Use `elab_set_extra_field` to add one, or `elab_clone_extra_fields_schema` to copy a schema from a template / items_type.'
            );
          }
          const groups = metadata.elabftw?.extra_fields_groups ?? [];
          const groupNameById = new Map<number, string>();
          for (const g of groups) groupNameById.set(g.id, g.name);

          // Bucket fields by group_id. Fields without a `group_id` (or one not
          // in the groups list) go to the default `-1` bucket.
          const buckets = new Map<number, Array<[string, typeof metadata.extra_fields[string]]>>();
          for (const [name, field] of Object.entries(metadata.extra_fields)) {
            const rawGid = typeof field.group_id === 'number' ? field.group_id : -1;
            const gid = groupNameById.has(rawGid) ? rawGid : -1;
            if (!buckets.has(gid)) buckets.set(gid, []);
            buckets.get(gid)!.push([name, field]);
          }
          // Sort buckets: declared groups (in their declared order), then -1.
          const sortedGids: number[] = [];
          for (const g of groups) {
            if (buckets.has(g.id)) sortedGids.push(g.id);
          }
          if (buckets.has(-1)) sortedGids.push(-1);

          const lines: string[] = [];
          for (const gid of sortedGids) {
            const header =
              gid === -1
                ? '(no group / id=-1)'
                : `group=${groupNameById.get(gid) ?? '?'} (id=${gid})`;
            lines.push(header);
            const entries = buckets.get(gid)!;
            entries.sort(
              ([a, fa], [b, fb]) =>
                (typeof fa.position === 'number' ? fa.position : 999) -
                  (typeof fb.position === 'number' ? fb.position : 999) ||
                a.localeCompare(b)
            );
            for (const [name, field] of entries) {
              const valueRaw = field.value;
              let valueStr: string;
              if (valueRaw === undefined || valueRaw === null || valueRaw === '') {
                valueStr = '(empty)';
              } else if (Array.isArray(valueRaw)) {
                valueStr = valueRaw.length === 0 ? '(empty)' : valueRaw.join(', ');
              } else if (typeof valueRaw === 'object') {
                valueStr = JSON.stringify(valueRaw);
              } else {
                valueStr = String(valueRaw);
              }
              const unitStr = field.unit ? `${field.unit}` : '';
              const valueWithUnit =
                unitStr && valueStr !== '(empty)' ? `${valueStr} ${unitStr}` : valueStr;
              const cells: string[] = [
                `type=${field.type ?? '?'}`,
                `value=${valueWithUnit}`,
              ];
              if (typeof field.position === 'number')
                cells.push(`position=${field.position}`);
              if (field.required) cells.push('required=true');
              if (field.readonly) cells.push('readonly=true');
              if (field.allow_multi_values) cells.push('allow_multi_values=true');
              if (field.blank_value_on_duplicate)
                cells.push('blank_value_on_duplicate=true');
              if (Array.isArray(field.options) && field.options.length > 0)
                cells.push(`options=[${field.options.join(', ')}]`);
              if (Array.isArray(field.units) && field.units.length > 0)
                cells.push(`units=[${field.units.join(', ')}]`);
              if (field.description)
                cells.push(`description=${field.description}`);
              lines.push(`  - ${name} | ${cells.join(' | ')}`);
            }
            lines.push('');
          }
          // Strip trailing blank line.
          while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
          return text(lines.join('\n'));
        }
      );
    }
  );

  server.tool(
    'elab_list_experiments_categories',
    'List experiment categories (id, title, color; `[default]` marks the team default). Set one with `category` on create / update. Templates are a separate list (`elab_list_templates`).',
    { team: teamParamSchema },
    async (args) => {
      const { team } = args as { team?: number };
      const client = clientFor(registry, team);
      return guard(
        () => client.listExperimentsCategories(),
        (rows) => text(formatCategoriesOrStatuses(rows, 'categories'))
      );
    }
  );

  server.tool(
    'elab_list_items_categories',
    'List resource categories (eLabFTW 6.x; id, title, color). Set one with `category` on create / update. Their ids differ from resource templates (`elab_list_items_types`), even when titles match.',
    { team: teamParamSchema },
    async (args) => {
      const { team } = args as { team?: number };
      const client = clientFor(registry, team);
      return guard(
        () => client.listItemsCategories(),
        (rows) => text(formatCategoriesOrStatuses(rows, 'categories'))
      );
    }
  );

  server.tool(
    'elab_list_experiments_status',
    'List experiment statuses (workflow tags like "Running", "Success", "Need to be redone", "Fail"). The `status` arg on `elab_create_entity` / `elab_update_entity` takes an id from here. Returns `#<id> <title>` rows with the color hex if defined, and a `[default]` marker on the team default.',
    { team: teamParamSchema },
    async (args) => {
      const { team } = args as { team?: number };
      const client = clientFor(registry, team);
      return guard(
        () => client.listExperimentsStatus(),
        (rows) => text(formatCategoriesOrStatuses(rows, 'statuses'))
      );
    }
  );

  server.tool(
    'elab_list_items_status',
    'List item (resource) statuses defined in the team — workflow tags like "In stock", "Depleted", "Ordered". The `status` arg on `elab_create_entity(items, ...)` / `elab_update_entity` takes an id from here. Returns `#<id> <title>` rows with the color hex if defined, and a `[default]` marker on the team default.',
    { team: teamParamSchema },
    async (args) => {
      const { team } = args as { team?: number };
      const client = clientFor(registry, team);
      return guard(
        () => client.listItemsStatus(),
        (rows) => text(formatCategoriesOrStatuses(rows, 'statuses'))
      );
    }
  );

  server.tool(
    'elab_search_compounds',
    'Search the team\'s compound catalog by name, CAS, PubChem CID, InChI / SMILES or formula (`q`; omit to list all). One row per compound with its hazards; full record via `elab_get_compound`.',
    {
      q: z
        .string()
        .optional()
        .describe(
          'Full-text query across compound name, CAS, PubChem CID, InChI key, SMILES, formula.'
        ),
      limit: z.number().int().positive().max(100).optional(),
      offset: z.number().int().nonnegative().optional(),
      team: teamParamSchema,
    },
    async (args) => {
      const { q, limit, offset, team } = args as {
        q?: string;
        limit?: number;
        offset?: number;
        team?: number;
      };
      const client = clientFor(registry, team);
      return guard(
        () => client.listCompounds({ q, limit, offset }),
        (rows) => text(formatCompoundList(rows))
      );
    }
  );

  server.tool(
    'elab_search_pubchem',
    'Look up a compound on PubChem without storing it, to check what `elab_create_compound_from_pubchem` would import. Give exactly one of `cid`, `cas`, `name` (names are ambiguous).',
    {
      cid: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('PubChem CID. Returns a single record.'),
      cas: z
        .string()
        .optional()
        .describe('CAS registry number (e.g. `58-08-2`). Returns 0..N hits.'),
      name: z
        .string()
        .optional()
        .describe('Substance name (free-text). Returns 0..N hits. Ambiguous — prefer cid/cas.'),
      team: teamParamSchema,
    },
    async (args) => {
      const { cid, cas, name, team } = args as {
        cid?: number;
        cas?: string;
        name?: string;
        team?: number;
      };
      const provided = [cid, cas, name].filter((v) => v !== undefined).length;
      if (provided !== 1) {
        return text(
          'Provide exactly one of `cid` / `cas` / `name`. Use `cid` when you know the PubChem id, `cas` for a registry number, `name` only as a last resort.'
        );
      }
      const client = clientFor(registry, team);
      return guard(
        async () => {
          if (cid !== undefined) {
            const hit = await client.searchPubchemCid(cid);
            return [hit];
          }
          if (cas !== undefined) return client.searchPubchemCas(cas);
          return client.searchPubchemName(name!);
        },
        (hits) => text(formatPubchemHits(hits))
      );
    }
  );

  server.tool(
    'elab_get_compound',
    'Fetch a single compound by id and render its identifying fields (name, CAS, PubChem CID, ChEMBL, EC, formula, MW, IUPAC name, SMILES, InChIKey) plus a hazard summary. Compounds linked to an entity are listed by `elab_list_links` (and `elab_get` with `include=["links"]`); this tool gives the full record.',
    {
      id: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { id, team } = args as { id: number; team?: number };
      const client = clientFor(registry, team);
      return guard(
        () => client.getCompound(id),
        (compound) => text(formatCompound(compound))
      );
    }
  );

  server.tool(
    'elab_list_extra_field_names',
    'List every extra-field name used across the instance, with usage counts. Names only; a field\'s type and options are on its template (`elab_list_extra_fields` on the experiments_templates / items_types entry).',
    {},
    async () =>
      guard(
        () => registry.getDefault().listExtraFieldNames(),
        (descriptors) =>
          text(
            descriptors.length
              ? descriptors
                  .map(
                    (d) => `${d.extra_fields_key} (used ${d.frequency}×)`
                  )
                  .join('\n')
              : 'No extra_fields keys on this instance. Call `elab_get` on an `experiments_templates` or `items_types` id to inspect a schema directly.'
          )
      )
  );

  server.tool(
    'elab_list_teams',
    'List teams on the instance the caller has access to. Returns id + name so you can map the `team=<id>` field in search results back to a group name.',
    {},
    async () =>
      guard(
        () => registry.getDefault().listTeams(),
        (teams) => {
          const configured = new Set(registry.teams());
          return text(
            teams.length
              ? teams
                  .map((t) => {
                    const marker = configured.has(t.id) ? ' ★ key configured' : '';
                    const orgid = t.orgid ? ` (orgid=${t.orgid})` : '';
                    return `#${t.id} ${t.name}${orgid}${marker}`;
                  })
                  .join('\n')
              : 'No teams visible.'
          );
        }
      )
  );

  server.tool(
    'elab_search_users',
    'Search users by name or email (empty `q` lists all visible). Needs a team-admin key. Names and emails appear only when the server sets ELABFTW_REVEAL_USER_IDENTITIES=true; otherwise rows show user ids and teams.',
    {
      q: z
        .string()
        .optional()
        .describe('Search string. Matches against name/email. Use "" (empty) to list every user the caller can see.'),
      team: teamParamSchema,
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Cap on rows returned (default 100).'),
    },
    async (args) => {
      const input = args as { q?: string; team?: number; limit?: number };
      const t = effectiveTeam(registry, input.team);
      const client = clientFor(registry, input.team);
      const limit = input.limit ?? 100;
      return guard(
        async () => {
          const users = await client.searchUsers(input.q ?? '');
          const scoped = users.filter((u) => userInTeam(u, t));
          return scoped.slice(0, limit);
        },
        (users) =>
          text(
            users.length
              ? `${users.length} user(s) in team ${t}:\n${formatUserList(users, formatOpts)}`
              : `No users visible in team ${t}. (If you expected results, check that the API key is admin: \`/users\` requires team-admin or sysadmin.)`
          )
      );
    }
  );

  server.tool(
    'elab_get_user',
    'Fetch one user by `userid`. Resolves the opaque `userid` field seen on experiments/items/comments to identity + role. ' +
      (revealUsers
        ? 'Identity reveal is ENABLED: output includes name + email.'
        : 'Identity reveal is DISABLED (default): output includes userid + team memberships + role only. Set `ELABFTW_REVEAL_USER_IDENTITIES=true` to surface names/emails.'),
    {
      userid: z.number().int().positive(),
      team: teamParamSchema,
    },
    async (args) => {
      const { userid, team } = args as { userid: number; team?: number };
      const client = clientFor(registry, team);
      return guard(
        () => client.getUser(userid),
        (user) => text(formatUser(user, formatOpts))
      );
    }
  );

  server.tool(
    'elab_list_team_users',
    'List every user who is a member of a team. Works by calling `/users` under the team\'s admin key and filtering by team membership client-side (eLabFTW has no dedicated team-roster endpoint). Requires a team-admin key for the given team. ' +
      (revealUsers
        ? 'Identity reveal is ENABLED: rows include name + email.'
        : 'Identity reveal is DISABLED (default): rows include userid + role only.'),
    {
      team: teamParamSchema,
    },
    async (args) => {
      const { team } = args as { team?: number };
      const t = effectiveTeam(registry, team);
      const client = clientFor(registry, team);
      return guard(
        async () => {
          const users = await client.searchUsers('');
          return users.filter((u) => userInTeam(u, t));
        },
        (users) =>
          text(
            users.length
              ? `${users.length} member(s) in team ${t}:\n${formatUserList(users, formatOpts)}`
              : `No members visible in team ${t}. The API key likely lacks team-admin privileges; mint a key from a team-admin account.`
          )
      );
    }
  );

  server.tool(
    'elab_configured_teams',
    'List the teams this MCP server has API keys configured for. Use this to discover valid values for the `team` parameter on other tools.',
    {},
    async () => {
      const entries = [...registry.entries()];
      const defaultTeam = registry.defaultTeam();
      if (entries.length === 0) return text('No teams configured.');
      return text(
        entries
          .map(
            (e) =>
              `team=${e.team}${e.label ? ` (${e.label})` : ''}${e.team === defaultTeam ? ' [default]' : ''}`
          )
          .join('\n')
      );
    }
  );

  server.tool(
    'elab_export',
    'Export an entity to pdf / pdfa / zip / zipa / eln / elnhtml / qrpng / qrpdf / csv / json. csv and json (text, up to 100 KB) are returned inline. ' +
      (config.downloadDir
        ? 'Binary formats (pdf, zip, eln, elnhtml — a zip archive —, qr*) and larger text are saved to the local download directory; the tool returns the absolute path, size and filename. '
        : 'Binary formats and larger text cannot be delivered by this server; the tool returns their metadata only. ') +
      'Set `changelog=true` to include revision history in PDFs.',
    {
      entityType: entityTypeSchema,
      id: z.number().int().positive(),
      format: z.enum([
        'csv',
        'json',
        'pdf',
        'pdfa',
        'zip',
        'zipa',
        'eln',
        'elnhtml',
        'qrpdf',
        'qrpng',
      ]),
      changelog: z.boolean().optional(),
      team: teamParamSchema,
    },
    async (args) => {
      const { entityType, id, format, changelog, team } = args as {
        entityType: ElabEntityType;
        id: number;
        format: keyof typeof EXPORT_EXTENSIONS;
        changelog?: boolean;
        team?: number;
      };
      return guard(
        async () => {
          const { client } = await entityScope(registry, team, entityType, id);
          const resp = await client.export(entityType, id, format, {
            changelog,
          });
          const bytes = await resp.arrayBuffer();
          const filename =
            filenameFromDisposition(resp.headers.get('content-disposition')) ??
            `${entityType}-${id}.${EXPORT_EXTENSIONS[format]}`;
          return deliverFile({
            bytes,
            filename,
            diskPrefix: `${entityType}-${id}-export`,
            contentType: resp.headers.get('content-type'),
            downloadDir: config.downloadDir,
          });
        },
        (out) => text(out)
      );
    }
  );
}
