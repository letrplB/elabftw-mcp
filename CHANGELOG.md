# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] — 2026-04-29

### Added

- **Per-token permission flags** in hosted mode. The `/register` and
  `/manage/mint` forms now expose three checkboxes — *Allow write
  tools*, *Allow destructive tools*, *Reveal real names* — that map
  directly to the existing `ELABFTW_ALLOW_WRITES`,
  `ELABFTW_ALLOW_DESTRUCTIVE`, `ELABFTW_REVEAL_USER_IDENTITIES`
  toolkit flags. Effective values at request time are the AND of the
  registration setting and the operator's env-var setting — env caps,
  registration opts in. Previously, hosted mode was stuck on whatever
  the operator chose for the whole process.
- **Multi-team registrations.** A single token can now cover multiple
  teams. The `/manage` token list shows team chips (`team 19`,
  `team 4`); each row has a fold-out *Add a team to this token* form
  that takes another eLabFTW API key, validates that it resolves to
  the same `userid` via `/users/me`, and appends it to the token's
  key list. Multi-team tokens automatically expose the `team`
  parameter on every tool plus the `elab_search_all_teams` fanout
  tool — same behaviour the stdio package gets from
  `ELABFTW_KEY_<teamId>` env vars.
- **Inline team removal.** Each team chip on a multi-team token has
  an `×` button that removes that team after confirmation. Last team
  cannot be removed (revoke deletes the whole token instead). When
  the removed team was the default, the smallest remaining team
  becomes the new default.
- **PRG flow for the new actions.** Both *Add team* and *Remove
  team* set a one-shot cookie and 303-redirect to a confirmation
  page (`/manage/team-added` / `/manage/team-removed`), matching the
  v0.4 mint/revoke pattern. Live MCP sessions for the affected token
  are dropped so the next reconnect picks up the new key set.

### Changed

- **`Registration` shape.** The top-level `apiKey` and `team` fields
  are gone, replaced by `keys: Array<{apiKey, team, label?}>` plus a
  `defaultTeam` and three boolean flag fields. Single-team
  registrations still mint with `keys.length === 1`.
- **JSON store** bumps schema to v3. v1 and v2 entries are dropped on
  load with a startup warning. No production deployments to migrate.
- **SQLite store** bumps `user_version` to 2. v1 tables are dropped
  and recreated empty (same warning). Schema gains `keys_json`,
  `default_team`, and three INTEGER bool columns.

### Fixed

- **Form-resubmit duplicate-token bug** (carried from v0.4 PRG fix
  but worth re-stating). After mint or revoke, refreshing the page no
  longer triggers Safari's "resend the form?" prompt or creates
  duplicate tokens — the same PRG pattern now applies to add-team and
  remove-team.

## [0.4.0] — 2026-04-29

### Added

- **Self-service token management** at `/manage`. Users paste any
  current eLabFTW API key and see every MCP token registered for
  their eLabFTW user — across rotated API keys, across multiple
  registrations. Per-token revoke buttons, mint-new-token form,
  cross-links from `/register` and the post-registration success page.
  No more "ask your administrator to revoke."
  - Tokens are joined to the eLabFTW *user id* (resolved via
    `/users/me` at registration), not to the API-key value. Rotating
    the eLabFTW key keeps every token manageable.
  - Auth on every action by re-probing the API key — no session
    cookies, no CSRF token plumbing. Per-IP sliding-window rate limit
    (10 req/min) on the manage POSTs.
  - The plaintext token value is shown only at mint time; the list
    view never displays more than the first 8 chars + `…`.
  - Revoking a token closes any in-flight MCP sessions that belonged
    to it, so live tool calls fail closed.
- **Pluggable store backend** via `MCP_STORE_BACKEND=json|sqlite`.
  - `json` (default): unchanged behaviour from 0.3, still atomic-write,
    still mode `0o600`. Fine to a few hundred tokens.
  - `sqlite` (new): `better-sqlite3`-backed store with WAL journaling
    and an indexed `(userid, base_url)` lookup path. Single-row
    UPDATEs for `lastUsedAt` instead of full-file rewrites.
    `MCP_REGISTRATIONS_PATH` becomes the database file when this
    backend is selected.

### Changed

- **Repo split into npm workspaces.** Two packages, one repo:
  - `@sura_ai/elabftw` (`packages/toolkit/`) — the stdio MCP server
    and programmatic eLabFTW v2 client. Loses `express` from
    dependencies; stdio installs are leaner. Same npm package name,
    same bin (`sura-elabftw-mcp`), `engines: >=18` unchanged.
  - `@sura_ai/elabftw-hosted` (`packages/hosted/`) — the Express
    HTTP wrapper and registration store. Depends on `@sura_ai/elabftw`
    via the workspace symlink. `engines: >=20`. Not auto-published
    to npm — Docker is the canonical install for institutional
    deployments.
  - Tool wiring is centralised in the toolkit's new `buildElabMcpServer`
    factory; both stdio and hosted runtimes consume it. The hosted
    package no longer touches the tool registrars directly.
- **Registration shape.** Adds `userid` (number, from `/users/me` at
  registration). The JSON store bumps schema to v2; v1 entries are
  dropped at startup with a warning. No production deployments to
  migrate (0.3 was unreleased).
- **Dockerfile** rebased on `node:22-slim` (was `node:22-alpine`) so
  `better-sqlite3` prebuilt binaries (glibc) work out of the box.
  Adds an `MCP_STORE_BACKEND=json` default to make the choice
  explicit; switch to `sqlite` and point `MCP_REGISTRATIONS_PATH`
  at a `.db` file for the SQLite path.

### Removed

- `MCP_MODE=hosted` dispatch in the stdio CLI. Hosted mode is now its
  own bin (`sura-elabftw-mcp-hosted` from `@sura_ai/elabftw-hosted`),
  reachable via Docker or the workspace's local script.

## [0.3.0] — 2026-04-28

### Added

- **Hosted mode** (`MCP_MODE=hosted`). HTTP server alongside the
  default stdio transport, exposing the same tool surface to remote
  MCP clients (Claude mobile, claude.ai web, browser-based clients,
  shared institutional deployments). Implements the current MCP
  Streamable HTTP transport (single `/mcp` endpoint, spec
  `2025-06-18`).

  - **Self-service registration.** `GET /register` serves an HTML
    form; `POST /register` mints a 256-bit hex token, persists the
    user's API key + base URL, and returns a personal MCP URL. No
    OAuth dance for institutional deployments — bearer-token simplicity.
  - **Per-token isolation.** One `McpServer` instance per registered
    token, each with its own `ClientRegistry` built from that user's
    eLabFTW credentials. The existing tool-registration code
    (`registerReadTools` / `registerWriteTools` / `registerFanoutTools`)
    is unchanged — its `(server, registry, config)` signature now sees
    a per-token registry instead of a shared one.
  - **Durable registrations.** JSON file with atomic write (`tmp + rename`)
    and a per-process write-chain mutex. Registrations survive restart;
    only ephemeral MCP-protocol sessions are in-memory.
  - **Auth.** `Authorization: Bearer <token>` is the documented primary
    path. `?token=<token>` query-string is accepted as a fallback for
    clients that only take a URL (older Claude Desktop builds), but
    the response carries `Deprecation: true` plus a `Link` header to
    RFC 6750 to nudge migration.
  - **Spec-compliant 401s.** Every 401 now carries
    `WWW-Authenticate: Bearer realm="elabftw-mcp", error="..."`
    (`invalid_request` for missing token, `invalid_token` for
    unknown / revoked).
  - **DNS-rebinding protection on by default** (the spec is explicit:
    servers MUST validate `Origin`). Allow-lists derive from
    `MCP_PUBLIC_URL` when not set explicitly; bind-address fallback
    with a startup warning if neither is configured.
  - **Cross-token session isolation.** A request authenticated with
    token A cannot use a session id minted by token B — returns 404
    (no leak that the session id is even valid).
  - **Deploy assets.** Multi-stage `Dockerfile` (Node 20, non-root
    user, healthcheck). `docker-compose.yml` with named volumes for
    registrations + Caddy data. `Caddyfile` with auto-TLS, security
    headers, and SSE-friendly stream timeouts (`flush_interval -1`,
    `read_timeout 300s`).

  Stdio mode remains the default — no behavioural change for existing
  installs. Set `MCP_MODE=hosted` to opt in.

### Changed

- `loadConfig()` accepts an optional `{ requireKeys: false }` to support
  hosted mode (where per-token credentials supersede boot creds).
  Stdio path still requires keys at startup.

## [0.2.0] — 2026-04-28

### Added

- **`elab_create_entity` field parity with PATCH.** The tool now also
  accepts `date` / `rating` / `status` / `custom_id` / `canread` /
  `canwrite` / `state` (`"normal"` / `"archived"`) at create time,
  matching every field `elab_update_entity` exposes. The two
  ad-hoc fallbacks (templates schemaPatched, content_type re-PATCH)
  collapsed into one reconciliation path: after POST, fetch the new
  entity, diff against requested values, and re-PATCH any field
  elabftw dropped or normalized. `canread` / `canwrite` use deep-equal
  on parsed JSON so whitespace / key-order normalization doesn't
  trigger needless re-PATCH. If the reconciliation PATCH itself fails,
  the response names the unreconciled fields. `ElabCreateEntityInput`
  gains the same fields for programmatic clients.
- `elab_update_entity` accepts `state: "normal" | "archived"` —
  archive (and un-archive) was previously only reachable through the
  elabftw UI. Soft-delete is deliberately routed through
  `elab_delete_entity` to keep the audit-trail entry point unambiguous.
- `elab_duplicate_entity` accepts `targetTeam` — re-targets the
  duplicate to a different team than the source. Useful for cloning
  shared templates into another team's workspace. The existing `team`
  arg still selects the configured key used for the duplicate call.
- `elab_create_entity` now accepts `content_type: "html" | "markdown"`,
  so markdown bodies (GFM tables, `#` headings, fenced code) render
  correctly without a second tool call. The MCP layer forwards the
  field on POST and, for older elabftw versions that drop it there,
  transparently re-PATCHes after the initial fetch (re-sending `body`
  so it flows through elabftw's markdown → HTML pipeline). If the
  fallback PATCH fails, the response includes a note pointing at
  `elab_update_entity` to retry. `ElabCreateEntityInput` gains the same
  field for programmatic clients.
- `elab_update_comment` / `elab_delete_comment` — comment CRUD parity.
  Both edits are permanent (elabftw treats comments as a regular write,
  not a destructive op). Gated by `ELABFTW_ALLOW_WRITES`.
- `elab_delete_step` — step deletion. Permanent.
- `elab_add_step` accepts `deadline_notif: boolean`. Note: some elabftw
  versions silently drop `deadline` / `deadline_notif` on step POST,
  and the v2 step PATCH dispatcher restricts to `action: finish`,
  so editing a step's deadline after creation is not currently
  possible via the API. Documented in the tool description.
- `elab_search_all_teams` extends the filter set to match
  `elab_search`: `category` / `status` / `tags` / `owner` / `scope` /
  `offset` are now honored across the fan-out.
- `elab_list_unfinished_steps` exposes the `/unfinished_steps` endpoint
  — a cohort-triage shortcut for finding which entities still have
  open checklist items.
- `elab_list_links` defaults `targetKind` to `'all'` (parallel
  fetch + concatenation of `experiments_links` + `items_links`),
  matching the merge behaviour of `elab_get(include=["links"])`.
  Pass `targetKind: 'experiments'` / `'items'` to narrow.

### Fixed

- **`client.addStep` silently dropped `deadline_notif: false`.** The
  outer ternary was a truthiness check, so passing `false` resulted
  in no `deadline_notif` field being sent at all instead of `0`. Now
  uses `!== undefined`, matching the rest of the codebase.
- **`client.listUnfinishedSteps` return type.** The endpoint actually
  returns `{ experiments?, items? }` with each entity carrying its
  open steps as `[stepId, body]` tuples, not the flat array the type
  previously claimed. Type updated; the new
  `elab_list_unfinished_steps` MCP tool renders the corrected shape.

## [0.1.3] — 2026-04-23

### Added

- `elab_create_entity` now accepts `experiments_templates` and
  `items_types` in addition to `experiments` and `items`. Enables
  creating blank templates / items-type schemas from the MCP. For
  schema kinds the tool performs a follow-up PATCH when `body` /
  `metadata` are supplied so edits land despite the POST endpoints
  only honoring `title` upstream (see elabftw/elabftw#4726). Failure
  of the follow-up PATCH is reported in the response instead of
  crashing the call.

### Fixed

- **`elab_create_entity` returned the wrong id.** `extractLocationId`
  matched the first digit run in the `Location` header, which on
  `/api/v2/experiments/<id>` is the `2` from the API version — not the
  new entity id. Now end-anchored. Also fixes step / comment / duplicate
  / upload id returns (every caller of `extractLocationId`).
- **`elab_update_entity` returned `400 "Invalid update target."`.**
  `ElabftwClient.update` was wrapping the patch as
  `{action:'update', ...fields}`. Modern elabftw v2 treats
  `action:'update'` as a legacy dispatch requiring `target` + `value`,
  and rejects a field-shaped body. Now PATCHes the fields directly.
- **`elab_link_entities` returned `400 "Incorrect content-type header"`.**
  `addLink` POSTs with no body, and `elabFetch` only set
  `Content-Type: application/json` when a body was present. elabftw
  requires the header on write methods even with no payload. `elabFetch`
  now sets it for all payloadless POST / PATCH / PUT requests (FormData
  uploads unaffected — they go through `rawBody`).

### Added

- `elab_search_users`, `elab_get_user`, `elab_list_team_users` read
  tools. Resolves the opaque `userid` field on entities to a real
  user (role, team memberships, and — when opted in — name / email).
- `ELABFTW_REVEAL_USER_IDENTITIES` env var (default `false`). When
  off, user names / emails / orcids are redacted to `user <id>` in
  all formatter output. `elab_me` is exempt.
- `elab_get` now accepts
  `include: ["steps","comments","attachments","links"]` and fans
  out sub-resource fetches in parallel. Drops per-entity round-trip
  count for cohort review from 4 to 1.
- `elab_get` body rendering is now lossless by default. New
  `format` arg: `markdown` (default) preserves HTML tables as GFM
  pipes and link hrefs via turndown; `text` is the previous
  regex-stripped output; `html` passes the raw body through. Ansatz
  tables and literature links now survive review. Markdown cap is
  4000 chars; text cap remains 2000.
- `elab_list_extra_field_names` exposes the instance-wide
  `/extra_fields_keys` endpoint. Use with `elab_get` on a template
  to discover the structured schema students are expected to fill.
- `elab_list_revisions` + `elab_get_revision` expose eLabFTW's
  per-entity revision history. Surfaces edit timestamps and
  authors, and renders historical bodies through the markdown
  converter.
- Client: new `ElabftwClient.listRevisions` /
  `ElabftwClient.getRevision` methods. New `ElabRevision` type.
- `elab_get_bulk` fetches up to 50 entities in one call with shared
  `include` / `format`. Chunks requests into groups of 8 so a
  50-id call doesn't open 50 sockets at once. Cohort-review
  shortcut: 40 students × 4 round-trips → 1 tool call.

### Changed

- **Breaking (default-on privacy):** `elab_list_comments` no longer
  prints `fullname` by default. Rows now render as
  `user <id> @ <timestamp>: ...`. Set
  `ELABFTW_REVEAL_USER_IDENTITIES=true` to restore the previous
  behaviour.
- **Breaking (default markdown body):** `elab_get`'s default body
  rendering switched from regex-stripped plaintext to turndown
  markdown (tables + link hrefs preserved). Pass `format="text"`
  to restore byte-for-byte legacy output.

## [0.1.0] — 2026-04-17

### Added

- Initial release.
- MCP server wrapping the elabftw v2 REST API.
- Read tools: `elab_me`, `elab_info`, `elab_search`, `elab_get`,
  `elab_list_attachments`, `elab_download_attachment`,
  `elab_list_comments`, `elab_list_steps`, `elab_list_links`,
  `elab_list_templates`, `elab_list_items_types`, `elab_list_tags`,
  `elab_list_events`, `elab_list_teams`, `elab_configured_teams`,
  `elab_export`.
- Write tools (gated by `ELABFTW_ALLOW_WRITES=true`): create / update /
  duplicate / delete entities, update a single extra_field, add comments
  / steps, toggle steps, link / unlink entities, add / remove tags.
- Destructive tools (gated by `ELABFTW_ALLOW_DESTRUCTIVE=true`): lock,
  force-unlock, RFC 3161 timestamp, bloxberg anchor, sign.
- Multi-team support: configure one API key per team via
  `ELABFTW_KEY_<teamId>` env vars; every tool accepts an optional
  `team` parameter that routes the call through the matching key.
- Fan-out `elab_search_all_teams` tool merges results across every
  configured team in parallel.
- Standalone `ElabftwClient` library export for programmatic use
  without running the MCP server.
