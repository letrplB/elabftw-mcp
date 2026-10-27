import TurndownService from 'turndown';
import { decodeStoredMarkdown } from './markdown';
import type {
  ElabComment,
  ElabCompound,
  ElabEntity,
  ElabLink,
  ElabMetadata,
  ElabPubchemHit,
  ElabRevision,
  ElabStep,
  ElabUpload,
  ElabUser,
} from './types';
import { COMPOUND_HAZARD_FLAGS } from './types';

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
 *
 * Bodies rendered as `markdown` or `html` are never truncated: agents read
 * a body, edit it and write it back, so a cut body would destroy data on
 * the round-trip. Only the lossy `text` view is capped, and its truncation
 * notice is emitted outside the body text.
 */

const MAX_TEXT_BODY = 2000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  deg: '°',
  micro: 'µ',
  plusmn: '±',
  times: '×',
  divide: '÷',
  minus: '−',
  middot: '·',
  bull: '•',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  le: '≤',
  ge: '≥',
  ne: '≠',
  asymp: '≈',
  infin: '∞',
  rarr: '→',
  larr: '←',
  harr: '↔',
  uarr: '↑',
  darr: '↓',
  sup1: '¹',
  sup2: '²',
  sup3: '³',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  permil: '‰',
  percnt: '%',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  sect: '§',
  para: '¶',
  Aring: 'Å',
  aring: 'å',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
  eacute: 'é',
  egrave: 'è',
};

// Greek letters (`&alpha;` … `&omega;`, `&Alpha;` … `&Omega;`) — common in
// lab notes (α-helix, Δ, µ, λ_max).
const GREEK = [
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho',
  'sigmaf', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega',
];
GREEK.forEach((name, i) => {
  NAMED_ENTITIES[name] = String.fromCodePoint(0x3b1 + i);
  if (name !== 'sigmaf') {
    const upper = name.charAt(0).toUpperCase() + name.slice(1);
    NAMED_ENTITIES[upper] = String.fromCodePoint(0x391 + i);
  }
});

/**
 * Decode HTML character references in one left-to-right pass. A single
 * pass is what makes `&amp;lt;` come out as the literal text `&lt;`
 * (sequential `.replace()` calls would decode it twice). Numeric
 * references (`&#8451;`, `&#x2103;`) are decoded; unknown named
 * references are left as-is.
 */
function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g,
    (match, ref: string) => {
      if (ref.startsWith('#')) {
        const code =
          ref[1] === 'x' || ref[1] === 'X'
            ? Number.parseInt(ref.slice(2), 16)
            : Number.parseInt(ref.slice(1), 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff)
          return match;
        if (code >= 0xd800 && code <= 0xdfff) return match;
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[ref] ?? match;
    }
  );
}

function stripHtml(html: string): string {
  const withoutTags = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/(div|h[1-6]|li|tr|ul|ol|table|blockquote|pre)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(withoutTags)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * HTML → markdown via Turndown, with a custom table rule (Turndown's stock
 * ruleset has none). Tables that GFM can express become pipe tables; the
 * rest are emitted as raw HTML so no cell is lost.
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
    replacement: (_content, node) => renderTable(node as unknown as TableNode),
  });
  // Sub/superscripts carry meaning in lab notes (H<sub>2</sub>O, cm<sup>-1</sup>)
  // and markdown has no syntax for them; keep them as inline HTML.
  td.keep(['sub', 'sup']);
  td.addRule('table-rows', {
    filter: ['caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'],
    replacement: () => '',
  });
  // Turndown's default `escape` backslash-escapes underscores, brackets,
  // parens, dots, hashes, etc. to prevent every conceivable markdown
  // ambiguity. The converter is configured with `emDelimiter: '*'`, so
  // underscores in source content can never be confused for emphasis — yet
  // the default escape still mangles `d_H_DLS_nm` → `d\_H\_DLS\_nm`,
  // breaking downstream tools that grep on field names. Escape only the
  // characters that genuinely break markdown rendering: backslash,
  // asterisk, backtick.
  td.escape = (s: string): string =>
    s.replace(/\\/g, '\\\\').replace(/\*/g, '\\*').replace(/`/g, '\\`');
  _converter = td;
  return td;
}

/**
 * Subset of the DOM element API (domino, via Turndown) the table renderer
 * relies on. Declared locally to avoid a DOM lib dependency.
 */
interface ElementNode {
  tagName: string;
  textContent: string | null;
  children: ArrayLike<ElementNode>;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  attributes: ArrayLike<{ name: string }>;
  querySelectorAll(selector: string): ArrayLike<ElementNode>;
  cloneNode(deep: boolean): ElementNode;
  outerHTML: string;
}
type TableNode = ElementNode;

function spanOf(cell: ElementNode, attr: 'colspan' | 'rowspan'): number {
  const n = Number.parseInt(cell.getAttribute(attr) ?? '1', 10);
  return Number.isFinite(n) && n > 1 ? n : 1;
}

/** Direct `<tr>` rows of this table (not rows of nested tables). */
function ownRows(table: ElementNode): ElementNode[] {
  const rows: ElementNode[] = [];
  const visit = (el: ElementNode): void => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'tr') rows.push(child);
      else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot')
        visit(child);
    }
  };
  visit(table);
  return rows;
}

function cellsOf(row: ElementNode): ElementNode[] {
  return Array.from(row.children).filter((el) => {
    const tag = el.tagName.toLowerCase();
    return tag === 'th' || tag === 'td';
  });
}

/**
 * The table as raw HTML, minus TinyMCE's editor-internal `data-mce-*`
 * attributes. Blank lines are collapsed because a blank line terminates a
 * raw HTML block in CommonMark/GFM.
 */
function tableAsHtml(table: ElementNode): string {
  const clone = table.cloneNode(true);
  const all = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (const el of all) {
    for (const attr of Array.from(el.attributes).map((a) => a.name)) {
      if (attr.startsWith('data-mce-')) el.removeAttribute(attr);
    }
  }
  return `\n\n${clone.outerHTML.replace(/\n\s*\n/g, '\n')}\n\n`;
}

/** Inline markdown for one cell: links/emphasis kept, pipes escaped. */
function renderCell(cell: ElementNode): string {
  let md: string;
  try {
    md = createMarkdownConverter().turndown(
      cell as unknown as TurndownService.Node
    );
  } catch {
    md = cell.textContent ?? '';
  }
  return md
    .trim()
    .replace(/\s*\n+\s*/g, '<br>')
    .replace(/\|/g, '\\|');
}

function renderTable(table: TableNode): string {
  const rows = ownRows(table);
  if (rows.length === 0) return '';

  // GFM can't express row spans or nested tables. Emit those as HTML
  // (which GFM renders and markdown→HTML conversion passes through).
  const hasNested = table.querySelectorAll('table').length > 0;
  const hasRowspan = rows.some((r) =>
    cellsOf(r).some((c) => spanOf(c, 'rowspan') > 1)
  );
  if (hasNested || hasRowspan) return tableAsHtml(table);

  const grid: string[][] = [];
  for (const row of rows) {
    const out: string[] = [];
    for (const cell of cellsOf(row)) {
      out.push(renderCell(cell));
      for (let i = 1; i < spanOf(cell, 'colspan'); i++) out.push('');
    }
    if (out.length) grid.push(out);
  }
  if (grid.length === 0) return '';
  const cols = Math.max(...grid.map((r) => r.length));
  const pad = (cells: string[]): string[] => {
    const out = [...cells];
    while (out.length < cols) out.push('');
    return out;
  };

  const lines: string[] = [];
  const caption = Array.from(table.children).find(
    (el) => el.tagName.toLowerCase() === 'caption'
  );
  const captionText = caption?.textContent?.replace(/\s+/g, ' ').trim();
  if (captionText) lines.push(`**${captionText}**`, '');
  const [header = [], ...body] = grid;
  lines.push(`| ${pad(header).join(' | ')} |`);
  lines.push(`| ${Array.from({ length: cols }, () => '---').join(' | ')} |`);
  for (const row of body) lines.push(`| ${pad(row).join(' | ')} |`);
  return `\n\n${lines.join('\n')}\n\n`;
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
  /** Compounds linked to the entity (`/{entity}/{id}/compounds_links`). */
  compoundLinks?: ElabCompound[];
}

export interface FormatEntityOptions extends FormatOptions {
  /**
   * Body rendering. `'text'` = regex-stripped plain text, capped at
   * 2000 chars (no tables/links). `'markdown'` = HTML → markdown with
   * tables and links preserved, never truncated. `'html'` = raw body,
   * never truncated.
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
    pushBody(lines, entity.body, options.format ?? 'text', entity.content_type);
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
  if (extras.links || extras.compoundLinks) {
    lines.push('');
    lines.push('## Links');
    lines.push(formatLinks(extras.links ?? [], extras.compoundLinks));
  }

  return lines.join('\n');
}

/**
 * Render a stored body for the prose view. Returns the body text and, for
 * the capped `text` view only, a truncation notice that callers must place
 * outside the body (a separate paragraph after it) so the notice can never
 * be mistaken for — or written back as — body content.
 */
function renderBody(
  body: string,
  format: 'text' | 'markdown' | 'html',
  contentType?: number
): { body: string; notice?: string } {
  if (format === 'html') return { body };
  if (format === 'markdown') {
    // elabftw stores bodies natively as markdown when content_type=2.
    // Round-tripping through Turndown (HTML → MD) introduces lossy
    // artifacts (list-marker reflow, table-cell whitespace normalization,
    // residual escapes), so a stored-markdown body is returned as-is.
    if (contentType === 2) return { body: decodeStoredMarkdown(body) };
    return { body: htmlToMarkdown(body) };
  }
  const plain = stripHtml(body);
  if (plain.length <= MAX_TEXT_BODY) return { body: plain };
  return {
    body: plain.slice(0, MAX_TEXT_BODY),
    notice: `_[text view truncated: showing ${MAX_TEXT_BODY} of ${plain.length} chars. Use format="markdown" or format="html" for the full body.]_`,
  };
}

function pushBody(
  lines: string[],
  body: string,
  format: 'text' | 'markdown' | 'html',
  contentType?: number
): void {
  const rendered = renderBody(body, format, contentType);
  lines.push('');
  lines.push('## Body');
  lines.push(rendered.body);
  if (rendered.notice) {
    lines.push('');
    lines.push(rendered.notice);
  }
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
    pushBody(
      lines,
      revision.body,
      options.format ?? 'markdown',
      revision.content_type
    );
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

/**
 * One line per link. Entity links render as `<kind> #<id> <title>
 * [<category>]` (kind from the row's `type`, e.g. `experiments` / `items`);
 * compound links, when given, as `compounds #<id> <name> | <CAS or CID>`.
 */
export function formatLinks(
  links: ElabLink[],
  compounds: ElabCompound[] = []
): string {
  if (links.length === 0 && compounds.length === 0) return 'No links.';
  const rows = links.map((l) => {
    const kind = typeof l.type === 'string' && l.type ? `${l.type} ` : '';
    const cat = l.category_title ? ` [${l.category_title}]` : '';
    return `${kind}#${l.entityid} ${l.title ?? '(untitled)'}${cat}`;
  });
  for (const c of compounds) {
    const id = c.cas_number
      ? `CAS=${c.cas_number}`
      : c.pubchem_cid != null && c.pubchem_cid !== ''
        ? `CID=${c.pubchem_cid}`
        : '';
    rows.push(`compounds #${c.id} ${c.name ?? '(unnamed)'}${id ? ` | ${id}` : ''}`);
  }
  return rows.join('\n');
}

/**
 * Human labels for compound hazard flags, keyed by the snake_case column
 * name. The PubChem preview uses camelCase keys for the same flags
 * (`is_gas_under_pressure` ↔ `isGasUnderPressure`); {@link camelFlag}
 * derives those so both renderers share this one table.
 */
const HAZARD_LABELS: Record<string, string> = {
  is_corrosive: 'corrosive',
  is_explosive: 'explosive',
  is_flammable: 'flammable',
  is_gas_under_pressure: 'gas-under-pressure',
  is_hazardous2env: 'env-hazard',
  is_hazardous2health: 'health-hazard',
  is_oxidising: 'oxidising',
  is_toxic: 'toxic',
  is_radioactive: 'radioactive',
  is_serious_health_hazard: 'serious-health-hazard',
  is_antibiotic: 'antibiotic',
  is_antibiotic_precursor: 'antibiotic-precursor',
  is_drug: 'drug',
  is_drug_precursor: 'drug-precursor',
  is_explosive_precursor: 'explosive-precursor',
  is_cmr: 'CMR',
  is_nano: 'nano',
  is_controlled: 'controlled',
  is_ed2health: 'endocrine-disruptor-health',
  is_ed2env: 'endocrine-disruptor-env',
  is_pbt: 'PBT',
  is_pmt: 'PMT',
  is_vpvb: 'vPvB',
  is_vpvm: 'vPvM',
};

function camelFlag(flag: string): string {
  return flag.replace(/_([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase());
}

function hazardLabel(flag: string): string {
  return HAZARD_LABELS[flag] ?? flag.replace(/^is_/, '');
}

/**
 * Compact hazard summary for a compound (`⚠ corrosive, toxic`). Returns
 * the empty string when no flags are set.
 */
function formatCompoundHazards(c: ElabCompound): string {
  const set: string[] = [];
  for (const flag of COMPOUND_HAZARD_FLAGS) {
    if (c[flag]) set.push(hazardLabel(flag));
  }
  return set.length ? `⚠ ${set.join(', ')}` : '';
}

/**
 * Render one compound as a multi-line block. Identifying fields first
 * (name + key IDs + structure), then hazards. Skips fields that are
 * null / empty so the output stays compact for substances that don't
 * have a full PubChem record attached.
 */
export function formatCompound(c: ElabCompound): string {
  const lines: string[] = [];
  lines.push(`#${c.id} ${c.name}`);
  const ids: string[] = [];
  if (c.cas_number) ids.push(`CAS=${c.cas_number}`);
  if (c.pubchem_cid != null && c.pubchem_cid !== '')
    ids.push(`PubChem=${c.pubchem_cid}`);
  if (c.chembl_id) ids.push(`ChEMBL=${c.chembl_id}`);
  if (c.ec_number) ids.push(`EC=${c.ec_number}`);
  if (ids.length) lines.push(ids.join(' | '));
  const hasFormula = !!c.molecular_formula;
  const hasMw =
    !!c.molecular_weight &&
    c.molecular_weight !== '0.00' &&
    c.molecular_weight !== '0';
  if (hasFormula || hasMw) {
    const mw = hasMw ? ` (MW=${c.molecular_weight})` : '';
    lines.push(`${c.molecular_formula ?? ''}${mw}`.trim());
  }
  if (c.iupac_name) lines.push(`IUPAC: ${c.iupac_name}`);
  if (c.smiles) lines.push(`SMILES: ${c.smiles}`);
  if (c.inchi_key) lines.push(`InChIKey: ${c.inchi_key}`);
  const hazards = formatCompoundHazards(c);
  if (hazards) lines.push(hazards);
  return lines.join('\n');
}

/**
 * Compact hazard summary for a PubChem preview hit. Same labels as
 * {@link formatCompoundHazards}, read from the camelCase keys the PubChem
 * importer uses (`isCorrosive`, `isHazardous2health`, …). The CID search
 * path returns no hazard flags; CAS / name paths do.
 */
function formatPubchemHazards(h: ElabPubchemHit): string {
  const set: string[] = [];
  for (const flag of COMPOUND_HAZARD_FLAGS) {
    if (h[camelFlag(flag)]) set.push(hazardLabel(flag));
  }
  return set.length ? `⚠ ${set.join(', ')}` : '';
}

/**
 * Render a list of PubChem-preview hits — the read-only response from
 * `elab_search_pubchem`. These are NOT compounds in the team catalog
 * (they have no elabftw id); the CID is the PubChem CID. Hand the CID
 * (or CAS) to `elab_create_compound_from_pubchem` to actually store
 * the substance.
 */
export function formatPubchemHits(hits: ElabPubchemHit[]): string {
  if (hits.length === 0) return 'No PubChem hits.';
  return hits
    .map((h) => {
      const ids: string[] = [`CID=${h.cid}`];
      if (h.cas) ids.push(`CAS=${h.cas}`);
      const mf = h.molecularFormula ? ` | ${h.molecularFormula}` : '';
      const mw = h.molecularWeight ? ` (MW=${h.molecularWeight})` : '';
      const hazards = formatPubchemHazards(h);
      const hazardSegment = hazards ? ` | ${hazards}` : '';
      return `${h.name} | ${ids.join(' ')}${mf}${mw}${hazardSegment}`;
    })
    .join('\n');
}

/**
 * Render a list of compounds as one row per line. Used by
 * `elab_search_compounds` — keeps the surface narrow so a 100-row hit
 * doesn't blow the context window.
 */
export function formatCompoundList(compounds: ElabCompound[]): string {
  if (compounds.length === 0) return 'No compounds.';
  return compounds
    .map((c) => {
      const id = c.cas_number
        ? c.cas_number
        : c.pubchem_cid != null && c.pubchem_cid !== ''
          ? `CID=${c.pubchem_cid}`
          : c.inchi_key ?? '';
      const idSegment = id ? ` | ${id}` : '';
      const mf = c.molecular_formula ? ` | ${c.molecular_formula}` : '';
      const hazards = formatCompoundHazards(c);
      const hazardSegment = hazards ? ` | ${hazards}` : '';
      return `#${c.id} ${c.name}${idSegment}${mf}${hazardSegment}`;
    })
    .join('\n');
}
