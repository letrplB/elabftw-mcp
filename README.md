# elabftw MCP

Model Context Protocol server for [elabftw](https://www.elabftw.net/) —
search, read, and (optionally) mutate experiments, items, attachments,
comments, steps, and links in an electronic lab notebook from any
MCP-aware AI client.

Target: elabftw **5.5+** via the [API v2](https://doc.elabftw.net/api/v2/).

This repo ships **two npm packages** that share the same MCP tool
surface but run in different shapes:

| Package | Run shape | Who it's for |
|---|---|---|
| **`@sura_ai/elabftw`** | Local subprocess over stdio | A single user with their own API key, plugging the server into a desktop MCP client (Claude Desktop, Claude Code, Cursor, VS Code…). Node 18+. |
| **`@sura_ai/elabftw-hosted`** | HTTP server (multi-tenant) | A lab / PI / research-group / institutional deployment. Each user self-registers their API key on a `/register` page, gets a personal MCP URL, and manages it at `/manage`. Reachable from Claude mobile, claude.ai web, mcp-inspector, and any other client that takes a remote URL. Distributed via the bundled `Dockerfile`. Node 20+. |

If you're a single user adding eLabFTW to your own AI client, you want
**`@sura_ai/elabftw`** — see [Quick start](#quick-start). If you're
running a lab server that several people will share, you want
**`@sura_ai/elabftw-hosted`** — see [Hosted mode](#hosted-mode).

## Quick start

### Single team

```json
{
  "mcpServers": {
    "elabftw": {
      "command": "npx",
      "args": ["-y", "@sura_ai/elabftw"],
      "env": {
        "ELABFTW_BASE_URL": "https://elab.example.com",
        "ELABFTW_API_KEY": "3-<rest of your key>"
      }
    }
  }
}
```

Mint a key in your elabftw UI under **Settings → API keys**. By default
the server runs read-only even if the key has write permissions. Set
`ELABFTW_ALLOW_WRITES=true` to enable mutation tools.

### Multi-team

elabftw API keys are bound to the team you were viewing when you
created them. Each key's team context determines what data it can
reach. For admin-level access to multiple teams, mint one key per
team and configure them with indexed env vars:

```json
{
  "mcpServers": {
    "elabftw": {
      "command": "npx",
      "args": ["-y", "@sura_ai/elabftw"],
      "env": {
        "ELABFTW_BASE_URL": "https://elab.example.com",
        "ELABFTW_KEY_3": "26-<key minted in team 3>",
        "ELABFTW_KEY_3_LABEL": "Main Lab",
        "ELABFTW_KEY_7": "27-<key minted in team 7>",
        "ELABFTW_KEY_7_LABEL": "Teaching Group",
        "ELABFTW_DEFAULT_TEAM": "3"
      }
    }
  }
}
```

Every tool now takes an optional `team` parameter. Omit for the default;
pass `team=7` to route a call through the team-7 key. The tool
`elab_search_all_teams` runs the same query across every configured
team in parallel and merges results.

## Environment (stdio package)

These apply to `@sura_ai/elabftw` running as a stdio subprocess.
Hosted-mode env vars are documented separately in
[Hosted mode → Environment](#environment).

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ELABFTW_BASE_URL` | yes | — | Instance URL, no trailing slash, no `/api/v2` suffix. |
| `ELABFTW_API_KEY` | one of | — | Raw API key (single-team mode). Sent as `Authorization: <key>` — no `Bearer` prefix, per the elabftw spec. |
| `ELABFTW_KEY_<teamId>` | one of | — | One API key per team (multi-team mode). Example: `ELABFTW_KEY_19=26-abc...`. Repeat for each team. |
| `ELABFTW_KEY_<teamId>_LABEL` | no | — | Optional label shown by `elab_configured_teams`. |
| `ELABFTW_DEFAULT_TEAM` | no | lowest id | In multi-team mode, which team's key is used when a tool call omits `team`. |
| `ELABFTW_TEAM_ID` | no | auto | Single-team mode: pin the inferred team. Discovered at startup via `/users/me` when unset. |
| `ELABFTW_ALLOW_WRITES` | no | `false` | `true` to expose create / update / delete / comment / step / link / tag tools. |
| `ELABFTW_ALLOW_DESTRUCTIVE` | no | `false` | `true` to additionally expose lock / unlock / sign / timestamp / bloxberg. Irreversible. Requires `ELABFTW_ALLOW_WRITES=true`. |
| `ELABFTW_REVEAL_USER_IDENTITIES` | no | `false` | `true` to surface user names / emails / orcids in formatter output. Default-off means user tools and comment listings return `user <id>` instead of PII. `elab_me` is exempt (callers always see their own identity). |
| `ELABFTW_TIMEOUT_MS` | no | `30000` | Per-request timeout. |
| `ELABFTW_USER_AGENT` | no | `sura-elabftw-mcp/<version>` | Shows up in instance access logs. |

**Exactly one of `ELABFTW_API_KEY` or `ELABFTW_KEY_<teamId>` must be
set.** Mixing the two is rejected at startup.

## Tools

### Read (always enabled)

| Tool | Purpose |
|---|---|
| `elab_me` | Show the user the API key is authenticated as. Accepts `team`. |
| `elab_info` | Instance version, PHP version, aggregate counts. |
| `elab_search` | List experiments / items / templates / items_types within one team. Supports the elabftw `extended` DSL (`rating:5 and tag:"buffer"`). |
| `elab_get` | Fetch a single entity with body and parsed `extra_fields`. Pass `include=["attachments","steps","comments","links"]` to fan out sub-resources in one call (cohort-review shortcut). Body rendering: `format="markdown"` (default) preserves tables + link hrefs; `format="text"` = legacy stripped plaintext; `format="html"` = raw. |
| `elab_get_bulk` | Fetch up to 50 entities of the same kind with shared `include` / `format`. Chunks requests into groups of 8. Each id is team-validated before fetch. |
| `elab_list_attachments` | File attachment metadata on an entity. |
| `elab_download_attachment` | Raw bytes. Text files returned as text; binary as base64. Files >2 MB are truncated with a note. |
| `elab_list_comments` | Comments on an entity. |
| `elab_list_steps` | Checklist steps. Unfinished shown as `[ ]`, finished as `[x]`. |
| `elab_list_links` | Cross-entity links. `targetKind=experiments` / `items` for one kind; `targetKind=all` (default) merges both in parallel. |
| `elab_list_unfinished_steps` | Open checklist steps across all entities visible to the team key. Cohort-triage shortcut. |
| `elab_list_templates` | Experiment templates in a team. |
| `elab_list_items_types` | Items type schemas. |
| `elab_list_tags` | Tags in a team. |
| `elab_list_events` | Scheduler / booking events. |
| `elab_list_teams` | All teams on the instance (for id → name mapping). Marks which teams have keys configured. |
| `elab_configured_teams` | List teams this MCP has keys for. |
| `elab_search_users` | Search users by name/email (empty `q` lists visible). Resolves opaque `userid` to identity. Requires team-admin key. Identity fields gated behind `ELABFTW_REVEAL_USER_IDENTITIES=true`. |
| `elab_list_extra_field_names` | Instance-wide list of every `extra_fields` key with data. Use to discover which structured fields templates define before reviewing student submissions. |
| `elab_list_revisions` | List body revisions for an entity. Surfaces edit history (who / when / size) for cohort review. Per-instance availability. |
| `elab_get_revision` | Fetch one revision's body. Rendered through the markdown path (tables + hrefs preserved). |
| `elab_get_user` | Fetch one user by `userid`. Identity fields gated behind `ELABFTW_REVEAL_USER_IDENTITIES=true`. |
| `elab_list_team_users` | Roster for a given team. Works around the lack of a `/teams/{id}/users` endpoint by filtering `/users` client-side. Requires team-admin key. |
| `elab_export` | PDF / PDF-A / ZIP / ZIP-A / ELN / ELN-HTML / CSV / JSON / QR-PNG / QR-PDF. |
| `elab_search_all_teams` | (multi-team only) Fan out a search across every configured team in parallel. Accepts the same `q` / `extended` / `category` / `status` / `tags` / `owner` / `scope` / `state` / `order` / `sort` / `limit` / `offset` filters as `elab_search`. |

### Write (requires `ELABFTW_ALLOW_WRITES=true`)

| Tool | Purpose |
|---|---|
| `elab_create_entity` | Create any of the four kinds (experiments, items, templates, items_types). Accepts `title` / `body` / `content_type` / `tags` / `metadata` / `category_id` plus all PATCH-symmetric fields: `date` / `rating` / `status` / `custom_id` / `canread` / `canwrite` / `state`. Re-PATCHes any field elabftw drops or normalizes on POST so the values land. Verifies the new entry lands in the requested team. |
| `elab_update_entity` | Patch any of the four kinds. Title / body / content_type / category / status / rating / date / custom_id / metadata / permissions / `state` (`"normal"` / `"archived"` — soft-delete goes through `elab_delete_entity`). |
| `elab_update_extra_field` | Patch a single `extra_fields` value without rewriting the whole metadata blob. |
| `elab_duplicate_entity` | Duplicate with optional file copy and back-link. `targetTeam` re-targets the duplicate to a different team than the source. |
| `elab_delete_entity` | Soft-delete (state=3). Permanent deletion is sysadmin-only and not exposed. |
| `elab_add_comment` / `elab_update_comment` / `elab_delete_comment` | Comment CRUD. Comment delete is permanent (no soft-delete on the elabftw side). |
| `elab_add_step` / `elab_toggle_step` / `elab_delete_step` | Manage checklist steps. `elab_add_step` accepts `deadline_notif`. Step delete is permanent. |
| `elab_link_entities` / `elab_unlink_entities` | Cross-entity links. Both ends must be in the same team. |
| `elab_add_tag` / `elab_remove_tag` | Tag management. |

### Destructive (requires `ELABFTW_ALLOW_DESTRUCTIVE=true`)

These alter the audit trail and most cannot be undone without admin
intervention. Gated behind a second flag on purpose.

| Tool | Purpose |
|---|---|
| `elab_lock` | Lock an entity. |
| `elab_unlock` | Force-unlock. Admin only. |
| `elab_timestamp` | RFC 3161 trusted timestamp. Consumes from `ts_balance`. |
| `elab_bloxberg` | Anchor on the Bloxberg blockchain. |
| `elab_sign` | Cryptographic signature with a configured signature key. |

### Rich body rendering

elabftw stores each entity body with a `content_type`: **HTML (default)**
or **markdown**. If you send a markdown-flavoured body
(`# heading`, GFM tables, `**bold**`) under `content_type: "html"`, it
is stored verbatim as HTML and rendered as raw characters in the UI.

Both `elab_create_entity` and `elab_update_entity` accept
`content_type: "html" | "markdown"`. Pass `"markdown"` whenever the body
uses GFM constructs:

```
elab_create_entity({ entityType: "experiments", title, body, content_type: "markdown", tags })
elab_update_entity({ entityType: "experiments", id, content_type: "markdown", body })
```

elabftw's POST endpoints honor `content_type` on recent versions. On
older instances that ignore it on POST, `elab_create_entity`
transparently re-PATCHes after creation so the value lands and the body
is re-served through elabftw's markdown → HTML pipeline. If the
fallback PATCH itself fails, the tool surfaces a note in its response
pointing you at `elab_update_entity` to retry.

## How team scoping works

Every tool that touches team-scoped data accepts an optional
`team: number` argument:

- **Without `team`** the default team's key is used (lowest configured
  id, or whatever `ELABFTW_DEFAULT_TEAM` says).
- **With `team=n`** the call uses the `ELABFTW_KEY_<n>` key, and list
  results are filtered to rows with `team=n`. Single-entity reads and
  writes verify the entity's team before running and return a clear
  error on mismatch.

**elabftw API keys are bound to a team context at creation time.** A
key minted while viewing team 19 sees team 19 entries as whatever role
the user holds there, plus a sliver of cross-team data (entries you
authored, or entries with wide `canread`). Full admin reach into
another team needs a *second* key minted while that team is current in
the UI.

**Startup self-check** calls `/users/me` with every configured key
and logs a stderr warning if a key's current team doesn't match its
declared index. Non-fatal, but usually means `elab_create_entity`
would create entries in the wrong team.

This is a soft guardrail running in the MCP process, not in elabftw.
For hard isolation, use an account that is only a member of the
target team.

### User roster access

`elab_search_users` / `elab_get_user` / `elab_list_team_users` hit
`/users` and `/users/{id}`. These endpoints are sysadmin-wide;
team-admin keys typically succeed but are restricted to users visible
via team membership. A plain team-member key gets 403. There is no
dedicated `/teams/{id}/users` endpoint on the stable API, so
`elab_list_team_users` runs `/users` under the team's key and filters
client-side.

### For teaching-lab / cohort review

A common use case is reviewing a class of student practicals — e.g. 40 students all running the same template, with an instructor using the LLM to spot deviations. The recommended workflow:

1. **Find the template.** `elab_list_templates` lists experiment templates in a team. Note the id of the practical.
2. **See the expected schema.** `elab_get({entityType: "experiments_templates", id})` returns the template's body + `extra_fields`. This is the ground truth for what students were asked to fill in.
3. **Check which keys the instance uses.** `elab_list_extra_field_names` surfaces every `extra_fields` key with any data on the instance — a quick way to spot whether students filled structured fields vs typed everything into prose.
4. **List submissions.** `elab_search({entityType: "experiments", extended: "tag:\"ACFP25\""})` (or whichever tag/template the cohort shares).
5. **Pull full submissions in one call each.** `elab_get({id, include: ["attachments","steps","comments","links"]})` — one tool call per student, body rendered as markdown so tables survive.
6. **Resolve userids to names (if needed).** For a single lookup use `elab_get_user({userid})`. For a cohort, `elab_list_team_users({team})` returns the whole roster in one call (name + email + orcid + role + cross-team memberships). `elab_search_users` is the fallback when you only have a partial name to go on. All three require a team-admin key; name / email / orcid fields are redacted unless `ELABFTW_REVEAL_USER_IDENTITIES=true`.

### Privacy defaults

By default the MCP redacts user names / emails / orcids out of
formatter output. `elab_list_comments` shows `user 165 @ 2026-04-14:
...` instead of `Ada Lovelace @ 2026-04-14: ...`, and the Phase-1
user tools return `userid` + team memberships only. The numeric
`userid` surfaced on every entity stays — it is the join key for
cohort review and does not leak identity on its own.

Set `ELABFTW_REVEAL_USER_IDENTITIES=true` when the operator wants
the model to see real names (cohort review with student consent,
multi-tenant admin use, instructor workflows). `elab_me` is exempt
from the gate — the caller inspecting their own account is not a
privacy concern and the redaction would break the authn
sanity-check that tool exists for.

## Known gotchas

- **`Authorization` header has no `Bearer` prefix.** This trips up
  generic HTTP clients. The server sends the key verbatim, which is
  what elabftw expects.
- **`metadata` is a JSON-encoded string on the wire.** `elab_get`
  parses it for display; when writing, send `metadata` as a JSON
  string (or use `elab_update_extra_field` for targeted edits).
- **Pagination is offset-based with no total count.** Tools cap at 200
  rows per call; use `offset` to page further.
- **Locked entities reject edits.** `elab_update_entity` will fail on a
  locked entry. `elab_unlock` is available under
  `ELABFTW_ALLOW_DESTRUCTIVE`.
- **Upload `type` field is the parent entity type, not MIME.** The
  attachment formatter uses the filename extension instead.
- **Attachment uploads are not exposed.** `elab_list_attachments` and
  `elab_download_attachment` are available, but there is currently no
  MCP tool for adding files to an entry — those still need to go
  through the elabftw UI. The underlying client method
  (`ElabftwClient.uploadFile`) exists for programmatic use.
- **Bodies are HTML by default on create.** Pass
  `content_type: "markdown"` to `elab_create_entity` for markdown bodies
  — see "Rich body rendering" above.

## Programmatic use

The client library ships alongside the MCP server:

```ts
import { ElabftwClient } from '@sura_ai/elabftw';

const client = new ElabftwClient({
  baseUrl: 'https://elab.example.com',
  apiKey: '3-<rest of your key>',
});

const me = await client.me();
for await (const row of client.paginate('experiments', { q: 'stöber' })) {
  console.log(row.id, row.title);
}
```

Everything exposed as an MCP tool is also available as a `client.*`
method. See `src/client/client.ts` for the full surface.

## Hosted mode

The hosted server is the second package, **`@sura_ai/elabftw-hosted`**.
Same MCP tool surface as the stdio package, served over the MCP
[Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
(spec `2025-06-18`). The supported install path is the bundled
`Dockerfile` — clone the repo, point your platform at it, you're done.

### When to use it

- **Mobile / web clients.** Claude mobile, claude.ai web, and other
  browser-based MCP clients can only talk to a remote URL. Stdio is
  desktop-only.
- **Shared institutional deployments.** A PI / lab group / research
  server hosts one process; researchers register their own API key
  via a self-service form, paste the resulting URL into their client,
  and go. No Node install, no env-var wiring per user.
- **Non-technical users.** Registration is a 30-second web form; the
  user never sees Docker, npm, or a config file.

### Network topology

The hosted server makes outbound HTTPS calls to the eLabFTW instance
on every MCP tool call. **The server, not the client, needs network
reach to eLabFTW.** If your eLabFTW is firewalled to a uni / corp
network (e.g. `elabftw-lin.uni-ulm.de`), the hosted server must run
*inside* that same network — typically a uni-IT-provisioned VM with a
public reverse proxy in front. A personal cloud VPS will not be able
to reach it.

### Two-layer session model

- **Registration** (durable). One per user. Maps a 256-bit bearer
  token to that user's `apiKey` + `baseUrl` + eLabFTW `userid`.
  Created via `/register`, persisted to a JSON file (default) or
  SQLite (opt-in), survives restart.
- **MCP session** (ephemeral). One per active MCP connection,
  identified by the `Mcp-Session-Id` header per spec. Lives in memory;
  clients reconnect cheaply and persisting these across restarts buys
  nothing.

A registration is the long-lived "account"; a session is the per-tab
connection.

### Self-service token management

`/manage` is a paste-your-eLabFTW-key page. Users see every token
registered for *their eLabFTW user* (joined by `userid`, not API-key
value, so rotating their eLabFTW key keeps every token visible),
revoke any of them, or mint a fresh one. Cross-linked from
`/register` and the post-registration success page so "lost the link"
has a one-click recovery path.

**Per-token permission flags.** The `/register` and *Mint a new
token* forms expose three checkboxes — *Allow write tools*, *Allow
destructive tools*, *Reveal real names*. Each token carries its own
set; effective behaviour at request time is the AND of the
registration setting and the operator's env-var setting (the env
vars listed in the *Environment* section below cap institutional
policy; the registration opts in). A PI can mint themselves a
read-write token and student tokens that stay read-only on the same
server.

**Multi-team tokens.** Each token in the list shows team chips
(`team 19`, `team 4`). Expand the *Add a team to this token* fold
under a token to paste an additional eLabFTW API key — it gets
`/users/me`-validated to confirm it belongs to the same user, then
appended. Multi-team tokens automatically light up the `team`
parameter on every tool plus the `elab_search_all_teams` fanout
tool, mirroring stdio multi-key mode. Each team chip on a 2+-team
token has an inline `×` button to remove that team without revoking
the whole token.

**Edit a token in place.** Each row also has an *Edit token settings*
fold-out that lets you change the label, toggle permission flags, and
(on multi-team tokens) pick the default team. The bearer token value
is never touched — clients keep using the same URL + Authorization
header across edits. Live MCP sessions on the token are dropped when
permissions or default team change so the next reconnect picks up the
new shape.

There is no admin dashboard — operators still SSH in for sysadmin-
grade actions (banning a user, bulk audit). The plain JSON / SQLite
file is the source of truth.

### Quick start — choose your stack

Two supported deploy shapes. Pick the one that matches your VPS.

#### Option A — Coolify / Dokploy / any PaaS that builds from a Dockerfile

If your VPS already runs Coolify (or Dokploy, CapRover, etc.), the bundled
`Dockerfile` is everything you need — the platform's built-in reverse proxy
handles TLS, you don't ship Caddy.

1. **Coolify → New Resource → Public Repository.** Point at this repo, set
   the branch (`main` once merged, otherwise `feat/hosted-mode`).
2. **Build pack:** `Dockerfile` (Coolify auto-detects from the file at the
   repo root).
3. **Domain:** `mcp.example.tum.de`. Coolify provisions a Let's Encrypt cert
   for it via Traefik automatically.
4. **Port:** `8000` (matches `EXPOSE 8000` in the Dockerfile).
5. **Environment variables** (Coolify UI → Environment Variables):

   | Key | Value |
   |---|---|
   | `ELABFTW_BASE_URL` | `https://elab.example.com` |
   | `MCP_PUBLIC_URL` | `https://mcp.example.tum.de` |
   | `MCP_ALLOWED_HOSTS` | `mcp.example.tum.de` |
   | `MCP_ALLOWED_ORIGINS` | `https://mcp.example.tum.de` |
   | `ELABFTW_ALLOW_WRITES` | `true` (optional) |
   | `MCP_STORE_BACKEND` | `json` (default) or `sqlite` |

   `MCP_HOST` / `MCP_PORT` / `MCP_REGISTRATIONS_PATH` are pre-set in
   the Dockerfile — Coolify inherits them, no need to repeat. For
   SQLite, point `MCP_REGISTRATIONS_PATH` at a `.db` file under the
   same volume mount.

6. **Persistent storage** (Coolify UI → Storages → Add). Mount a named
   volume at `/var/lib/elabftw-mcp` — that's where the JSON registrations
   file lives. Without this, every container rebuild wipes your users.
7. **Deploy.** Coolify pulls, builds, runs, exposes the domain.
   `https://mcp.example.tum.de/healthz` should return `ok` once the
   healthcheck passes (~30s after first start).

The bundled `docker-compose.yml` and `Caddyfile` are ignored on this path.
They are for Option B.

#### Option B — Bare VPS (Docker + the bundled Caddy)

Use this if your VPS doesn't run a PaaS and you want a full stack in one
command.

```bash
cp .env.example .env  # set ELABFTW_BASE_URL, MCP_DOMAIN, MCP_PUBLIC_URL
docker compose up -d
```

Caddy auto-provisions a Let's Encrypt cert for `MCP_DOMAIN` and
reverse-proxies to the MCP container. Registrations persist to a
named volume (`mcp_registrations`) so container rebuilds don't lose
users. Tail logs with `docker compose logs -f mcp-elabftw`.

Once it's up, point a browser at `https://${MCP_DOMAIN}/register`,
fill the form, copy the URL the success page returns, and paste it
into your MCP client.

#### Either way

Pre-flight check the night before:

- DNS: `dig mcp.example.tum.de` returns the VPS IP.
- Firewall: ports 80 (for the ACME challenge) and 443 are open inbound.
  Note: the MCP container's `EXPOSE 8000` is *internal* — it's reached via
  the reverse proxy (Coolify's Traefik or the bundled Caddy) on 443; you
  do not open 8000 publicly.

### Auth

Two paths, header preferred:

```
# Recommended: header-based auth (bearer token, never in URLs / logs)
URL:    https://mcp.example.tum.de/mcp
Header: Authorization: Bearer 64hexchars...

# Fallback: token in URL (for clients that don't yet support custom MCP headers)
URL:    https://mcp.example.tum.de/mcp?token=64hexchars...
```

Query-token requests get a `Deprecation: true` response header. Header
auth is the documented primary path; the URL form is preserved only
because some MCP clients still only accept a single URL string.

### Environment

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ELABFTW_BASE_URL` | yes | — | Default base URL prefilled into the registration form. |
| `MCP_HOST` | no | `0.0.0.0` | Bind address. Behind a reverse proxy, leave at `0.0.0.0`. |
| `MCP_PORT` | no | `8000` | Bind port. |
| `MCP_PUBLIC_URL` | recommended | derived | Public origin for personal URLs (e.g. `https://mcp.example.tum.de`). Also auto-derives the DNS-rebind allow-list. Without this you get a startup warning and fallback to bind-address-only. |
| `MCP_STORE_BACKEND` | no | `json` | `json` (default; atomic-write JSON file, fine to a few hundred tokens) or `sqlite` (`better-sqlite3`, WAL, indexed lookups, recommended for institutional scale). |
| `MCP_REGISTRATIONS_PATH` | no | `./registrations.json` | Where the store lives. JSON file or SQLite database depending on `MCP_STORE_BACKEND`. Mount a volume here in Docker. The Dockerfile sets it to `/var/lib/elabftw-mcp/registrations.json`. |
| `MCP_ALLOWED_HOSTS` | no | derived from `MCP_PUBLIC_URL` | Comma-list, DNS-rebind allow-list (overrides the derived value). |
| `MCP_ALLOWED_ORIGINS` | no | derived from `MCP_PUBLIC_URL` | Comma-list, CORS-style origin validation (overrides derived). |

`ELABFTW_ALLOW_WRITES` / `ELABFTW_ALLOW_DESTRUCTIVE` /
`ELABFTW_REVEAL_USER_IDENTITIES` are the operator's **upper bound**.
The effective value at request time is the AND of the env-var setting
and the user's own per-token setting (chosen via checkboxes on the
`/register` and *Mint a new token* forms). Set the env var to `true`
to allow users to opt in; leave it `false` to deny across the whole
process regardless of what users tick. `ELABFTW_ALLOW_DESTRUCTIVE`
additionally requires `ELABFTW_ALLOW_WRITES` at both layers.

### Security posture

This is **institutional, not public-SaaS.** The auth model is a static
bearer token per registration, no OAuth dance. That fits a
PI/lab/research-group server behind a reverse proxy with controlled
access. It does **not** fit "register here for free, anyone on the
internet can use it" — for that, layer OAuth 2.1 with PKCE on top
(via `oauth2-proxy`, your IdP, or a future upstream feature).

What's implemented:

- TLS terminated at the reverse proxy (Caddy auto-TLS in the bundled
  Compose).
- Bearer-token auth required on every `/mcp` request. 401s carry a
  spec-compliant `WWW-Authenticate` header so clients can discover
  the auth scheme.
- DNS-rebinding protection on by default (spec-mandated). Reject any
  request whose `Origin` doesn't match the allow-list.
- Cross-token session isolation: a session id minted by user A is a
  404 for user B's token (no information leak about whether the id is
  valid).
- Tokens are 256-bit random hex (not UUIDs — UUID v4 is only 122
  random bits). Stored verbatim in a `0o600` JSON file or SQLite db.
- **Self-service revocation + edit.** Users revoke their own tokens
  at `/manage` after re-authenticating with their eLabFTW key. They
  can also edit a token in place (label, permission flags, default
  team for multi-team tokens) without invalidating the bearer value.
  Revocation and flag changes close any live MCP sessions on the
  affected token.
- **Per-token permission flags.** Each registration carries its own
  `allowWrites` / `allowDestructive` / `revealUserIdentities`. The
  operator's env vars cap the maximum; the registration opts in.
  Hosted servers can serve a PI with writes and students with
  read-only on the same process.
- **Tokens joined to eLabFTW userid**, not API-key value — rotating
  the eLabFTW key keeps tokens manageable.
- Per-IP rate limit on `/manage` POSTs (10 req/min sliding window).
- Health probe at `GET /healthz` for orchestrator wiring.

What is **out of scope** for this release:

- Hashed token storage (stored verbatim — encrypt the volume / set
  filesystem ACLs accordingly).
- Per-user audit logs.
- Rate limiting on `/register` itself (the underlying eLabFTW API
  rate-limits failed key probes already).
- OAuth 2.1 / OIDC for institutional SSO. Tracked for v0.5; until
  then the eLabFTW API key is the only credential we accept.

If your deployment posture requires any of those, file an issue —
they are deliberate v1 omissions, not inherent limitations.

### Acknowledgements

Hosted-mode deployment shape (Caddy + Compose + `/register` UX)
follows the design that [@harrytyp](https://github.com/harrytyp)
prototyped in his fork. The upstream implementation ports the idea
to the current Streamable HTTP transport, threads per-token
credentials through to the actual tool calls, and tightens spec
compliance.

## Development

The repo is an npm workspace. Two packages live under `packages/`:

```
packages/
  toolkit/   →  @sura_ai/elabftw          (stdio CLI + programmatic client)
  hosted/    →  @sura_ai/elabftw-hosted   (Express HTTP server)
```

```bash
npm install
npm run typecheck      # both packages
npm run build          # both packages — toolkit must build before hosted typechecks
```

Run the stdio server locally against your instance:

```bash
ELABFTW_BASE_URL=https://elab.example.com \
ELABFTW_API_KEY=3-... \
node packages/toolkit/dist/cli.js
```

Run the hosted server locally — JSON backend (default):

```bash
ELABFTW_BASE_URL=https://elab.example.com \
MCP_REGISTRATIONS_PATH=./.dev-registrations.json \
node packages/hosted/dist/cli.js
# then browser → http://localhost:8000/register
```

Or SQLite backend:

```bash
MCP_STORE_BACKEND=sqlite \
ELABFTW_BASE_URL=https://elab.example.com \
MCP_REGISTRATIONS_PATH=./.dev-registrations.db \
node packages/hosted/dist/cli.js
```

Add `ELABFTW_ALLOW_WRITES=true` (and optionally `ELABFTW_ALLOW_DESTRUCTIVE=true`,
`ELABFTW_REVEAL_USER_IDENTITIES=true`) to the env if you want users to be able
to opt into those flags from the registration form — env vars cap, the
checkboxes opt in.

## Security model

The deployment model here is deliberately conservative. This is worth
saying plainly because MCP tool-calling has drawn real critique from
the elabftw community (see
[elabftw#5649](https://github.com/elabftw/elabftw/issues/5649) where
upstream declined to build an official MCP, citing tool-poisoning and
firewall concerns).

### Stdio mode (default)

- **No network exposure.** The server talks MCP over stdin/stdout to
  a locally-trusted parent process (Claude Desktop, Claude Code,
  Cursor, etc.). No port is opened.
- **The user's own API key.** All elabftw calls are authenticated
  with a key you minted in *your* UI, with *your* permissions. The
  MCP has no elevated access — it can only do what you could do by
  hand.
- **Firewall-bound instances stay that way.** The MCP runs on your
  machine; only your machine talks to elabftw. It does not route
  data through any third-party service.

### Hosted mode (opt-in)

See [Hosted mode → Security posture](#security-posture) above for the
full hosted-mode model. The short version: it is designed for
institutional deployment behind a reverse proxy, with each user
registering their own API key against their own bearer token. It
is **not** designed as a public-internet SaaS — for that, layer OAuth
on top.

### Both modes

- **Writes are off by default.** Even a read-write API key is exposed
  to the model as read-only unless writes are enabled. In stdio mode
  set `ELABFTW_ALLOW_WRITES=true`; in hosted mode the env var caps
  the operator's policy *and* each registration must tick the
  matching checkbox at `/register` or `/manage`. Audit-trail actions
  (lock/sign/timestamp/bloxberg) require a second flag,
  `ELABFTW_ALLOW_DESTRUCTIVE=true`, with the same hosted-mode AND
  rule.
- **Tool-poisoning surface.** Tool descriptions and argument schemas
  are the only thing the model sees and acts on. They live in-repo,
  are reviewable, and don't fetch remote content. If you fork, audit
  them before shipping.

For tighter isolation, create a dedicated elabftw user that is only a
member of the team you want the MCP to reach, and mint the API key
from that account.

## Related work

- [fcichos/elabftw-mcp-server](https://github.com/fcichos/elabftw-mcp-server)
  is a Python MCP for elabftw. At time of writing it has no license
  declared, does not yet cover writes, destructive ops, multi-team,
  exports, or extra_fields in a unified way. Worth knowing it exists;
  different design choices from this package.
- [elabapi-python](https://github.com/elabftw/elabapi-python) is the
  upstream Python SDK generated from the OpenAPI spec — the right
  pick if you want the raw API without the MCP layer.
- [elAPI](https://github.com/uhd-urz/elAPI) is a third-party CLI +
  Python library. Useful as a reference for pagination, auth, and
  spec quirks.

## Contributing

Issues and PRs welcome. The server is deliberately thin — most of the
code is 1:1 with the elabftw API v2 spec. If elabftw ships a new
endpoint, adding a method to `ElabftwClient` plus a corresponding MCP
tool is usually a 30-line change.

## License

MIT. See [LICENSE](./LICENSE).
