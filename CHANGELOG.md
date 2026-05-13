# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] — 2026-05-13

### Fixed

- **`elab_update_compound` hazard flag PATCH was silently writing 0** for
  every hazard column. elabftw's `CompoundParams::getContent()` routes
  `is_*` keys through `Filter::onToBinary($content)`, which returns 1
  only when the input is the literal string `"on"` — the toolkit was
  sending integer `1` / `0`, which fell through to the 0 branch. Fixed
  by emitting `"on"` / `""` for hazard booleans in
  `serializeCompoundPatch`; POST tolerates the same encoding so a
  single helper covers both verbs.
- **`elab_create_compound` silently dropped most fields** —
  elabftw's `Compounds::postAction` create signature destructures
  `$reqBody` for a fixed subset (17 keys) and ignores everything else.
  `molecular_weight`, all long-tail identifiers (`ec_number`,
  `chebi_id`, `chembl_id`, `dea_number`, `drugbank_id`, `dsstox_id`,
  `hmdb_id`, `kegg_id`, `metabolomics_wb_id`, `nci_code`,
  `nikkaji_number`, `pharmgkb_id`, `pharos_ligand_id`, `rxcui`, `unii`,
  `wikidata`, `wikipedia`), and 16 of the 24 hazard flags (`is_cmr`,
  `is_nano`, `is_controlled`, `is_radioactive`, `is_pbt`, `is_pmt`,
  `is_vpvb`, `is_vpvm`, `is_ed2health`, `is_ed2env`, `is_antibiotic`,
  `is_antibiotic_precursor`, `is_drug`, `is_drug_precursor`,
  `is_explosive_precursor`) all bypass create. Added a reconcile-on-POST
  PATCH: after the create returns the new id, the toolkit issues a
  follow-up PATCH for every caller-supplied field outside the POST
  signature. Same approach as the elab_create_entity reconcile loop.
- **`elab_update_step` body / deadline PATCH was rejected** with
  `400 "Incorrect parameter for steps"`. elabftw's
  `Apiv2Controller::handlePatch` defaults to `Action::Update` only when
  no `action` key is present in the body; if `action: 'update'` IS
  present, it survives into `$params` and `Steps::patch`'s
  `Action::Update` branch iterates the dict and feeds *every* key
  (including `action` itself) to `StepParams`, which whitelists only
  `body` / `deadline` / `finished_time` / `is_immutable` and throws on
  anything else. Fixed by sending the bare field-update body (no
  `action` key) for body/deadline edits. `deadline_notif` continues to
  go through the dedicated `Action::Notif` (toggle, requires deadline)
  and `Action::NotifDestroy` (clear) actions — wrapped in a
  read-modify-write to give the agent idempotent boolean semantics
  (`true` only toggles when currently `0`; `false` always uses
  `NotifDestroy`). Combined updates apply body/deadline first so the
  notif toggle sees the new deadline.

Live-verified against AC2 (`elabftw-lin.uni-ulm.de`, team=2): 14-field
create with `molecular_weight: 88.15`, `ec_number: '200-752-1'`,
`chembl_id`, `kegg_id`, plus 5 hazard flags spanning POST-accepted and
POST-dropped sets — every field lands on the read-back. Subsequent
PATCH toggling 6 hazard flags (3 on, 3 off, 1 untouched) — all six
land, the untouched flag stays. Step update on experiment #1297 —
body edit, deadline set, deadline_notif on (idempotent), off,
combined update, deadline clear — 9/9 pass.

### Added

- **Native view — round-trippable JSON shape for entities.**
  `elab_get` and `elab_get_bulk` gain a `view: 'prose' | 'native'` arg
  (default `'prose'`, unchanged behaviour). With `view: 'native'` the
  tool returns the wire shape as a JSON object with the stringified
  payloads pre-parsed:
  - `canread` / `canwrite` → `{teams, users, teamgroups}` objects, with
    companion `canread_base` / `canread_is_immutable` (and `canwrite`
    versions) preserved as siblings.
  - `metadata` → the parsed extra_fields tree (extra_fields +
    `elabftw.extra_fields_groups`), not a stringified blob.
  - `tags` → `string[]`, `tags_id` → `number[]` (elabftw stores these
    as `|`-delimited and `,`-delimited strings — yes, different
    delimiters).
  - `experiments_links` / `items_links` / `compounds_links` →
    `ElabLink[]` (the single-entity GET response already inlines them).

  `elab_update_entity` gains an optional `native` arg that accepts the
  same shape. The toolkit re-stringifies `canread` / `canwrite` /
  `metadata` before PATCH. Only fields *present* in the supplied
  object are written. Explicit individual args layer on top of `native`
  (explicit wins) so agents can patch a whole record while overriding
  a single field.

  Scope boundary: tag and link sub-arrays inside `native` are *not*
  applied on update — use `elab_add_tag` / `elab_remove_tag` and
  `elab_link_entities` / `elab_unlink_entities`. Per-extra-field edits
  should still go through `elab_set_extra_field` /
  `elab_update_extra_field` (they own per-type validation, auto-link
  side-effects, and merge semantics).

  Types exported: `ElabEntityNative`, `ElabPermissions`,
  `NativePatchResult`. Helpers exported: `toNativeEntity`,
  `nativeToUpdate`.
- **PubChem integration** — two new tools wrap elabftw's PubChem
  importer (CSP-allowed on this instance at
  `pubchem.ncbi.nlm.nih.gov`):
  - `elab_search_pubchem` (read) — preview a substance from PubChem
    without storing it. Provide exactly one of `cid` / `cas` / `name`.
    CID returns a single hit (no hazard flags); CAS / name return
    arrays and *do* include hazard flags (resolved by PubChem's GHS
    classification). Camel-case field shape (`molecularFormula`,
    `iupacName`, `isCorrosive`, …) per elabftw's importer convention,
    typed as `ElabPubchemHit`.
  - `elab_create_compound_from_pubchem` (write, gated by
    `ELABFTW_ALLOW_WRITES`) — `POST /compounds` with
    `action: 'duplicate'` and `{cid}` / `{cas}`. elabftw resolves the
    identifier (CID preferred; CAS falls back through PubChem's CAS
    → CID lookup) and creates the new compound with name + structure +
    hazard flags pre-filled.

  Preview-then-commit flow: agents typically `elab_search_pubchem({cid})`
  to confirm what the importer will pull, then
  `elab_create_compound_from_pubchem({cid})` to commit. Existing
  `elab_create_compound` remains the manual-create path for substances
  not in PubChem.
- **Compound CRUD** — five new tools wrap the `/compounds` endpoint
  surface so agents can manage chemical substances directly instead of
  going through the elabftw UI:
  - `elab_search_compounds` (read) — full-text search by name / CAS /
    PubChem CID / InChI / SMILES / formula; one row per hit with a
    compact hazard summary.
  - `elab_get_compound` (read) — full record for one compound:
    identifiers (CAS, PubChem CID, ChEMBL, EC, ChEBI, KEGG, DrugBank,
    DEA, HMDB, UNII, WikiData, …), structure (InChI / InChIKey /
    SMILES / formula / MW / IUPAC), GHS / regulatory hazard flags.
  - `elab_create_compound` (write, gated by `ELABFTW_ALLOW_WRITES`) —
    create a compound; only `name` is required, everything else maps to
    the catalog fields. Hazard booleans coerced to 0/1 on the wire.
  - `elab_update_compound` (write) — patch any subset of fields. Plain
    PATCH semantics; omitted fields stay untouched.
  - `elab_delete_compound` (destructive, gated by
    `ELABFTW_ALLOW_DESTRUCTIVE`) — soft-delete (state=3) consistent
    with `elab_delete_entity`. Behind destructive because deletion can
    cascade through `compounds_links` on experiments / items.

  Compound fields previously only reachable via `elab_set_extra_field
  (type: "compounds")` and `elab_link_entities(targetKind: "compounds")`;
  now the compound entities themselves are first-class. Closes plan
  §7.2 from `dev-docs/20260512-extra-fields-and-discovery-plan.md`.
- **`elab_update_step`** — edit a checklist step in place. Pass any
  subset of `body` / `deadline` / `deadline_notif`; omitted fields are
  left untouched. `deadline` accepts a `YYYY-MM-DD HH:MM:SS` string or
  `null` to clear. Closes the long-standing gap where the only way to
  fix a step's prose was delete + re-add (which lost the step's
  audit-trail history and reordered the checklist). Gated by
  `ELABFTW_ALLOW_WRITES`; not a destructive operation.
- **`elab_set_extra_field`** — create-or-update one `extra_fields`
  entry on any entity. Typed against the full 15-type elabftw 5.5
  vocabulary (`text`, `number`, `checkbox`, `date`, `datetime-local`,
  `email`, `time`, `url`, `select`, `radio`, `experiments`, `items`,
  `users`, `compounds`, `uploads`), with per-type validation
  (`select` / `radio` require `options`; numeric values must parse;
  entity-link types take a positive integer id). For `experiments` /
  `items` / `compounds` typed fields, also creates the corresponding
  entity-link unless `autoLink: false`. `mode: 'replace'` (default)
  writes the whole entry; `mode: 'merge'` updates only-provided
  properties. Replaces the agent's manual read-merge-PATCH dance.
- **`elab_remove_extra_field`** — delete one `extra_fields` entry,
  prune empty groups + `elabftw` namespace, and (with
  `alsoUnlink: true`, the default) drop the entity-link for typed
  pointer fields. Mirrors the UI's cleanup at
  `Metadata.class.ts:138-168`.
- **`elab_list_extra_fields`** — structured per-entity view of
  `extra_fields` (group, name, type, value, unit, required, options,
  position, description). Complements the prose `## Extra fields`
  block in `elab_get` with a copy-paste-ready shape for "build me a
  clone of #475 with these tweaks" workflows.
- **`elab_clone_extra_fields_schema`** — agent-native parity with the
  UI's "Load fields" button. Deep-merges `extra_fields` (plus groups)
  from a source entity onto a target, preserving the target's
  existing per-field `value`s. `blankValues: true` strips defaults
  for schema-only copy.
- **`elab_set_extra_field_groups`** — manage
  `metadata.elabftw.extra_fields_groups` (named clusters that
  organize fields in the UI). `mode: 'replace'` overwrites;
  `mode: 'merge'` upserts by `id`.
- **`elab_list_experiments_categories`** — list templates /
  experiment categories on the current team (id, title, color,
  default marker).
- **`elab_list_experiments_status`** — list experiment statuses on
  the current team.
- **`elab_list_items_status`** — list item statuses on the current
  team.
- **`elab_create_tag`** — team-scoped tag creation without entity
  attachment. Idempotent (`INSERT ... ON DUPLICATE KEY UPDATE`
  returns the existing id on duplicate strings). Requires
  team-admin; gated by `ELABFTW_ALLOW_WRITES`.
- **`elab_delete_tag`** — permanent team-scoped tag deletion, with
  cascade detach via elabftw's `TeamTags::destroy`. Gated behind
  `ELABFTW_ALLOW_DESTRUCTIVE` because some teams use tags as
  permission gates.

### Changed

- **`elab_delete_entity` and `elab_delete_comment` are now gated
  behind `ELABFTW_ALLOW_DESTRUCTIVE`** (previously available with
  just `ELABFTW_ALLOW_WRITES`). `elab_delete_entity` is still a
  soft-delete (sets `state=3`), but even a soft-delete hides the row
  from default listings and can disrupt downstream readers;
  `elab_delete_comment` is a true hard-delete. Both now sit with
  `elab_lock` / `elab_sign` / `elab_delete_tag` under the destructive
  flag. Add / update on comments and entities remain on
  `ELABFTW_ALLOW_WRITES`.
- **`elab_create_entity` auto-loads the items_type / template
  schema** for `items` / `experiments` when `category_id` is set
  (new `loadFieldsFromCategory` flag, default `true`). The source
  schema is merged into the caller's `metadata` before POST —
  caller's per-field values win, the schema fills in the rest. The
  response message reports the inherited field count or surfaces a
  fallthrough note when the source-schema fetch failed. Closes the
  AC2 demo failure mode where `category_id` set the relation but the
  item came up without the items_type's structured fields.
- **`elab_create_entity` reconcile loop now covers `metadata`,
  `body`, and `tags`** in addition to the previously-reconciled
  scalar fields. elabftw 5.5 silently drops `metadata` on `POST
  /items` for regular kinds; the reconcile loop now re-PATCHes
  after fetch so the values land on the first tool call. `body` is
  compared exact-string with an empty-input guard (so we don't
  clobber elabftw's HTML pipeline output with `""`); `tags` are
  compared as a set and reconciled via per-tag
  `client.addEntityTag(...)` since the entity PATCH endpoint does
  not accept a `tags` field. Closes the deferred §5.1 / §5.2 items
  from the 2026-04-28 plan.
- **`elab_update_extra_field` pre-flight guard.** The tool now GETs
  the entity, checks `metadata.extra_fields[<name>]` exists, and
  returns a friendly error pointing at `elab_set_extra_field` when
  it doesn't. Previously the JSON_SET endpoint accepted the call
  and silently no-op'd on a non-existent field — the AC2 session
  spent a debug round on this. Tool description also rewritten to
  lead with the value-only limitation.
- **`elab_list_extra_field_names` returns real rows.** The endpoint
  shape is `[{extra_fields_key, frequency}]` — our typings claimed
  `[{name, type, options}]`, so every row rendered as
  `undefined | undefined`. Fixed: rows now render as
  `key (used N×)` sorted by frequency desc. Empty-state message
  points at `elab_get` on a template / items_type for per-field
  type / options (which this endpoint does not carry).

### Fixed

- **F1 — `elab_list_extra_field_names` undefined rows.** See
  *Changed* above; called out separately because it was a real bug
  reproduced live on AC2 team=2.
- **F2 — `metadata` dropped on `POST /items` (elabftw 5.5).** The
  reconcile loop in `elab_create_entity` now also covers `metadata`,
  `body`, and `tags`, so the values land on the first tool call.
- **F4 — Turndown was escaping underscores in body markdown** —
  `d_H_DLS_nm` rendered as `d\_H\_DLS\_nm`. The converter's `escape`
  now drops underscore + bracket escapes (it already uses
  `emDelimiter: '*'` so underscore-emphasis ambiguity isn't a
  concern); only `\`, `*`, and `` ` `` remain escaped. Body
  markdown round-trips cleanly.
- **`elab_set_extra_field` merge mode no longer clobbers `value`.**
  Initial implementation built a fully-typed default entry then
  merged the caller's args on top, so a `mode: 'merge'` call that
  only touched `description` would reset the field's `value` to
  empty. Surfaced during live AC2 verification on item #476. Fixed
  by threading a `partial` flag through `buildExtraFieldEntry` so
  merge mode only includes explicitly-provided properties (per-type
  validation still runs).
- **Raw markdown bodies round-trip byte-identical** when
  `entity.content_type === 2` (elabftw's "body is native markdown"
  flag) and `format='markdown'`. Previously the default markdown
  format ran the body through Turndown's HTML → MD pipeline even
  when the body was already markdown, introducing list-marker reflow
  (`-` → `*`), table-cell whitespace, and residual punctuation
  escapes. HTML bodies (`content_type=1`) still go through Turndown
  unchanged.

## [0.4.2] — 2026-04-29

### Added

- **Edit a token in place** from `/manage`. Each row gets an *Edit
  token settings* fold-out with the token's current label,
  permission flags, and (for multi-team tokens) default-team radio
  buttons all pre-populated. One *Save changes* button POSTs to a
  combined `/manage/edit` endpoint that applies only the diffs and
  redirects (PRG) to a `/manage/edited` confirmation page listing
  what changed.
- Live MCP sessions on the token are dropped when permissions or
  default team change, so the next reconnect picks up the new tool
  surface. Pure label edits don't disturb sessions.
- The bearer token value itself is unchanged across edits — clients
  keep using the same URL + header. Previously, fixing a typo'd
  label or escalating from read-only to read-write meant revoke +
  re-mint, which forced re-pasting the new Bearer URL into every
  client that referenced the old token.

### Changed

- `RegistrationStore` interface gains `updateLabel`, `updateFlags`,
  `updateDefaultTeam`. Both backends share the same pattern as
  `revokeForUser` — scoped by `(userid, baseUrl)` so cross-user
  edits are impossible from this surface.

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
