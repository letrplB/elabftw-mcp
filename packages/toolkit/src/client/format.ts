import TurndownService from 'turndown';
import type {
  ElabComment,
  ElabEntity,
  ElabLink,
  ElabMetadata,
  ElabRevision,
  ElabStep,
  ElabUpload,
  ElabUser,
} from './types';

/**
 * Common formatter options. `revealUsers` is opt-in at the MCP config
 * layer (`ELABFTW_REVEAL_USER_IDENTITIES`); the default is `false`, so
 * formatters that touch PII render `user <id>` unless the caller says
 * otherwise.
 */
export interface FormatOptions {
  revealUsers?: boolean;
}

/**
 * Compact, LLM-friendly renderers for elabftw resources.
 *
 * These are deliberately terse — they exist to keep context-window cost
 * low in agent tools. Callers that need structured data should hand back
 * the raw JSON instead.
 */

const MAX_BODY_PREVIEW = 600;
const MAX_TEXT_BODY = 2000;
const MAX_MARKDOWN_BODY = 4000;

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Lossless HTML → markdown.
 *
 * The previous `stripHtml` dropped tables (columns → flat list of
 * numbers) and link hrefs. Lab bodies routinely embed Ansatz-tables
 * and literature links, so reviewers lost quantitative structure and
 * citations. Turndown preserves both. A custom GFM-style table rule
 * handles `<table>`/`<thead>`/`<tbody>` because the stock turndown
 * ruleset does not.
 *
 * Turndown ships a pure-JS DOM (via `@mixmark-io/domino`), so this
 * works in Node 18+ with no jsdom dependency.
 */
function htmlToMarkdown(html: string): string {
  const converter = createMarkdownConverter();
  const cleaned = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');
  try {
    return converter.turndown(cleaned).trim();
  } catch {
    return stripHtml(html);
  }
}

let _converter: TurndownService | undefined;
function createMarkdownConverter(): TurndownService {
  if (_converter) return _converter;
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });
  td.addRule('table', {
    filter: ['table'],
    replacement: (_content, node) => renderTable(node as TableLikeNode),
  });
  td.addRule('table-rows', {
    filter: ['thead', 'tbody', 'tfoot', 'tr', 'th', 'td'],
    replacement: () => '',
  });
  _converter = td;
  return td;
}

/**
 * Shape turndown's DOM wrapper exposes for table nodes. We only rely
 * on the subset we actually use, avoiding a DOM lib dep.
 */
interface ElementLike {
  tagName: string;
  textContent: string | null;
  children: ArrayLike<ElementLike>;
}
interface TableLikeNode extends ElementLike {
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
}

function renderTable(table: TableLikeNode): string {
  const rows: string[][] = [];
  const domRows = Array.from(table.querySelectorAll('tr'));
  for (const row of domRows) {
    const cells = Array.from(row.children)
      .filter((el) => {
        const tag = el.tagName.toLowerCase();
        return tag === 'th' || tag === 'td';
      })
      .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim());
    if (cells.length) rows.push(cells);
  }
  if (rows.length === 0) return '';
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const cols = header.length || rows[0]?.length || 0;
  const pad = (cells: string[]): string[] => {
    const out = cells.slice(0, cols);
    while (out.length < cols) out.push('');
    return out;
  };
  const lines: string[] = [];
  lines.push(`| ${pad(header).join(' | ')} |`);
  lines.push(`| ${Array.from({ length: cols }, () => '---').join(' | ')} |`);
  for (const row of body) lines.push(`| ${pad(row).join(' | ')} |`);
  return `\n\n${lines.join('\n')}\n\n`;
}

function truncate(text: string, limit = MAX_BODY_PREVIEW): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… (+${text.length - limit} chars)`;
}

export function formatEntitySummary(entity: ElabEntity): string {
  const parts: string[] = [];
  parts.push(`#${entity.id} ${entity.title ?? '(untitled)'}`);
  if (entity.team != null) parts.push(`team=${entity.team}`);
  if (entity.userid != null) parts.push(`user=${entity.userid}`);
  if (entity.category_title)
    parts.push(`category=${entity.category_title}`);
  if (entity.status_title) parts.push(`status=${entity.status_title}`);
  if (entity.date) parts.push(`date=${entity.date}`);
  if (entity.rating) parts.push(`★${entity.rating}`);
  if (entity.locked) parts.push('[locked]');
  if (entity.tags) parts.push(`tags=${entity.tags}`);
  return parts.join(' | ');
}

export function formatEntityList(entities: ElabEntity[]): string {
  if (entities.length === 0) return 'No results.';
  return entities.map(formatEntitySummary).join('\n');
}

export interface EntityExtras {
  steps?: ElabStep[];
  comments?: ElabComment[];
  attachments?: ElabUpload[];
  links?: ElabLink[];
}

export interface FormatEntityOptions extends FormatOptions {
  /**
   * Body rendering. `'text'` = legacy regex stripper (backwards-
   * compatible, no tables/links). `'markdown'` = lossless HTML →
   * markdown with tables and links preserved. `'html'` = raw body,
   * caller handles.
   */
  format?: 'text' | 'markdown' | 'html';
}

export function formatEntityFull(
  entity: ElabEntity,
  metadata?: ElabMetadata | null,
  extras: EntityExtras = {},
  options: FormatEntityOptions = {}
): string {
  const lines: string[] = [];
  lines.push(`# ${entity.title ?? '(untitled)'} (#${entity.id})`);
  lines.push('');
  const meta: string[] = [];
  if (entity.elabid) meta.push(`elabid=${entity.elabid}`);
  if (entity.date) meta.push(`date=${entity.date}`);
  if (entity.category_title) meta.push(`category=${entity.category_title}`);
  if (entity.status_title) meta.push(`status=${entity.status_title}`);
  if (entity.rating) meta.push(`rating=${entity.rating}/5`);
  if (entity.locked) meta.push('locked');
  if (entity.tags) meta.push(`tags=${entity.tags}`);
  if (meta.length) lines.push(meta.join(' | '));

  if (entity.body) {
    lines.push('');
    lines.push('## Body');
    lines.push(renderBody(entity.body, options.format ?? 'text'));
  }

  if (metadata?.extra_fields) {
    const entries = Object.entries(metadata.extra_fields);
    if (entries.length) {
      lines.push('');
      lines.push('## Extra fields');
      for (const [name, field] of entries) {
        const value =
          field.value === undefined || field.value === null
            ? '(empty)'
            : typeof field.value === 'object'
              ? JSON.stringify(field.value)
              : String(field.value);
        const unit = field.unit ? ` ${field.unit}` : '';
        lines.push(`- ${name} (${field.type}): ${value}${unit}`);
      }
    }
  }

  if (extras.attachments) {
    lines.push('');
    lines.push('## Attachments');
    lines.push(formatUploads(extras.attachments));
  }
  if (extras.steps) {
    lines.push('');
    lines.push('## Steps');
    lines.push(formatSteps(extras.steps));
  }
  if (extras.comments) {
    lines.push('');
    lines.push('## Comments');
    lines.push(formatComments(extras.comments, options));
  }
  if (extras.links) {
    lines.push('');
    lines.push('## Links');
    lines.push(formatLinks(extras.links));
  }

  return lines.join('\n');
}

function renderBody(body: string, format: 'text' | 'markdown' | 'html'): string {
  if (format === 'html') return body;
  if (format === 'markdown') {
    return truncate(htmlToMarkdown(body), MAX_MARKDOWN_BODY);
  }
  return truncate(stripHtml(body), MAX_TEXT_BODY);
}

export function formatUploads(uploads: ElabUpload[]): string {
  if (uploads.length === 0) return 'No attachments.';
  return uploads
    .map((u) => {
      const name = u.real_name ?? u.long_name ?? 'file';
      const ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase();
      const size = u.filesize ? ` ${u.filesize} bytes` : '';
      const kind = ext ? ` [${ext}]` : '';
      const comment = u.comment ? ` — ${u.comment}` : '';
      return `#${u.id} ${name}${kind}${size}${comment}`;
    })
    .join('\n');
}

export function formatComments(
  comments: ElabComment[],
  options: FormatOptions = {}
): string {
  if (comments.length === 0) return 'No comments.';
  const reveal = options.revealUsers === true;
  return comments
    .map((c) => {
      const who = reveal && c.fullname ? c.fullname : `user ${c.userid}`;
      return `#${c.id} ${who} @ ${c.created_at ?? '?'}:\n${c.comment}`;
    })
    .join('\n\n');
}

function describeUserName(user: ElabUser): string {
  if (user.fullname?.trim()) return user.fullname.trim();
  const joined = `${user.firstname ?? ''} ${user.lastname ?? ''}`.trim();
  return joined || `user ${user.userid}`;
}

function describeUserTeams(user: ElabUser): string {
  if (Array.isArray(user.teams) && user.teams.length > 0) {
    return user.teams.map((t) => t.id).join(',');
  }
  return user.team != null ? String(user.team) : '?';
}

function describeUserRole(user: ElabUser): string {
  if (user.is_sysadmin) return 'sysadmin';
  if (user.is_admin) return 'admin';
  return 'user';
}

export function formatUser(
  user: ElabUser,
  options: FormatOptions = {}
): string {
  const reveal = options.revealUsers === true;
  const role = describeUserRole(user);
  const teams = describeUserTeams(user);
  if (!reveal) {
    return `userid=${user.userid} | teams=[${teams}] | role=${role}`;
  }
  const parts: string[] = [
    `userid=${user.userid}`,
    `name=${describeUserName(user)}`,
  ];
  if (user.email) parts.push(`email=${user.email}`);
  if (user.orcid) parts.push(`orcid=${user.orcid}`);
  parts.push(`teams=[${teams}]`);
  parts.push(`role=${role}`);
  if (user.archived) parts.push('archived');
  return parts.join(' | ');
}

export function formatUserList(
  users: ElabUser[],
  options: FormatOptions = {}
): string {
  if (users.length === 0) return 'No users.';
  return users.map((u) => formatUser(u, options)).join('\n');
}

export function formatSteps(steps: ElabStep[]): string {
  if (steps.length === 0) return 'No steps.';
  return steps
    .map((s) => {
      const done = s.finished ? '[x]' : '[ ]';
      const deadline = s.deadline ? ` (due ${s.deadline})` : '';
      return `${done} #${s.id} ${s.body}${deadline}`;
    })
    .join('\n');
}

export function formatRevisionBody(
  revision: ElabRevision,
  options: FormatEntityOptions = {}
): string {
  const reveal = options.revealUsers === true;
  const who =
    reveal && revision.fullname
      ? revision.fullname
      : revision.userid != null
        ? `user ${revision.userid}`
        : 'unknown';
  const lines: string[] = [];
  lines.push(`# Revision #${revision.id}`);
  lines.push(
    `created_at=${revision.created_at ?? '?'} | by=${who}${
      revision.body_size != null ? ` | ${revision.body_size} bytes` : ''
    }`
  );
  if (revision.body) {
    lines.push('');
    lines.push('## Body');
    lines.push(renderBody(revision.body, options.format ?? 'markdown'));
  }
  return lines.join('\n');
}

export function formatRevisions(
  revisions: ElabRevision[],
  options: FormatOptions = {}
): string {
  if (revisions.length === 0) return 'No revisions.';
  const reveal = options.revealUsers === true;
  return revisions
    .map((r) => {
      const who =
        reveal && r.fullname
          ? r.fullname
          : r.userid != null
            ? `user ${r.userid}`
            : 'unknown';
      const when = r.created_at ?? '?';
      const size = r.body_size != null ? ` | ${r.body_size} bytes` : '';
      return `#${r.id} | ${when} | ${who}${size}`;
    })
    .join('\n');
}

export function formatLinks(links: ElabLink[]): string {
  if (links.length === 0) return 'No links.';
  return links
    .map(
      (l) =>
        `#${l.entityid} ${l.title ?? '(untitled)'}${l.category_title ? ` [${l.category_title}]` : ''}`
    )
    .join('\n');
}
