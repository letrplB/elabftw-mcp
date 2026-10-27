/**
 * Self-contained HTML for the registration + management flows. Inline
 * styles, no JS framework, just one tiny copy-to-clipboard handler.
 *
 * Pages:
 *   - GET  /register         → renderRegisterForm
 *   - POST /register success → renderRegisterSuccess
 *   - GET  /manage           → renderManageLogin (no session) or
 *                              renderManageList (logged in)
 *   - GET  /manage/<result>  → one-shot result pages (minted, revoked, …)
 *   - any error              → renderError
 *
 * Every interpolated value goes through `escape()` — including numbers,
 * so a future change to a field's type can't open an injection hole.
 * Manage forms carry only a CSRF token and a non-secret token id; the
 * eLabFTW API key and the bearer token are never rendered into a form.
 *
 * Kept deliberately plain: this is institutional infrastructure, not a
 * marketing site. Every byte of HTML the operator might need to audit
 * lives here.
 */

import { type Registration, tokenIdOf } from './store';

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
  .chips { margin-top: 6px; }
  .chip { display: inline-block; padding: 2px 8px; margin: 2px 4px 2px 0;
          border-radius: 999px; font-size: 0.75em; font-weight: 600;
          background: #eef1f5; color: #4a4a52; border: 1px solid #dde1e8; }
  .chip.team { background: #e8f1ff; color: #0040a0; border-color: #b3d0ff; }
  .chip.flag { background: #f4ecff; color: #5a2d9b; border-color: #d6c2f0; }
  .chip.flag.danger { background: #fdecea; color: #a8261c; border-color: #f5c6c2; }
  .chip-action { display: inline-flex; align-items: stretch; margin: 2px 4px 2px 0; }
  .chip-action .chip { margin: 0; border-top-right-radius: 0;
                       border-bottom-right-radius: 0; border-right: 0; }
  .chip-action button { width: auto; margin: 0; padding: 0 8px;
                        font-size: 0.7em; border-radius: 0 999px 999px 0;
                        background: #ff3b30; color: #fff; border: 1px solid #ff3b30; }
  .chip-action button:hover { background: #c1281f; border-color: #c1281f; }
  details.add-team-fold { margin-top: 10px; }
  details.add-team-fold summary { cursor: pointer; font-size: 0.85em;
                                   color: #0071e3; user-select: none;
                                   list-style: none; }
  details.add-team-fold summary::-webkit-details-marker { display: none; }
  details.add-team-fold summary::before { content: "+ "; font-weight: 700; }
  details.add-team-fold[open] summary::before { content: "− "; }
  details.add-team-fold form { margin-top: 10px; }
  details.add-team-fold input { font-size: 0.9em; padding: 8px 10px; }
  details.add-team-fold button { font-size: 0.9em; padding: 8px 14px;
                                  margin-top: 12px; }
  fieldset { border: 1px solid #e5e5ea; border-radius: 8px; padding: 12px 14px;
             margin: 18px 0 8px; }
  fieldset legend { padding: 0 6px; font-weight: 600; font-size: 0.9em; }
  .checkbox-row { display: flex; gap: 10px; align-items: flex-start;
                   margin: 10px 0; font-size: 0.9em; }
  .checkbox-row input[type="checkbox"] { width: 18px; height: 18px;
                                          margin: 1px 0 0; flex: 0 0 18px; }
  .checkbox-row .label-block { color: #4a4a52; }
  .checkbox-row .label-block .name { font-weight: 600; color: #1d1d1f;
                                      display: block; }
  .checkbox-row .label-block .hint { font-size: 0.85em; color: #6e6e73;
                                      margin: 2px 0 0; }
  .new-token-banner { background: #e8f4ff; border: 1px solid #b3d7ff;
                       border-radius: 8px; padding: 14px 16px; margin: 18px 0; }
  .new-token-banner h2 { margin-top: 0; }
  .flash { padding: 10px 14px; border-radius: 8px; font-size: 0.9em;
           margin: 14px 0; }
  .flash.ok { background: #e8f9ee; border: 1px solid #b3e6c2; color: #1f7a3a; }
  .flash.err { background: #fdecea; border: 1px solid #f5c6c2; color: #a8261c; }
  .cross-link { margin-top: 18px; font-size: 0.9em; color: #6e6e73; }
  select { width: 100%; padding: 10px 12px; border: 1px solid #d2d2d7;
           border-radius: 8px; font: inherit; background: #fff; }
  .checkbox-row input[type="checkbox"]:disabled + label { opacity: 0.6; }
  .capped { color: #a8261c; }
  button.link { background: none; color: #0071e3; width: auto; padding: 0;
                margin: 0; font-weight: 400; }
  button.link:hover { background: none; text-decoration: underline; }
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

function escape(s: string | number): string {
  return String(s)
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
  return `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

/**
 * Operator-level upper bounds on the per-token flags (the
 * `ELABFTW_ALLOW_*` / `ELABFTW_REVEAL_USER_IDENTITIES` env vars). A
 * flag whose cap is off is rendered disabled with an explanation —
 * ticking it would have no effect.
 */
export interface PermissionCaps {
  allowWrites: boolean;
  allowDestructive: boolean;
  revealUserIdentities: boolean;
}

interface PermissionValues {
  allowWrites: boolean;
  allowDestructive: boolean;
  revealUserIdentities: boolean;
}

const NO_PERMISSIONS: PermissionValues = {
  allowWrites: false,
  allowDestructive: false,
  revealUserIdentities: false,
};

function cappedHint(envVar: string): string {
  return `<span class="hint capped">Disabled by the server operator (${escape(envVar)} is off).</span>`;
}

/**
 * Three-checkbox permission group used on /register, the mint form,
 * and each token's edit form. Checkboxes default to off so a fresh
 * registration is least-privilege; the user explicitly opts in.
 *
 * The destructive box's enable-state is tied to the writes box via a
 * tiny inline script — when writes is unchecked, destructive becomes
 * disabled and unchecks itself. The server enforces the same rule.
 */
function permissionsFieldset(
  idPrefix: string,
  caps: PermissionCaps,
  current: PermissionValues = NO_PERMISSIONS
): string {
  const writesCapped = !caps.allowWrites;
  const destructiveCapped = !caps.allowDestructive || !caps.allowWrites;
  const revealCapped = !caps.revealUserIdentities;
  const w = `${idPrefix}-w`;
  const d = `${idPrefix}-d`;
  const n = `${idPrefix}-n`;
  const checked = (on: boolean, capped: boolean) => (on && !capped ? 'checked' : '');
  return `<fieldset>
<legend>Permissions</legend>
<div class="checkbox-row">
  <input type="checkbox" id="${escape(w)}" name="allowWrites" value="on" ${checked(current.allowWrites, writesCapped)} ${writesCapped ? 'disabled' : ''}>
  <label for="${escape(w)}" class="label-block">
    <span class="name">Allow write tools</span>
    <span class="hint">create / update / delete entities, comments, steps, links, tags.</span>
    ${writesCapped ? cappedHint('ELABFTW_ALLOW_WRITES') : ''}
  </label>
</div>
<div class="checkbox-row">
  <input type="checkbox" id="${escape(d)}" name="allowDestructive" value="on" ${checked(current.allowDestructive, destructiveCapped)} disabled>
  <label for="${escape(d)}" class="label-block">
    <span class="name">Allow destructive tools</span>
    <span class="hint">lock / sign / timestamp / bloxberg. Irreversible. Requires write tools.</span>
    ${destructiveCapped ? cappedHint(caps.allowWrites ? 'ELABFTW_ALLOW_DESTRUCTIVE' : 'ELABFTW_ALLOW_WRITES') : ''}
  </label>
</div>
<div class="checkbox-row">
  <input type="checkbox" id="${escape(n)}" name="revealUserIdentities" value="on" ${checked(current.revealUserIdentities, revealCapped)} ${revealCapped ? 'disabled' : ''}>
  <label for="${escape(n)}" class="label-block">
    <span class="name">Reveal real names</span>
    <span class="hint">surface user names / emails / orcids in tool output. Off = "user &lt;id&gt;" only.</span>
    ${revealCapped ? cappedHint('ELABFTW_REVEAL_USER_IDENTITIES') : ''}
  </label>
</div>
${
  destructiveCapped
    ? ''
    : `<script>
(function () {
  var w = document.getElementById('${escape(w)}');
  var d = document.getElementById('${escape(d)}');
  if (!w || !d) return;
  var sync = function () {
    d.disabled = !w.checked;
    if (!w.checked) d.checked = false;
  };
  w.addEventListener('change', sync);
  sync();
})();
</script>`
}
</fieldset>`;
}

/**
 * Instance picker. With one allowed instance there's nothing to pick —
 * we just name it and the server fills it in. With several, a select
 * restricted to the operator's allow-list.
 */
function baseUrlField(allowed: string[], selected?: string): string {
  if (allowed.length === 1) {
    return `<p class="hint">eLabFTW instance: <code>${escape(allowed[0]!)}</code></p>`;
  }
  const options = allowed
    .map(
      (u) =>
        `<option value="${escape(u)}"${u === selected ? ' selected' : ''}>${escape(u)}</option>`
    )
    .join('');
  return `<label for="baseUrl">eLabFTW instance</label>
  <select id="baseUrl" name="baseUrl" required>${options}</select>`;
}

function csrfField(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
}

export function renderRegisterForm(
  allowedBaseUrls: string[],
  caps: PermissionCaps
): string {
  return layout(
    'Register · elabftw MCP',
    `<h1>Register an MCP token</h1>
<p>Paste your eLabFTW API key to mint a personal MCP URL. Use that URL in
Claude Desktop, Claude mobile, or any other MCP-aware client.</p>

<form method="post" action="/register">
  <label for="apiKey">eLabFTW API key</label>
  <input id="apiKey" name="apiKey" type="password" required autocomplete="off"
         placeholder="3-cb2314b00d2845…">

  ${baseUrlField(allowedBaseUrls)}

  <label for="label">Label (optional)</label>
  <input id="label" name="label" type="text" maxlength="200"
         placeholder="e.g. Lab notebook · MacBook">

  ${permissionsFieldset('reg', caps)}

  <button type="submit">Generate MCP URL</button>
</form>

<p class="hint">Your eLabFTW API key is stored on this server encrypted
(AES-256-GCM); the MCP token is stored only as a hash and shown exactly
once on the next page. Treat that token as a secret — anyone with it can
act on eLabFTW as you, within the permissions you pick here.</p>

<p class="hint">Multi-team users: register with one team's key here, then add
more teams from the manage page.</p>

<p class="cross-link">Already registered? <a href="/manage">Manage your tokens</a>.</p>`,
    true
  );
}

/** URL / header / fallback-URL block shared by both "new token" pages. */
function tokenCopyBlock(
  personalUrl: string,
  bearerUrl: string,
  token: string
): string {
  return `<p style="margin-top: 18px;"><strong>Recommended — Authorization header</strong></p>

<div class="field-label">URL</div>
${copyRow(bearerUrl)}

<div class="field-label">Header — name</div>
${copyRow('Authorization')}

<div class="field-label">Header — value</div>
${copyRow(`Bearer ${token}`)}

<p class="hint">Paste these into a client that supports custom MCP headers
(claude.ai Custom Connector, VS Code, mcp-inspector). Header-based auth
keeps the token out of access logs and browser history.</p>

<p style="margin-top: 28px;"><strong>Fallback — token in URL</strong></p>
${copyRow(personalUrl)}
<p class="hint">For older clients that only accept a URL. The MCP server
emits a <code>Deprecation</code> response header on every call when this
path is used.</p>`;
}

export function renderRegisterSuccess(
  personalUrl: string,
  bearerUrl: string,
  bearerToken: string,
  tokenId: string
): string {
  return layout(
    'Registered · elabftw MCP',
    `<h1>You're registered.</h1>
<p>Copy the token now — this server only keeps a hash of it and can never
show it again. On the manage page it appears as id
<code>${escape(tokenId)}</code>.</p>

${tokenCopyBlock(personalUrl, bearerUrl, bearerToken)}

<p class="hint" style="margin-top: 24px;">The token does not expire on its
own. Lost it? <a href="/manage">Manage your tokens</a> — log in with any
current eLabFTW key for this user to revoke it and mint a new one.</p>

<p style="margin-top: 24px;"><a href="/register">← Register another key</a></p>`,
    true
  );
}

export function renderError(
  message: string,
  back: { href: string; label: string } = {
    href: '/register',
    label: 'Back to registration',
  }
): string {
  return layout(
    'Error · elabftw MCP',
    `<h1>Something went wrong.</h1>
<p>${escape(message)}</p>
<p style="margin-top: 24px;"><a href="${escape(back.href)}">← ${escape(back.label)}</a></p>`
  );
}

export interface JustMintedFlash {
  personalUrl: string;
  bearerUrl: string;
  token: string;
  tokenId: string;
  label?: string;
}

/**
 * Success page reached via 303 redirect from `POST /manage/mint`. The
 * token lives in the server-side session flash and is cleared on first
 * render, so a refresh shows the empty state — no form re-submission,
 * no duplicate tokens, no second chance to read the secret.
 */
export function renderJustMinted(flash: JustMintedFlash): string {
  const labelLine = flash.label
    ? `<p>Label: <strong>${escape(flash.label)}</strong></p>`
    : '';
  return layout(
    'New token · elabftw MCP',
    `<h1>New token minted.</h1>
${labelLine}
<p>Copy these now — the token is only shown on this page (the server
keeps just a hash). Reload, navigate away, or close the tab and it is
gone for good. In your token list it appears as id
<code>${escape(flash.tokenId)}</code>.</p>

${tokenCopyBlock(flash.personalUrl, flash.bearerUrl, flash.token)}

<p class="cross-link" style="margin-top: 28px;"><a href="/manage">←
Back to all my tokens</a></p>`,
    true
  );
}

/**
 * Empty state for `GET /manage/minted` when the one-shot flash is gone
 * (e.g. user reloaded the success page or landed on it cold).
 */
export function renderJustMintedEmpty(): string {
  return layout(
    'New token · elabftw MCP',
    `<h1>Nothing to show.</h1>
<p>A freshly minted token is shown exactly once, and that view has
already been used (or your manage session expired). Mint a new token
from the manage page if you need another.</p>
<p class="cross-link" style="margin-top: 18px;"><a href="/manage">←
Back to manage</a></p>`
  );
}

/**
 * Confirmation page reached via 303 redirect from
 * `POST /manage/revoke`. Same PRG pattern: refreshing is harmless.
 */
export function renderJustRevoked(label: string): string {
  return layout(
    'Token revoked · elabftw MCP',
    `<h1>Token revoked.</h1>
<div class="flash ok" style="margin-top: 14px;">Revoked: ${escape(label)}</div>
<p style="margin-top: 18px;">Any active MCP sessions using this token
have been closed.</p>
<p class="cross-link" style="margin-top: 24px;"><a href="/manage">←
Back to manage</a></p>`
  );
}

export function renderManageLogin(
  allowedBaseUrls: string[],
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

  ${baseUrlField(allowedBaseUrls)}

  <button type="submit">Show my tokens</button>
</form>

<p class="hint">Logging in starts a 30-minute session on this page only.
The API key is checked once against eLabFTW and not kept in your
browser.</p>

<p class="cross-link">No tokens yet? <a href="/register">Register one</a>.</p>`
  );
}

export interface ManageUser {
  userid: number;
  fullname?: string;
  email?: string;
}

export interface ManageListOptions {
  baseUrl: string;
  user: ManageUser;
  registrations: Registration[];
  csrf: string;
  caps: PermissionCaps;
  maxTokens: number;
}

export function renderManageList(opts: ManageListOptions): string {
  const { baseUrl, user, registrations, csrf, caps } = opts;
  const userLine = user.fullname
    ? `${user.fullname} · userid ${user.userid}`
    : `userid ${user.userid}`;

  const rows = registrations.length
    ? `<div class="token-list">${registrations
        .map((r) => renderTokenRow(r, csrf, caps))
        .join('')}</div>`
    : '<div class="token-list"><div class="empty-state">No tokens yet for this user on this instance.</div></div>';

  const atLimit = registrations.length >= opts.maxTokens;
  const mintSection = atLimit
    ? `<p class="hint">You have reached the limit of ${escape(opts.maxTokens)}
tokens on this instance. Revoke one to mint another.</p>`
    : `<form method="post" action="/manage/mint">
  ${csrfField(csrf)}
  <label for="label">Label (optional)</label>
  <input id="label" name="label" type="text" maxlength="200"
         placeholder="e.g. Lab notebook · MacBook">

  ${permissionsFieldset('mint', caps)}

  <button type="submit">Mint new token</button>
</form>`;

  return layout(
    'Manage tokens · elabftw MCP',
    `<h1>Your MCP tokens</h1>
<p>${escape(userLine)} on <code>${escape(baseUrl)}</code></p>
<form method="post" action="/manage/logout">
  ${csrfField(csrf)}
  <button type="submit" class="link">Log out</button>
</form>

<h2>Tokens</h2>
${rows}

<h2>Mint a new token</h2>
${mintSection}`,
    true
  );
}

export function renderManageEdited(
  tokenLabel: string,
  changes: string[]
): string {
  const lines = changes.map((c) => `<li>${escape(c)}</li>`).join('');
  return layout(
    'Token updated · elabftw MCP',
    `<h1>Token updated.</h1>
<div class="flash ok" style="margin-top: 14px;">
  <strong>${escape(tokenLabel)}</strong>
</div>
<ul style="margin-top: 14px;">${lines}</ul>
<p style="margin-top: 18px;">If permissions or the default team
changed, any live MCP sessions on this token were closed so the next
reconnect picks up the new shape. The bearer token value itself is
unchanged — clients keep using the same URL + header.</p>
<p class="cross-link" style="margin-top: 24px;"><a href="/manage">←
Back to manage</a></p>`
  );
}

export function renderTeamAdded(tokenLabel: string, team: number): string {
  return layout(
    'Team added · elabftw MCP',
    `<h1>Team added.</h1>
<div class="flash ok" style="margin-top: 14px;">
  Team ${escape(team)} added to <strong>${escape(tokenLabel)}</strong>.
</div>
<p style="margin-top: 18px;">Any in-flight MCP sessions for this token
were closed so the next reconnect picks up the new team list. Multi-team
tokens automatically expose the <code>elab_search_all_teams</code> fanout
tool.</p>
<p class="cross-link" style="margin-top: 24px;"><a href="/manage">←
Back to manage</a></p>`
  );
}

export function renderTeamRemoved(tokenLabel: string, team: number): string {
  return layout(
    'Team removed · elabftw MCP',
    `<h1>Team removed.</h1>
<div class="flash ok" style="margin-top: 14px;">
  Team ${escape(team)} removed from <strong>${escape(tokenLabel)}</strong>.
</div>
<p style="margin-top: 18px;">The token still authenticates for the
remaining teams. Live MCP sessions on this token were closed; new
sessions will see the reduced team set.</p>
<p class="cross-link" style="margin-top: 24px;"><a href="/manage">←
Back to manage</a></p>`
  );
}

function renderTokenRow(
  reg: Registration,
  csrf: string,
  caps: PermissionCaps
): string {
  const id = tokenIdOf(reg.tokenHash);
  const labelDisplay = reg.label
    ? `<div class="label-text">${escape(reg.label)}</div>`
    : '<div class="label-text empty">(no label)</div>';

  const teamChips = reg.keys
    .map((k) => renderTeamChip(reg, k.team, csrf))
    .join('');

  // Chips show *effective* permissions: the token's opt-in AND-ed with
  // the operator cap, matching what the runtime actually exposes.
  const writes = reg.allowWrites && caps.allowWrites;
  const flagChips: string[] = ['<span class="chip flag">read</span>'];
  if (writes) flagChips.push('<span class="chip flag">write</span>');
  if (writes && reg.allowDestructive && caps.allowDestructive)
    flagChips.push('<span class="chip flag danger">destructive</span>');
  if (reg.revealUserIdentities && caps.revealUserIdentities)
    flagChips.push('<span class="chip flag">names</span>');

  const defaultMarker =
    reg.keys.length > 1 ? ` · default team ${reg.defaultTeam}` : '';

  return `<div class="token-row">
<div>
  ${labelDisplay}
  <div class="meta">
    <span class="token-prefix">id ${escape(id)}</span>
    · created ${escape(formatTimestamp(reg.createdAt))}
    · last used ${escape(formatTimestamp(reg.lastUsedAt))}${escape(defaultMarker)}
  </div>
  <div class="chips">${teamChips}${flagChips.join('')}</div>
  <details class="add-team-fold">
    <summary>Edit token settings</summary>
    ${renderEditForm(reg, csrf, caps)}
  </details>
  <details class="add-team-fold">
    <summary>Add a team to this token</summary>
    <form method="post" action="/manage/add-team">
      ${csrfField(csrf)}
      <input type="hidden" name="id" value="${escape(id)}">
      <label>Additional eLabFTW API key (must belong to the same user)</label>
      <input name="newApiKey" type="password" required autocomplete="off"
             placeholder="3-cb2314b00d2845…">
      <label>Per-team label (optional)</label>
      <input name="keyLabel" type="text" maxlength="200" placeholder="e.g. Teaching Group">
      <button type="submit">Add team</button>
    </form>
  </details>
</div>
<form method="post" action="/manage/revoke">
  ${csrfField(csrf)}
  <input type="hidden" name="id" value="${escape(id)}">
  <button type="submit" class="danger" onclick="return confirm('Revoke this token? This cannot be undone.');">Revoke</button>
</form>
</div>`;
}

/**
 * Edit-in-place form. Pre-populates label + flag checkboxes + (when
 * multi-team) default-team radios with the registration's current
 * values. Submitting POSTs to /manage/edit; the route applies only
 * the diffs.
 */
function renderEditForm(
  reg: Registration,
  csrf: string,
  caps: PermissionCaps
): string {
  const id = tokenIdOf(reg.tokenHash);
  const defaultTeamSection =
    reg.keys.length >= 2
      ? `<label>Default team (used when a tool call omits <code>team</code>)</label>
<div class="checkbox-row" style="flex-wrap: wrap;">
${reg.keys
  .map(
    (k) => `<label class="label-block" style="margin-right: 14px;">
  <input type="radio" name="defaultTeam" value="${escape(k.team)}" ${k.team === reg.defaultTeam ? 'checked' : ''}>
  team ${escape(k.team)}${k.label ? ` — ${escape(k.label)}` : ''}
</label>`
  )
  .join('')}
</div>`
      : '';

  return `<form method="post" action="/manage/edit">
  ${csrfField(csrf)}
  <input type="hidden" name="id" value="${escape(id)}">

  <label>Label</label>
  <input name="label" type="text" maxlength="200" value="${escape(reg.label ?? '')}"
         placeholder="(empty = clear)">

  ${permissionsFieldset(`edit-${id}`, caps, reg)}

  ${defaultTeamSection}

  <button type="submit">Save changes</button>
</form>`;
}

/**
 * Team chip — plain when the token has only one team (revoke covers
 * removal), with an inline remove button when the token has 2+ teams.
 */
function renderTeamChip(reg: Registration, team: number, csrf: string): string {
  if (reg.keys.length <= 1) {
    return `<span class="chip team">team ${escape(team)}</span>`;
  }
  const confirmMsg = escape(
    `Remove team ${team} from this token? The token will keep working for the remaining teams.`
  );
  return `<form method="post" action="/manage/remove-team" class="chip-action" onsubmit="return confirm(this.dataset.confirm);" data-confirm="${confirmMsg}">
  ${csrfField(csrf)}
  <input type="hidden" name="id" value="${escape(tokenIdOf(reg.tokenHash))}">
  <input type="hidden" name="team" value="${escape(team)}">
  <span class="chip team">team ${escape(team)}</span>
  <button type="submit" title="Remove team ${escape(team)}">×</button>
</form>`;
}
