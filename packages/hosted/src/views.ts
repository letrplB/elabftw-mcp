/**
 * Self-contained HTML for the registration + management flows. Inline
 * styles, no JS framework, just one tiny copy-to-clipboard handler.
 *
 * Pages:
 *   - GET  /register         → renderRegisterForm
 *   - POST /register success → renderRegisterSuccess
 *   - GET  /manage           → renderManageLogin (paste eLabFTW key)
 *   - POST /manage / /mint / /revoke → renderManageList
 *   - any error              → renderError
 *
 * Kept deliberately plain: this is institutional infrastructure, not a
 * marketing site. Every byte of HTML the operator might need to audit
 * lives here.
 */

import type { Registration } from './store';

const LAYOUT_STYLE = `
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f7;
         margin: 0; padding: 40px 20px; color: #1d1d1f; }
  .card { max-width: 640px; margin: 0 auto; background: #fff;
          padding: 32px; border-radius: 12px; box-shadow: 0 2px 16px rgba(0,0,0,0.06); }
  h1 { font-size: 1.4em; margin: 0 0 8px; }
  h2 { font-size: 1.1em; margin: 28px 0 8px; }
  p { color: #4a4a52; line-height: 1.5; }
  label { display: block; margin: 18px 0 6px; font-weight: 600; font-size: 0.9em; }
  input { width: 100%; padding: 10px 12px; border: 1px solid #d2d2d7; border-radius: 8px;
          font: inherit; box-sizing: border-box; }
  input:focus { outline: 2px solid #0071e3; outline-offset: 1px; }
  button { background: #0071e3; color: #fff; border: 0; padding: 12px 16px;
           border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer;
           width: 100%; margin-top: 24px; }
  button:hover { background: #005bb5; }
  button.danger { background: #ff3b30; }
  button.danger:hover { background: #c1281f; }
  .copy-row { display: flex; gap: 8px; align-items: stretch; margin-top: 6px; }
  .copy-row .url { flex: 1; margin: 0; }
  .copy-btn { width: auto; margin: 0; padding: 0 14px; font-size: 0.85em;
              white-space: nowrap; min-width: 80px; }
  .copy-btn.copied { background: #34c759; }
  .field-label { color: #6e6e73; font-size: 0.8em; font-weight: 600;
                 text-transform: uppercase; letter-spacing: 0.04em;
                 margin-top: 14px; margin-bottom: 4px; }
  .url { background: #f5f5f7; padding: 14px; border-radius: 8px;
         font-family: ui-monospace, SF Mono, Menlo, monospace; font-size: 0.85em;
         word-break: break-all; border: 1px solid #e5e5ea; }
  .hint { color: #6e6e73; font-size: 0.85em; margin-top: 16px; }
  .footer { color: #86868b; font-size: 0.8em; text-align: center; margin-top: 24px; }
  a { color: #0071e3; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .token-list { margin-top: 16px; border: 1px solid #e5e5ea; border-radius: 8px;
                overflow: hidden; }
  .token-row { display: grid; grid-template-columns: 1fr auto; gap: 12px;
               padding: 14px 16px; border-top: 1px solid #e5e5ea; align-items: center; }
  .token-row:first-child { border-top: 0; }
  .token-row .meta { color: #6e6e73; font-size: 0.85em; margin-top: 4px; }
  .token-row .token-prefix { font-family: ui-monospace, SF Mono, Menlo, monospace;
                              color: #6e6e73; font-size: 0.85em; }
  .token-row .label-text { font-weight: 600; }
  .token-row .label-text.empty { color: #86868b; font-weight: 400; font-style: italic; }
  .token-row form { margin: 0; }
  .token-row form button { margin: 0; padding: 8px 14px; font-size: 0.85em;
                            width: auto; }
  .empty-state { padding: 24px 16px; text-align: center; color: #86868b;
                  font-size: 0.9em; }
  .new-token-banner { background: #e8f4ff; border: 1px solid #b3d7ff;
                       border-radius: 8px; padding: 14px 16px; margin: 18px 0; }
  .new-token-banner h2 { margin-top: 0; }
  .flash { padding: 10px 14px; border-radius: 8px; font-size: 0.9em;
           margin: 14px 0; }
  .flash.ok { background: #e8f9ee; border: 1px solid #b3e6c2; color: #1f7a3a; }
  .flash.err { background: #fdecea; border: 1px solid #f5c6c2; color: #a8261c; }
  .cross-link { margin-top: 18px; font-size: 0.9em; color: #6e6e73; }
`.trim();

const COPY_SCRIPT = `
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const value = btn.getAttribute('data-copy');
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fallback for browsers without async clipboard (insecure contexts).
      const ta = document.createElement('textarea');
      ta.value = value; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } finally { ta.remove(); }
    }
    const original = btn.textContent;
    btn.textContent = 'Copied';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1500);
  });
`.trim();

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(title: string, body: string, withScript = false): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)}</title>
<style>${LAYOUT_STYLE}</style>
</head>
<body>
<div class="card">
${body}
</div>
<p class="footer">elabftw MCP — hosted mode</p>
${withScript ? `<script>${COPY_SCRIPT}</script>` : ''}
</body>
</html>`;
}

function copyRow(value: string): string {
  return `<div class="copy-row">
  <div class="url">${escape(value)}</div>
  <button type="button" class="copy-btn" data-copy="${escape(value)}">Copy</button>
</div>`;
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function renderRegisterForm(defaultBaseUrl: string): string {
  return layout(
    'Register · elabftw MCP',
    `<h1>Register an MCP token</h1>
<p>Paste your eLabFTW API key to mint a personal MCP URL. Use that URL in
Claude Desktop, Claude mobile, or any other MCP-aware client.</p>

<form method="post" action="/register">
  <label for="apiKey">eLabFTW API key</label>
  <input id="apiKey" name="apiKey" type="password" required autocomplete="off"
         placeholder="3-cb2314b00d2845…">

  <label for="baseUrl">eLabFTW base URL</label>
  <input id="baseUrl" name="baseUrl" type="url" required
         value="${escape(defaultBaseUrl)}">

  <label for="label">Label (optional)</label>
  <input id="label" name="label" type="text"
         placeholder="e.g. Lab notebook · MacBook">

  <button type="submit">Generate MCP URL</button>
</form>

<p class="hint">Your key is stored on this server, encrypted only by file-system
permissions. Treat the resulting URL as a secret — anyone with it can act on
eLabFTW as you.</p>

<p class="cross-link">Already registered? <a href="/manage">Manage your tokens</a>.</p>`
  );
}

export interface RegisterSuccessOptions {
  /** Path of the manage page to deep-link from the success view. */
  manageUrl?: string;
}

export function renderRegisterSuccess(
  personalUrl: string,
  bearerUrl: string,
  bearerToken: string,
  options: RegisterSuccessOptions = {}
): string {
  const headerValue = `Bearer ${bearerToken}`;
  const manageUrl = options.manageUrl ?? '/manage';
  return layout(
    'Registered · elabftw MCP',
    `<h1>You're registered.</h1>

<p style="margin-top: 18px;"><strong>Recommended — Authorization header</strong></p>

<div class="field-label">URL</div>
${copyRow(bearerUrl)}

<div class="field-label">Header — name</div>
${copyRow('Authorization')}

<div class="field-label">Header — value</div>
${copyRow(headerValue)}

<p class="hint">Paste these into a client that supports custom MCP headers
(claude.ai Custom Connector, VS Code, mcp-inspector). Header-based auth
keeps the token out of access logs and browser history.</p>

<p style="margin-top: 28px;"><strong>Fallback — token in URL</strong></p>
${copyRow(personalUrl)}
<p class="hint">For older clients that only accept a URL. The MCP server
emits a <code>Deprecation</code> response header on every call when this
path is used.</p>

<p class="hint" style="margin-top: 24px;">The token does not expire on its
own. Lost the link? <a href="${escape(manageUrl)}">Manage your tokens</a>
— log in with any current eLabFTW key for this user to see and revoke it.</p>

<p style="margin-top: 24px;"><a href="/register">← Register another key</a></p>`,
    true
  );
}

export function renderError(message: string): string {
  return layout(
    'Error · elabftw MCP',
    `<h1>Something went wrong.</h1>
<p>${escape(message)}</p>
<p style="margin-top: 24px;"><a href="/register">← Back to registration</a></p>`
  );
}

export function renderManageLogin(
  defaultBaseUrl: string,
  errorMessage?: string
): string {
  return layout(
    'Manage tokens · elabftw MCP',
    `<h1>Manage your MCP tokens</h1>
<p>Paste any current eLabFTW API key to see every MCP token registered
for that user. Tokens are joined to your eLabFTW user, not to a specific
API key — rotating your eLabFTW key won't orphan them.</p>

${errorMessage ? `<div class="flash err">${escape(errorMessage)}</div>` : ''}

<form method="post" action="/manage">
  <label for="apiKey">eLabFTW API key</label>
  <input id="apiKey" name="apiKey" type="password" required autocomplete="off"
         placeholder="3-cb2314b00d2845…">

  <label for="baseUrl">eLabFTW base URL</label>
  <input id="baseUrl" name="baseUrl" type="url" required
         value="${escape(defaultBaseUrl)}">

  <button type="submit">Show my tokens</button>
</form>

<p class="cross-link">No tokens yet? <a href="/register">Register one</a>.</p>`
  );
}

export interface ManageUser {
  userid: number;
  fullname?: string;
  email?: string;
}

export interface ManageListOptions {
  /**
   * If a token was just minted, the success block (URL + Bearer header)
   * is rendered above the list. The plaintext token is only shown here
   * — the list itself only ever displays an 8-char prefix.
   */
  justMinted?: { personalUrl: string; bearerUrl: string; token: string };
  /** Flash message after a successful revoke. */
  justRevokedLabel?: string;
}

export function renderManageList(
  baseUrl: string,
  user: ManageUser,
  registrations: Registration[],
  options: ManageListOptions = {}
): string {
  const userLine = user.fullname
    ? `${user.fullname} · userid ${user.userid}`
    : `userid ${user.userid}`;

  const flashRevoked = options.justRevokedLabel
    ? `<div class="flash ok">Revoked: ${escape(options.justRevokedLabel)}</div>`
    : '';

  const newTokenBanner = options.justMinted
    ? `<div class="new-token-banner">
<h2>New token</h2>
<p>Copy these now — the plaintext value is only shown once.</p>
<div class="field-label">URL</div>
${copyRow(options.justMinted.bearerUrl)}
<div class="field-label">Header — name</div>
${copyRow('Authorization')}
<div class="field-label">Header — value</div>
${copyRow(`Bearer ${options.justMinted.token}`)}
<p class="hint" style="margin-top: 14px;">Fallback URL with token in query string:</p>
${copyRow(options.justMinted.personalUrl)}
</div>`
    : '';

  const rows = registrations.length
    ? `<div class="token-list">${registrations
        .map((r) => renderTokenRow(r, baseUrl))
        .join('')}</div>`
    : '<div class="token-list"><div class="empty-state">No tokens yet for this user on this instance.</div></div>';

  return layout(
    'Manage tokens · elabftw MCP',
    `<h1>Your MCP tokens</h1>
<p>${escape(userLine)} on <code>${escape(baseUrl)}</code></p>

${flashRevoked}
${newTokenBanner}

<h2>Tokens</h2>
${rows}

<h2>Mint a new token</h2>
<form method="post" action="/manage/mint">
  <input type="hidden" name="apiKey" value="${escape(getHiddenKey())}">
  <input type="hidden" name="baseUrl" value="${escape(baseUrl)}">
  <label for="label">Label (optional)</label>
  <input id="label" name="label" type="text"
         placeholder="e.g. Lab notebook · MacBook">
  <button type="submit">Mint new token</button>
</form>

<p class="hint" style="margin-top: 18px;">Re-submit your eLabFTW key from
<a href="/manage">the manage page</a> if this form complains — for security
the API key is not stored in your browser session.</p>`,
    true
  );
}

/**
 * Sentinel that the routes substitute with the real eLabFTW key inside
 * the form's hidden input. We never render the key itself — the
 * caller's POST handler wraps the rendered HTML and replaces this
 * marker via a separate, explicit pass.
 *
 * This is a layering escape hatch: views shouldn't know the key, but
 * the mint form needs to re-submit it. The route does the
 * substitution.
 */
export const HIDDEN_KEY_PLACEHOLDER = '__ELAB_KEY_PLACEHOLDER__';
function getHiddenKey(): string {
  return HIDDEN_KEY_PLACEHOLDER;
}

function renderTokenRow(reg: Registration, baseUrl: string): string {
  const labelDisplay = reg.label
    ? `<div class="label-text">${escape(reg.label)}</div>`
    : '<div class="label-text empty">(no label)</div>';

  const prefix = `${reg.token.slice(0, 8)}…`;

  return `<div class="token-row">
<div>
  ${labelDisplay}
  <div class="meta">
    <span class="token-prefix">${escape(prefix)}</span>
    · created ${escape(formatTimestamp(reg.createdAt))}
    · last used ${escape(formatTimestamp(reg.lastUsedAt))}
  </div>
</div>
<form method="post" action="/manage/revoke">
  <input type="hidden" name="apiKey" value="${escape(HIDDEN_KEY_PLACEHOLDER)}">
  <input type="hidden" name="baseUrl" value="${escape(baseUrl)}">
  <input type="hidden" name="token" value="${escape(reg.token)}">
  <button type="submit" class="danger" onclick="return confirm('Revoke this token? This cannot be undone.');">Revoke</button>
</form>
</div>`;
}
