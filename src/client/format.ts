import type {
  ElabComment,
  ElabEntity,
  ElabLink,
  ElabMetadata,
  ElabStep,
  ElabUpload,
} from './types';

/**
 * Compact, LLM-friendly renderers for elabftw resources.
 *
 * These are deliberately terse — they exist to keep context-window cost
 * low in agent tools. Callers that need structured data should hand back
 * the raw JSON instead.
 */

const MAX_BODY_PREVIEW = 600;

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

export function formatEntityFull(
  entity: ElabEntity,
  metadata?: ElabMetadata | null
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
    lines.push(truncate(stripHtml(entity.body), 2000));
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

  return lines.join('\n');
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

export function formatComments(comments: ElabComment[]): string {
  if (comments.length === 0) return 'No comments.';
  return comments
    .map(
      (c) =>
        `#${c.id} ${c.fullname ?? `user ${c.userid}`} @ ${c.created_at ?? '?'}:\n${c.comment}`
    )
    .join('\n\n');
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

export function formatLinks(links: ElabLink[]): string {
  if (links.length === 0) return 'No links.';
  return links
    .map(
      (l) =>
        `#${l.entityid} ${l.title ?? '(untitled)'}${l.category_title ? ` [${l.category_title}]` : ''}`
    )
    .join('\n');
}
