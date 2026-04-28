/**
 * Self-contained HTML for the registration flow. Inline styles, no JS,
 * no framework. Two pages: `/register` (form) and the success view.
 *
 * Kept deliberately plain: this is institutional infrastructure, not a
 * marketing site. Every byte of HTML the operator might need to audit
 * lives here.
 */

const LAYOUT_STYLE = `
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f7;
         margin: 0; padding: 40px 20px; color: #1d1d1f; }
  .card { max-width: 560px; margin: 0 auto; background: #fff;
          padding: 32px; border-radius: 12px; box-shadow: 0 2px 16px rgba(0,0,0,0.06); }
  h1 { font-size: 1.4em; margin: 0 0 8px; }
  p { color: #4a4a52; line-height: 1.5; }
  label { display: block; margin: 18px 0 6px; font-weight: 600; font-size: 0.9em; }
  input { width: 100%; padding: 10px 12px; border: 1px solid #d2d2d7; border-radius: 8px;
          font: inherit; box-sizing: border-box; }
  input:focus { outline: 2px solid #0071e3; outline-offset: 1px; }
  button { background: #0071e3; color: #fff; border: 0; padding: 12px 16px;
           border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer;
           width: 100%; margin-top: 24px; }
  button:hover { background: #005bb5; }
  .url { background: #f5f5f7; padding: 14px; border-radius: 8px;
         font-family: ui-monospace, SF Mono, Menlo, monospace; font-size: 0.85em;
         word-break: break-all; border: 1px solid #e5e5ea; }
  .hint { color: #6e6e73; font-size: 0.85em; margin-top: 16px; }
  .footer { color: #86868b; font-size: 0.8em; text-align: center; margin-top: 24px; }
  a { color: #0071e3; text-decoration: none; }
  a:hover { text-decoration: underline; }
`.trim();

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(title: string, body: string): string {
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
</body>
</html>`;
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
eLabFTW as you.</p>`
  );
}

export function renderRegisterSuccess(personalUrl: string): string {
  return layout(
    'Registered · elabftw MCP',
    `<h1>You're registered.</h1>
<p>Use this URL in your MCP client:</p>

<div class="url">${escape(personalUrl)}</div>

<p class="hint">In Claude Desktop, paste it under Settings → Developer →
Custom MCP. The token in the URL is your bearer secret; it does not expire
on its own. Lose it and ask your administrator to revoke + re-issue.</p>

<p style="margin-top: 24px;"><a href="/register">← Register another key</a></p>`
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
