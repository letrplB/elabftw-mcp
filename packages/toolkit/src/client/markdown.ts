import { Marked } from 'marked';

/**
 * Markdown → HTML for entity bodies.
 *
 * Agents author bodies in markdown, but elabftw users edit entries in the
 * TinyMCE rich-text editor, which only opens for `content_type=1` (HTML).
 * Storing markdown as `content_type=2` forces the markdown editor, and
 * flipping such an entry to the rich-text editor in the UI does not render
 * the markdown — the user is left with one unformatted paragraph. So the
 * write tools convert markdown to HTML client-side and store it as HTML.
 *
 * `breaks: true` keeps single newlines as `<br>`: lab notes use them for
 * line-per-observation logs, and users expect what they see in the source.
 */
const marked = new Marked({ gfm: true, breaks: true, async: false });

export function markdownToHtml(markdown: string): string {
  return (marked.parse(markdown) as string).trim();
}

/**
 * elabftw HTML-escapes markdown bodies on save (`>` → `&gt;`, `&` →
 * `&amp;`), which breaks blockquotes and leaks entities into the text.
 * Undo that before parsing a stored markdown body.
 */
export function decodeStoredMarkdown(body: string): string {
  return body
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

const LEADING_BLOCK_TAG =
  /^<(p|div|section|article|h[1-6]|ul|ol|table|pre|blockquote|hr|figure)\b[^>]*\/?>/i;

/**
 * True when the body is an HTML document rather than markdown. Only a
 * leading block-level tag counts: markdown routinely contains inline HTML
 * (`H<sub>2</sub>O`, `<br>`), and TinyMCE always wraps content in blocks.
 */
export function looksLikeHtml(body: string): boolean {
  return LEADING_BLOCK_TAG.test(body.trimStart());
}
