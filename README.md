# elabftw MCP

Model Context Protocol server for [elabftw](https://www.elabftw.net/) —
search, read, and (optionally) mutate experiments, items, attachments,
comments, steps, and links in an electronic lab notebook from any
MCP-aware AI client.

Target: elabftw **6.0** (tested against 6.0.9, the latest stable) via the
[API v2](https://doc.elabftw.net/api/v2/). 5.6 keeps working for most
tools; resource categories (`elab_list_items_categories`, `category` on
items) need 6.x.

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

With two or more keys, every tool takes an optional `team` parameter.
Omit it for the default; pass `team=7` to route a call through the
team-7 key. The tool `elab_search_all_teams` runs the same query across
every configured team in parallel and merges results. With a single key
the `team` parameter is left out of the tool schemas, since it could
only ever take one value.

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
| `ELABFTW_TEAM_ID` | no | auto | Single-team mode: pin the team. When unset it is looked up via `/users/me`; if that fails at startup the server starts anyway and retries when a tool needs the team. |
| `ELABFTW_ALLOW_WRITES` | no | `false` | `true` to expose create / update / delete / comment / step / link / tag tools. |
| `ELABFTW_ALLOW_DESTRUCTIVE` | no | `false` | `true` to additionally expose lock / unlock / timestamp / bloxberg / delete-entity / delete-comment / delete-tag / delete-compound. Irreversible or audit-affecting. Requires `ELABFTW_ALLOW_WRITES=true`. |
| `ELABFTW_REVEAL_USER_IDENTITIES` | no | `false` | `true` to surface user names / emails / orcids in formatter output. Default-off means user tools and comment listings return `user <id>` instead of PII. `elab_me` is exempt (callers always see their own identity). |
| `ELABFTW_TOOLSETS` | no | all | Comma-separated tool groups to register, or `all`. `core` is always on. See [Toolsets](#toolsets). |
| `ELABFTW_DOWNLOAD_DIR` | no | `<os tmpdir>/elabftw-mcp` | Where `elab_download_attachment` / `elab_export` save files they don't return inline (binaries, text over 100 KB). |
| `ELABFTW_TIMEOUT_MS` | no | `30000` | Per-request timeout in ms, covering the whole request including reading the response body. Must be a positive integer (max 2147483647); anything else is rejected at startup. |
| `ELABFTW_USER_AGENT` | no | `sura-elabftw-mcp/<version>` | Shows up in instance access logs. |

**Exactly one of `ELABFTW_API_KEY` or `ELABFTW_KEY_<teamId>` must be
set.** Mixing the two is rejected at startup.

`ELABFTW_BASE_URL` must be the final URL the instance is served from
(usually `https://`, exact host name). The client does not follow
redirects: following one would turn a POST into a GET and could send
the API key to another host. A redirect is reported as an error that
says so.

### Toolsets

Every MCP client without client-side tool search sends the full tool
list with each request, so a lab can drop groups it never uses.
`ELABFTW_TOOLSETS=extra_fields,steps` registers `core` plus those two
groups; unset or `all` registers everything.

| Toolset | Tools |
|---|---|
| `core` (always on) | `elab_search`, `elab_search_all_teams`, `elab_get`, `elab_get_bulk`, `elab_list_links`, `elab_list_templates`, `elab_list_items_types`, `elab_list_tags`, `elab_list_experiments_categories`, `elab_list_items_categories`, `elab_list_experiments_status`, `elab_list_items_status`, `elab_me`, `elab_info`, `elab_list_teams`, `elab_configured_teams`, `elab_create_entity`, `elab_update_entity`, `elab_convert_body_to_html`, `elab_duplicate_entity`, `elab_link_entities`, `elab_unlink_entities`, `elab_add_tag`, `elab_remove_tag`, `elab_create_tag`, `elab_delete_entity`, `elab_lock`, `elab_unlock`, `elab_delete_tag` |
| `extra_fields` | `elab_list_extra_fields`, `elab_list_extra_field_names`, `elab_set_extra_field`, `elab_update_extra_field`, `elab_remove_extra_field`, `elab_clone_extra_fields_schema`, `elab_set_extra_field_groups` |
| `steps` | `elab_list_steps`, `elab_list_unfinished_steps`, `elab_add_step`, `elab_update_step`, `elab_toggle_step`, `elab_delete_step` |
| `comments` | `elab_list_comments`, `elab_add_comment`, `elab_update_comment`, `elab_delete_comment` |
| `files` | `elab_list_attachments`, `elab_download_attachment`, `elab_export` |
| `compounds` | `elab_search_compounds`, `elab_get_compound`, `elab_search_pubchem`, `elab_create_compound`, `elab_create_compound_from_pubchem`, `elab_update_compound`, `elab_delete_compound` |
| `history` | `elab_list_revisions`, `elab_get_revision` |
| `users` | `elab_search_users`, `elab_get_user`, `elab_list_team_users` |
| `scheduler` | `elab_list_events` |
| `integrity` | `elab_timestamp`, `elab_bloxberg` |

Toolsets combine with the permission flags: write and destructive tools
in an enabled group still need `ELABFTW_ALLOW_WRITES` /
`ELABFTW_ALLOW_DESTRUCTIVE`, and `elab_search_all_teams` only appears
with two or more keys. An unknown toolset name is rejected at startup.

Measured size of the serialized tool list with writes and destructive
tools on: about 48k characters with one key, 59k with two keys (the
`team` parameter and `elab_search_all_teams` appear), 21k with
`ELABFTW_TOOLSETS=core`. Vocabulary shared by all tools (entity kinds,
markdown bodies, extra fields, the `team` parameter) is sent once in
the MCP server instructions rather than in every tool description.

## Tools

### Read (no permission flag needed)

| Tool | Purpose |
|---|---|
| `elab_me` | Show the user the API key is authenticated as. |
| `elab_info` | Instance version, PHP version, aggregate counts. |
| `elab_search` | List experiments / items / templates / items_types within one team. Supports the elabftw `extended` DSL (`rating:5 and tag:"buffer"`). |
| `elab_get` | Fetch a single entity with body and parsed `extra_fields`. `include=["attachments","steps","comments","links"]` adds sub-resources in the same call (links include linked compounds). Body rendering: `format="markdown"` (default) is the full body with tables and link hrefs preserved, never truncated, safe to edit and write back; `format="html"` is the raw body, never truncated; `format="text"` is a stripped 2000-character preview. `view="prose"` (default) returns a markdown summary; `view="native"` returns the record as JSON (see [Native view](#native-view--round-trippable-json)), round-trippable through `elab_update_entity({native: ...})`. |
| `elab_get_bulk` | Fetch up to 50 entities of the same kind with shared `include` / `format` / `view`. Chunks requests into groups of 8. Each id is team-validated before fetch. `view="native"` returns a JSON array. |
| `elab_list_attachments` | File attachment metadata on an entity. |
| `elab_download_attachment` | Text files (by extension or Content-Type, valid UTF-8) up to 100 KB are returned inline. Binaries and larger text are saved to `ELABFTW_DOWNLOAD_DIR` and the tool returns the absolute path, size and filename. In hosted mode only metadata is returned. No base64. |
| `elab_list_comments` | Comments on an entity. |
| `elab_list_steps` | Checklist steps. Unfinished shown as `[ ]`, finished as `[x]`. |
| `elab_list_links` | An entity's outgoing links. `targetKind=experiments` / `items` / `compounds` for one kind; `targetKind=all` (default) merges all three. |
| `elab_list_unfinished_steps` | Open checklist steps in the team, grouped by entity kind. `scope=user` (default): entries you own; `scope=team`: every readable entry of the team. Only entries of the resolved team are returned. |
| `elab_list_templates` | Experiment templates (`experiments_templates`). Instantiate one with `elab_create_entity(experiments, template=<id>)`. |
| `elab_list_items_types` | Resource templates (`items_types`). Instantiate one with `elab_create_entity(items, template=<id>)`. |
| `elab_list_items_categories` | Resource categories (eLabFTW 6.x). Set one with `category` on create / update. Their ids differ from `items_types` ids even when titles match. |
| `elab_list_tags` | Tags in a team. |
| `elab_list_events` | Scheduler / booking events. |
| `elab_list_teams` | All teams on the instance (for id → name mapping). Marks which teams have keys configured. |
| `elab_configured_teams` | List teams this MCP has keys for. |
| `elab_search_users` | Search users by name/email (empty `q` lists visible). Resolves opaque `userid` to identity. Requires team-admin key. Identity fields gated behind `ELABFTW_REVEAL_USER_IDENTITIES=true`. |
| `elab_list_extra_field_names` | Instance-wide list of every `extra_fields` key with usage counts. Returns `key (used N×)` rows for discovery; per-field type / options live in the owning template's metadata (see `elab_list_extra_fields`). |
| `elab_list_extra_fields` | Structured per-entity view of `extra_fields` — group, name, type, value, unit, required, options, position, description. Complements the prose `## Extra fields` block in `elab_get`. |
| `elab_list_experiments_categories` | Experiment categories (id, title, color, default marker). Set one with `category` on create / update. Categories are not templates. |
| `elab_list_experiments_status` | Experiment statuses on the current team. |
| `elab_list_items_status` | Item statuses on the current team. |
| `elab_search_compounds` | Search the team’s compound catalog by name / CAS / PubChem CID / InChI / SMILES / formula (`q`; omit to list all). One row per compound with a compact hazard summary. |
| `elab_get_compound` | Fetch one compound by id — name, identifiers (CAS, PubChem CID, ChEMBL, EC, ChEBI, KEGG, DrugBank, …), structure (InChI / SMILES / formula / MW / IUPAC), and an aggregated GHS / regulatory hazard summary. |
| `elab_search_pubchem` | Preview a compound from PubChem without storing it. Provide exactly one of `cid` / `cas` / `name`. CID returns one hit; CAS / name return arrays (and include hazard flags). |
| `elab_list_revisions` | List body revisions for an entity. Surfaces edit history (who / when / size) for cohort review. Per-instance availability. |
| `elab_get_revision` | Fetch one revision's body. Rendered through the markdown path (tables + hrefs preserved). |
| `elab_get_user` | Fetch one user by `userid`. Identity fields gated behind `ELABFTW_REVEAL_USER_IDENTITIES=true`. |
| `elab_list_team_users` | Roster for a given team. Works around the lack of a `/teams/{id}/users` endpoint by filtering `/users` client-side. Requires team-admin key. |
| `elab_export` | PDF / PDF-A / ZIP / ZIP-A / ELN / ELN-HTML / CSV / JSON / QR-PNG / QR-PDF. CSV and JSON up to 100 KB are returned inline; everything else is saved to `ELABFTW_DOWNLOAD_DIR` and the path returned (hosted mode: metadata only). |
| `elab_search_all_teams` | (two or more keys only) Fan out a search across every configured team in parallel. Accepts the same `q` / `extended` / `category` / `status` / `tags` / `owner` / `scope` / `state` / `order` / `sort` / `limit` / `offset` filters as `elab_search`. |

### Write (requires `ELABFTW_ALLOW_WRITES=true`)

| Tool | Purpose |
|---|---|
| `elab_create_entity` | Create any of the four kinds (experiments, items, experiments_templates, items_types). `template` (an `experiments_templates` id for experiments, an `items_types` id for items) instantiates it server-side the way the UI does: body, extra-fields schema, steps, links, tags, permissions and category come from the template, and everything else you pass is applied on top (`metadata` is merged into the template's, yours winning per field). `category` sets the experiment category / resource category. Also accepts `title` / `body` (markdown or HTML, stored as rich text; see [Rich body rendering](#rich-body-rendering)) / `body_format` / `content_type` / `tags` / `metadata` / `date` / `rating` / `status` / `custom_id` / `canread` / `canwrite` / `state` (`archived` archives and locks the entry after creation). Fields elabftw drops on POST are re-PATCHed; the response names any field that could not be applied. `category_id` is a deprecated alias of `template`. |
| `elab_update_entity` | Patch any of the four kinds; omitted fields stay unchanged. Title / body / `body_format` / content_type / category / status / rating / date / custom_id / metadata (replaces the whole blob) / permissions / `state`. `state: "archived"` archives and locks through elabftw's archive action; `state: "normal"` un-archives (the entry stays locked). Archived entries reject other edits until un-archived. Without `content_type` the entry keeps its current editor. Accepts `native` (the shape from `elab_get(view: "native")`) for a whole-record round-trip, including tags (made to match exactly) and permission base / immutability fields; explicit args win over `native`. Links inside `native` are ignored. Soft-delete goes through `elab_delete_entity`. |
| `elab_set_extra_field` | Create-or-replace one `extra_fields` entry via read-merge-PATCH. Typed: `text`, `number`, `checkbox`, `date`, `datetime-local`, `email`, `time`, `url`, `select`, `radio`, `experiments`, `items`, `users`, `compounds`, `uploads`. Validates per type (e.g. `select`/`radio` require `options` and a value among them; in `mode: 'merge'` a new value is checked against the field's existing options). For `experiments` / `items` / `compounds` types, also creates the entity-link unless `autoLink: false`. `mode: 'replace'` (default) writes the whole entry; `mode: 'merge'` updates only-provided properties. |
| `elab_update_extra_field` | Value-only fast path on an existing field (elabftw's server-side JSON_SET). Checkbox fields take `true` / `false`; numbers are sent as strings; `null` clears the value. Cannot create fields or change type / options / unit; pre-flights with a GET and returns an error pointing at `elab_set_extra_field` when the field is missing. |
| `elab_remove_extra_field` | Delete one `extra_fields` entry and prune empty groups; an emptied blob is written as `{}`. `alsoUnlink: true` (default) also removes the entity-link for typed pointer fields (`experiments` / `items` / `compounds`). |
| `elab_clone_extra_fields_schema` | Mirror the UI's "Load fields" button: the source defines each field's schema (type, options, units, group, …); values the target already has are kept, fields it lacks are added with the source's values. Groups merge by `id`. `blankValues: true` drops the source's example values (the target's own values are still kept). |
| `elab_set_extra_field_groups` | Manage `metadata.elabftw.extra_fields_groups` (named clusters that organize fields in the UI). `mode: 'replace'` overwrites; `mode: 'merge'` upserts by `id`. Rejects `id=-1` (reserved for the implicit default bucket). |
| `elab_convert_body_to_html` | Render a markdown body (stored as `content_type=2`, or raw markdown left under `content_type=1` after a user switched editors) to HTML so the entry opens formatted in the rich-text editor. No-op on HTML bodies. |
| `elab_duplicate_entity` | Duplicate with optional file copy and back-link. The copy lands in the team the API key's user currently has selected; the response says so when that differs from the source team. |
| `elab_add_comment` / `elab_update_comment` | Add / edit comments. Delete is gated behind destructive — see below. |
| `elab_add_step` / `elab_update_step` / `elab_toggle_step` / `elab_delete_step` | Manage checklist steps. `elab_add_step` accepts `deadline_notif`. `elab_update_step` edits `body` / `deadline` / `deadline_notif` in place (omitted fields untouched; pass `deadline: null` to clear). Step delete is permanent. |
| `elab_link_entities` / `elab_unlink_entities` | Link an entity to an experiment, item or compound (`targetKind`: `experiments` / `items` / `compounds`). Both ends must be in the same team. Linking twice is harmless. |
| `elab_add_tag` / `elab_remove_tag` | Tag management on a single entity. |
| `elab_create_tag` | Create a team-scoped tag without attaching it to any entity. Idempotent — elabftw's `INSERT ... ON DUPLICATE KEY UPDATE` returns the existing id on a duplicate string. Requires team-admin. Refuses when the key's user currently has a different team selected than the one the call targets. |
| `elab_create_compound` | Create a compound in the team’s catalog. Only `name` is required; everything else (PubChem / CAS / ChEMBL identifiers, InChI / SMILES / formula / MW / IUPAC name) is optional. Hazards are one `hazards: string[]` of short names, e.g. `["toxic", "flammable"]` (see below). If the follow-up PATCH for fields elabftw ignores on POST fails, the response still returns the new id and names the fields to retry with `elab_update_compound`. Attach with `elab_link_entities(targetKind: "compounds")`. |
| `elab_create_compound_from_pubchem` | Create a compound by fetching its full record from PubChem. Provide `cid` (preferred) or `cas`; elabftw resolves the identifier and pulls name / structure / IUPAC / hazard flags into the new row. Preview with `elab_search_pubchem` first. |
| `elab_update_compound` | Patch any subset of a compound’s fields; omitted fields stay untouched. `hazards` replaces the whole hazard set; omit it to keep the current one. Checks the compound's team first. |

Hazard names for `hazards`: `corrosive`, `explosive`, `flammable`,
`gas_under_pressure`, `hazardous2env`, `hazardous2health`, `oxidising`,
`toxic`, `radioactive`, `serious_health_hazard`, `antibiotic`,
`antibiotic_precursor`, `drug`, `drug_precursor`, `explosive_precursor`,
`cmr`, `nano`, `controlled`, `ed2health`, `ed2env`, `pbt`, `pmt`, `vpvb`,
`vpvm` (elabftw's `is_*` columns without the prefix).

### Destructive (requires `ELABFTW_ALLOW_DESTRUCTIVE=true`)

These alter the audit trail and most cannot be undone without admin
intervention. Gated behind a second flag on purpose.

| Tool | Purpose |
|---|---|
| `elab_delete_entity` | Soft-delete (state=3). The record is still retrievable with `state=deleted` and can be restored in the elabftw UI. Permanent deletion is sysadmin-only and not exposed. Gated behind destructive because even a soft-delete hides the row from default listings and can disrupt downstream readers. |
| `elab_delete_comment` | Permanently delete a comment. Not a soft-delete — the row is removed and the audit-trail entry shows the deletion. |
| `elab_delete_compound` | Soft-delete a compound (state=3). Permanent deletion is sysadmin-only and not exposed. Gated behind destructive because deletion can cascade through `compounds_links` references on experiments / items, removing link end-points downstream readers depend on. Checks the compound's team first. |
| `elab_lock` | Lock an entity. Idempotent: an already locked entity stays locked. |
| `elab_unlock` | Unlock an entity. Allowed for whoever locked it and for admins. |
| `elab_timestamp` | RFC 3161 trusted timestamp. Consumes from `ts_balance`. |
| `elab_bloxberg` | Anchor on the Bloxberg blockchain. |
| `elab_delete_tag` | Permanently delete a team-scoped tag. Cascades — elabftw's `TeamTags::destroy` detaches the tag from every entity that referenced it before deleting the row. Gated behind destructive flag because some teams use tags as permission gates. Requires team-admin; refuses when the key's user currently has a different team selected. |

There is no signing tool. elabftw's signature action needs the user's
signature-key passphrase, which should not pass through an agent; sign
entries in the elabftw UI.

### Rich body rendering

elabftw stores each entity body with a `content_type`: **HTML** (opens
in the rich-text TinyMCE editor) or **markdown** (opens in the markdown
editor). Lab members edit entries in the rich-text editor, and flipping
a markdown entry to rich text in the UI does not render it: the raw
markdown shows up as one unformatted paragraph.

So the write tools take markdown and store HTML. `body` on
`elab_create_entity` / `elab_update_entity` may be written in markdown
(headings, `**bold**`, lists, GFM tables, links); the toolkit renders it
to HTML and stores it with `content_type: "html"`. Raw HTML bodies pass
through unchanged. `body_format: "markdown" | "html"` pins the input
syntax; when omitted it is auto-detected.

```
elab_create_entity({ entityType: "experiments", title, body: "## Protocol\n\n| Reagent | Amount |\n|---|---|\n| TEOS | 4 mL |", tags })
elab_update_entity({ entityType: "experiments", id, body })
```

Pass `content_type: "markdown"` only when a user explicitly wants an
entry kept in the markdown editor; the body is then stored as-is.
`elab_update_entity` without `content_type` keeps the entry's current
editor, so entries a user deliberately keeps in markdown stay there.

Entries written before this change (or by other tools) can be fixed in
place with `elab_convert_body_to_html`, or with
`elab_update_entity({ content_type: "html" })` without a `body`. Both
render the stored markdown to HTML; entries that already hold HTML are
left alone.

On the read side, `elab_get` / `elab_get_bulk` / `elab_get_revision`
with `format: "markdown"` (default) return the full body converted back
to markdown, never truncated, so an agent can edit it and write it
back. Tables become GFM pipe tables (`colspan` padded with empty cells,
`|` inside cells escaped); tables GFM cannot express (row spans, nested
tables) stay raw HTML so no cell is lost. `<sub>` / `<sup>` are kept as
inline HTML and HTML entities are decoded. `format: "text"` is a
stripped 2000-character preview and is not meant for write-back.

## Working with extra fields

`extra_fields` are typed key / value pairs (`type=number` with a unit,
`type=select` with an options list, `type=experiments` as a typed
pointer to another entity, …) that live on every entity's `metadata`
blob and render as a structured form in the elabftw UI. Three patterns
cover the workflows that actually show up:

### Pattern 1 — Create from a template

Pass `template` to create an `items` from a resource template
(`items_types`) or an `experiments` from an experiment template:

```
elab_create_entity({ entityType: "items", template: 32, title: "DMSN_028" })
```

elabftw instantiates the template server-side, as the UI's "create
from template" does: the new entry gets the template's body,
`extra_fields` schema, steps, links, tags, permissions and category.
Anything else you pass is applied on top; your own `metadata` is merged
into the template's, yours winning per field. Omit `template` for a
blank entity.

Templates and categories are different things. `elab_list_templates`
and `elab_list_items_types` list templates (pass their ids as
`template`); `elab_list_experiments_categories` and
`elab_list_items_categories` list categories (pass their ids as
`category`). On eLabFTW 6.x a resource category and a resource template
with the same title have different ids.

### Pattern 2 — Add or update a single field

`elab_set_extra_field` is the agent-native equivalent of the UI's
field-builder modal. One call replaces the read-parse-merge-stringify-
PATCH dance.

Scalar with a unit:

```json
{
  "entityType": "items",
  "id": 475,
  "name": "d_H_DLS_nm",
  "type": "number",
  "value": 71,
  "units": ["nm"],
  "unit": "nm"
}
```

Choice field:

```json
{
  "entityType": "items",
  "id": 475,
  "name": "is_canonical",
  "type": "select",
  "options": ["yes", "no", "partial"],
  "value": "yes"
}
```

Typed pointer with auto-link (`type` is one of `experiments` / `items` /
`compounds`; setting the field also creates the corresponding
entity-link unless `autoLink: false`):

```json
{
  "entityType": "items",
  "id": 475,
  "name": "canonical_bet_analysis",
  "type": "experiments",
  "value": 1345
}
```

The full type vocabulary is the 15 elabftw extra-field types: `text`,
`number`, `checkbox`, `date`, `datetime-local`, `email`, `time`, `url`,
`select`, `radio`, `experiments`, `items`, `users`, `compounds`,
`uploads`. Note that `select` is the internal type name for what the
UI labels "Dropdown menu" — there is no separate `dropdown` type.
`mode: 'merge'` updates only-provided properties (preserves existing
`description`, `position`, etc.); the default `mode: 'replace'` writes
the whole entry.

### Pattern 3 — Update a value only

Once the field exists, `elab_update_extra_field` is the fast path —
it bypasses the read-merge-PATCH cycle and uses elabftw's JSON_SET
endpoint:

```
elab_update_extra_field({ entityType: "items", id: 475, fieldName: "d_H_DLS_nm", value: 84 })
```

The tool pre-flights with a GET and returns an error pointing at
`elab_set_extra_field` if the field doesn't exist yet. Checkbox fields
take `true` / `false`, numbers are sent as strings, and `null` clears
the value.

### Parallel calls

`elab_set_extra_field`, `elab_remove_extra_field`,
`elab_clone_extra_fields_schema` and `elab_set_extra_field_groups` read
the whole `metadata` blob, modify it and write it back. Calls on the
same entity are serialized inside the server, so an agent firing
several of them in parallel does not lose fields. `elab_update_extra_field`
writes a single value and is safe in parallel anyway. Serialization is
per server process; edits from other clients or the UI at the same
moment can still race.

### Discovery — listing what exists

- `elab_list_extra_fields({entityType, id})` — structured per-entity
  schema (groups, types, values, units, options, required, position).
- `elab_list_extra_field_names()` — instance-wide name + frequency
  index, useful for "which structured fields does this instance use at
  all?"
- `elab_get({entityType, id})` — prose-rendered `## Extra fields` block,
  human-readable inside a fuller entity view.

### Clone a schema

`elab_clone_extra_fields_schema({sourceEntityType, sourceId,
targetEntityType, targetId, blankValues: true})` is the agent
equivalent of the UI's "Load fields" button. The source defines each
field's schema (type, options, units, group, …); values the target
already has are kept, and fields it lacks are added with the source's
values. Pass `blankValues: true` to leave out the source's example
values; the target's own values are kept either way.

## Native view — round-trippable JSON

For workflows that need to read an entity, edit it in code, and write it
back as a whole, every read tool that produces an entity supports
`view="native"`:

```
elab_get({ entityType: "items", id: 475, view: "native" })
```

returns a single JSON object with the wire shape's stringified payloads
already parsed:

- `canread` / `canwrite` are objects (`{teams, users, teamgroups}`); the
  companion `canread_base` / `canread_is_immutable` (and `canwrite`
  versions) are preserved on the parent.
- `metadata` is the parsed extra-fields tree (extra_fields map +
  `elabftw.extra_fields_groups`), not a stringified blob.
- `tags` is `string[]`, with `tags_id` as `number[]` alongside.
- `experiments_links` / `items_links` / `compounds_links` are arrays
  (the wire already returns them inline on single-entity GET).

The same shape goes back through `elab_update_entity({native: ...})` —
the toolkit re-stringifies `canread` / `canwrite` / `metadata` before
PATCH. Only fields present in the supplied object are written; omitted
fields stay untouched. Explicit individual args (`title`, `body`, …)
win over `native` when both are passed. Specifically:

- `tags` is applied: the entity's tags are made to match the array
  exactly (missing ones added, extra ones removed).
- `canread_base` / `canwrite_base` / `canread_is_immutable` /
  `canwrite_is_immutable` are written.
- `state` goes through elabftw's archive / unarchive actions rather
  than a field PATCH. Archiving also locks the entry; archived entries
  reject edits until un-archived.
- `metadata: null` is written as `{}` (clears the blob).

Link arrays inside `native` are **not** applied on update. Use
`elab_link_entities` / `elab_unlink_entities` for those.

For typed single-field edits (`extra_fields[<name>].value`), keep using
`elab_set_extra_field` / `elab_update_extra_field` — those handle
per-type validation, auto-link side-effects, and the merge semantics
the read-modify-write loop doesn't.

`elab_get_bulk({ ..., view: "native" })` returns a JSON array.

## How team scoping works

With two or more keys configured, every tool that touches team-scoped
data accepts an optional `team: number` argument (with a single key the
argument is not offered):

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
would create entries in the wrong team. `elab_create_tag` and
`elab_delete_tag` act on the key's *current* team and refuse to run on
such a mismatch.

With a single `ELABFTW_API_KEY` and no `ELABFTW_TEAM_ID`, the key's
team is looked up via `/users/me`. If that fails at startup (instance
unreachable, VPN down), the server still starts, logs the reason, and
retries the lookup when a tool needs the team. Calls that need the team
return an error explaining what failed until the lookup succeeds.

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
- **Locked and archived entities reject edits.** `elab_update_entity`
  fails on a locked entry; `elab_unlock` is available under
  `ELABFTW_ALLOW_DESTRUCTIVE`. Archiving also locks, so an archived
  entry needs `state: "normal"` and then `elab_unlock` before it can be
  edited.
- **Upload `type` field is the parent entity type, not MIME.** The
  download tools decide text vs binary from the filename extension and
  the response Content-Type.
- **Attachment uploads are not exposed.** `elab_list_attachments` and
  `elab_download_attachment` are available, but there is currently no
  MCP tool for adding files to an entry — those still need to go
  through the elabftw UI. The underlying client method
  (`ElabftwClient.uploadFile`) exists for programmatic use.
- **Write bodies in markdown.** They are converted to HTML and stored
  for the rich-text editor; see "Rich body rendering" above. Pass
  `content_type: "markdown"` only when a user wants the markdown editor.
- **Redirects are not followed.** Set `ELABFTW_BASE_URL` to the final
  URL (usually `https://`, exact host name). Error messages carry at
  most about 1 KB of the instance's response, with the API key
  redacted.
- **Signing is not exposed.** It needs the user's signature-key
  passphrase; use the elabftw UI.

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

- **Registration** (durable). One per token. Maps a 256-bit bearer
  token to that user's eLabFTW API key(s), instance URL and eLabFTW
  `userid`. Created via `/register`, persisted to a JSON file (default)
  or SQLite (opt-in), survives restart. The store holds only
  `sha256(token)` and the API keys encrypted (see
  [Secrets at rest](#secrets-at-rest)).
- **MCP session** (ephemeral). One per active MCP connection,
  identified by the `Mcp-Session-Id` header per spec. Lives in memory;
  clients reconnect cheaply and persisting these across restarts buys
  nothing. Sessions close after 30 minutes without a request and are
  capped per token and globally (least recently used evicted first).

A registration is the long-lived "account"; a session is the per-tab
connection.

### Allowed eLabFTW instances

The server only ever talks to eLabFTW instances on an operator
allow-list: `MCP_ALLOWED_BASE_URLS` (comma-separated) or, when that is
unset, `ELABFTW_BASE_URL`. It refuses to start without one. Users
cannot type in a URL: with one allowed instance the forms just name it,
with several they show a picker. Tokens registered against an instance
that is not (or no longer) on the list get `403` on `/mcp`.

### Self-service token management

`/manage` is the token management page. Users log in by pasting an
eLabFTW API key once; that creates a server-side session (HttpOnly,
SameSite=Strict cookie scoped to `/manage`, 30 minutes idle) and every
form on the page carries a CSRF token. There is a log-out button.
Logged in, users see every token registered for *their eLabFTW user* on
that instance (joined by `userid`, not API-key value, so rotating their
eLabFTW key keeps every token visible), revoke any of them, or mint a
fresh one. Cross-linked from `/register` and the post-registration
success page so "lost the link" has a one-click recovery path.

**Tokens are shown once.** The server stores only a hash, so a token
is displayed exactly once, on the page right after `/register` or
*Mint a new token*. `/manage` lists tokens by label and a non-secret
id (the first 12 hex characters of the hash). A lost token cannot be
recovered: mint a new one and revoke the old one.

**Per-token permission flags.** The `/register` and *Mint a new
token* forms expose three checkboxes — *Allow write tools*, *Allow
destructive tools*, *Reveal real names*. Each token carries its own
set; effective behaviour at request time is the AND of the
registration setting and the operator's env-var setting (the env
vars listed in the *Environment* section below cap institutional
policy; the registration opts in). A checkbox whose operator cap is
off is shown disabled with an explanation. A PI can mint themselves a
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
grade actions (banning a user, bulk audit). The JSON / SQLite store is
the source of truth.

### Quick start — choose your stack

Two supported deploy shapes. Pick the one that matches your VPS.

#### Option A — Coolify / Dokploy / any PaaS that builds from a Dockerfile

If your VPS already runs Coolify (or Dokploy, CapRover, etc.), the bundled
`Dockerfile` is everything you need — the platform's built-in reverse proxy
handles TLS, you don't ship Caddy.

1. **Coolify → New Resource → Public Repository.** Point at this repo, set
   the branch (`main`).
2. **Build pack:** `Dockerfile` (Coolify auto-detects from the file at the
   repo root).
3. **Domain:** `mcp.example.tum.de`. Coolify provisions a Let's Encrypt cert
   for it via Traefik automatically.
4. **Port:** `8000` (matches `EXPOSE 8000` in the Dockerfile).
5. **Environment variables** (Coolify UI → Environment Variables):

   | Key | Value |
   |---|---|
   | `ELABFTW_BASE_URL` | `https://elab.example.com` (the instance users register against) |
   | `MCP_PUBLIC_URL` | `https://mcp.example.tum.de` |
   | `MCP_STORE_KEY` | output of `openssl rand -base64 32` (keep a copy outside the server) |
   | `ELABFTW_ALLOW_WRITES` | `true` (optional) |
   | `MCP_STORE_BACKEND` | `json` (default) or `sqlite` |

   `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` are derived from
   `MCP_PUBLIC_URL`; set them only to accept additional values.
   `MCP_TRUST_PROXY=1` (the default) fits Traefik as the single proxy
   hop. `MCP_HOST` / `MCP_PORT` / `MCP_REGISTRATIONS_PATH` are pre-set
   in the Dockerfile — Coolify inherits them, no need to repeat. For
   SQLite, point `MCP_REGISTRATIONS_PATH` at a `.db` file under the
   same volume mount.

6. **Persistent storage** (Coolify UI → Storages → Add). Mount a named
   volume at `/var/lib/elabftw-mcp` — that's where the registrations
   store lives (and the generated key file, if `MCP_STORE_KEY` is
   unset). Without this, every container rebuild wipes your users.
7. **Deploy.** Coolify pulls, builds, runs, exposes the domain.
   `https://mcp.example.tum.de/healthz` should return `ok` once the
   healthcheck passes (~30s after first start).

The bundled `docker-compose.yml` and `Caddyfile` are ignored on this path.
They are for Option B.

#### Option B — Bare VPS (Docker + the bundled Caddy)

Use this if your VPS doesn't run a PaaS and you want a full stack in one
command.

```bash
cp .env.example .env  # set ELABFTW_BASE_URL, MCP_DOMAIN, MCP_PUBLIC_URL, MCP_STORE_KEY
docker compose up -d
```

`docker-compose.yml` refuses to start without `ELABFTW_BASE_URL` and
`MCP_PUBLIC_URL`. Caddy auto-provisions a Let's Encrypt cert for
`MCP_DOMAIN` and reverse-proxies to the MCP container. Registrations
persist to a named volume (`mcp_registrations`) so container rebuilds
don't lose users. Tail logs with `docker compose logs -f mcp-elabftw`.

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
- Store key: `MCP_STORE_KEY` is set and backed up, or you know where
  the generated key file is (see [Secrets at rest](#secrets-at-rest)).

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
| `ELABFTW_BASE_URL` | yes, unless `MCP_ALLOWED_BASE_URLS` is set | — | The eLabFTW instance users register against. Also the allow-list when `MCP_ALLOWED_BASE_URLS` is unset. |
| `MCP_ALLOWED_BASE_URLS` | no | `ELABFTW_BASE_URL` | Comma-separated allow-list of eLabFTW instances. With more than one, `/register` and `/manage` show a picker. Entries are canonicalised (origin + path; query, fragment and userinfo rejected). |
| `MCP_PUBLIC_URL` | yes (compose); recommended otherwise | — | Public origin for personal URLs (e.g. `https://mcp.example.tum.de`). Also the source of the Host / Origin allow-list. Without it (and without `MCP_ALLOWED_HOSTS`) only requests addressed to the bind address are accepted. |
| `MCP_STORE_KEY` | strongly recommended | generated key file | 32-byte key, base64 or hex (`openssl rand -base64 32`), that encrypts the stored API keys. When unset, the server generates `<MCP_REGISTRATIONS_PATH>.key` (mode 0600) on first start and logs a warning. Changing or losing the key makes existing registrations unreadable. |
| `MCP_HOST` | no | `0.0.0.0` | Bind address. Behind a reverse proxy, leave at `0.0.0.0`. |
| `MCP_PORT` | no | `8000` | Bind port. |
| `MCP_STORE_BACKEND` | no | `json` | `json` (default; atomic-write JSON file, fine to a few hundred tokens, single server process only) or `sqlite` (`better-sqlite3`, WAL, indexed lookups, recommended for institutional scale). |
| `MCP_REGISTRATIONS_PATH` | no | `./registrations.json` | Where the store lives. JSON file or SQLite database depending on `MCP_STORE_BACKEND`. Mount a volume here in Docker. The Dockerfile sets it to `/var/lib/elabftw-mcp/registrations.json`. |
| `MCP_ALLOWED_HOSTS` | no | derived from `MCP_PUBLIC_URL` | Comma-list, `Host` allow-list for DNS-rebinding protection (overrides the derived value). |
| `MCP_ALLOWED_ORIGINS` | no | derived from `MCP_PUBLIC_URL` | Comma-list, `Origin` allow-list (overrides the derived value). |
| `MCP_TRUST_PROXY` | no | `1` | Number of reverse-proxy hops trusted for client IP and https detection. `1` = one proxy (Caddy, Traefik); `0` = app exposed directly. |
| `MCP_MAX_SESSIONS` | no | `500` | Live MCP sessions across all tokens; least recently used evicted. |
| `MCP_MAX_SESSIONS_PER_TOKEN` | no | `5` | Live MCP sessions per token; least recently used evicted. |
| `MCP_MAX_TOKENS_PER_USER` | no | `20` | Tokens per eLabFTW user per instance. |

`ELABFTW_ALLOW_WRITES` / `ELABFTW_ALLOW_DESTRUCTIVE` /
`ELABFTW_REVEAL_USER_IDENTITIES` are the operator's **upper bound**.
The effective value at request time is the AND of the env-var setting
and the user's own per-token setting (chosen via checkboxes on the
`/register` and *Mint a new token* forms). Set the env var to `true`
to allow users to opt in; leave it `false` to deny across the whole
process regardless of what users tick. `ELABFTW_ALLOW_DESTRUCTIVE`
additionally requires `ELABFTW_ALLOW_WRITES` at both layers.

`ELABFTW_TOOLSETS`, `ELABFTW_TIMEOUT_MS` and `ELABFTW_USER_AGENT` from
the [stdio table](#environment-stdio-package) apply to every token on
the server. The bundled `docker-compose.yml` does not pass them
through; add them under `environment:` if you need them.
`ELABFTW_DOWNLOAD_DIR` has no effect in hosted mode: remote clients
cannot read the server's disk, so `elab_download_attachment` and
`elab_export` return text inline (up to 100 KB) and only metadata for
everything else.

### Secrets at rest

- Bearer tokens are stored as `sha256(token)` only.
- eLabFTW API keys are encrypted with AES-256-GCM under the store key
  (`MCP_STORE_KEY`, or the generated `<MCP_REGISTRATIONS_PATH>.key`).
  The key file sits next to the store on the same volume, so a volume
  backup alone holds both; prefer `MCP_STORE_KEY` from your platform's
  secret store and keep a copy of it outside the server.
- The process runs with umask 077. The data directory is 0700; the
  store, key file and SQLite `-wal` / `-shm` files are 0600.

### Upgrading from 0.4.x

Hosted 0.5.0 migrates existing stores in place on first start (JSON
schema v3, SQLite schema v2; SQLite is VACUUMed so no plaintext stays
in free pages). Existing bearer tokens keep working. Before upgrading:

1. Set `MCP_STORE_KEY` (`openssl rand -base64 32`) and keep a copy, or
   plan to back up the generated `<MCP_REGISTRATIONS_PATH>.key` right
   after the first start. Losing the key makes every stored API key
   unreadable; users then have to register again.
2. Set `MCP_PUBLIC_URL` (the compose file now requires it) and make
   sure `ELABFTW_BASE_URL` / `MCP_ALLOWED_BASE_URLS` cover every
   instance existing tokens were registered against. Tokens for an
   instance outside the allow-list get `403`.
3. Treat backups taken before the upgrade as sensitive: they still hold
   plaintext tokens and API keys.

Everyone is logged out of `/manage` on every restart (those sessions
are in memory); MCP tokens are unaffected.

### Security posture

This is **designed for controlled-access institutional deployment**,
not for an open-to-the-public registration page. The auth model is a
static bearer token per registration, no OAuth dance. That fits a
PI / lab / research-group server behind a reverse proxy where access
is gated by an institutional firewall, VPN, or IdP. It does **not**
fit "anyone on the internet can hit `/register` and mint a token" —
for that, layer OAuth 2.1 with PKCE on top (via `oauth2-proxy`, your
IdP, or a future upstream feature).

What's implemented:

- TLS terminated at the reverse proxy (Caddy auto-TLS in the bundled
  Compose).
- Bearer-token auth required on every `/mcp` request, checked before
  the request body is parsed. 401s carry a spec-compliant
  `WWW-Authenticate` header so clients can discover the auth scheme.
- **eLabFTW instance allow-list.** The server never contacts an
  instance the operator did not list, so it cannot be used as an open
  relay or to probe internal hosts. Failed API-key checks return a
  generic message; upstream details go to the server log only.
- DNS-rebinding protection on by default (spec-mandated): `Host` and
  `Origin` are checked against the allow-list before any MCP server is
  built for the request.
- Cross-token session isolation: a session id minted by user A is a
  404 for user B's token (no information leak about whether the id is
  valid).
- Tokens are 256-bit random hex (not UUIDs — UUID v4 is only 122
  random bits), stored only as a hash and shown once. API keys are
  encrypted at rest (see [Secrets at rest](#secrets-at-rest)).
- **`/manage` sessions.** Server-side session after one API-key login,
  HttpOnly / SameSite=Strict cookie (`Secure` over https), CSRF token
  on every POST. The API key is not embedded in the page.
- `/register` and `/manage` responses send `Cache-Control: no-store`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and
  `X-Content-Type-Options: nosniff`.
- **Self-service revocation + edit.** Users revoke their own tokens
  at `/manage`. They can also edit a token in place (label, permission
  flags, default team for multi-team tokens) without invalidating the
  bearer value. Revocation and flag changes close any live MCP
  sessions on the affected token.
- **Per-token permission flags.** Each registration carries its own
  `allowWrites` / `allowDestructive` / `revealUserIdentities`. The
  operator's env vars cap the maximum; the registration opts in.
  Hosted servers can serve a PI with writes and students with
  read-only on the same process.
- **Tokens joined to eLabFTW userid**, not API-key value — rotating
  the eLabFTW key keeps tokens manageable.
- **Rate and resource limits.** Per-IP limits on requests that probe
  an API key against eLabFTW (`/register`, `/manage` login, adding a
  team: 10 per minute) and on other `/manage` actions (60 per minute).
  MCP sessions and tokens per user are capped (see
  [Environment](#environment)).
- Health probe at `GET /healthz` for orchestrator wiring.

What is **out of scope** for this release:

- Per-user audit logs.
- OAuth 2.1 / OIDC for institutional SSO. Until then the eLabFTW API
  key is the only credential we accept.

If your deployment posture requires any of those, file an issue —
they are deliberate omissions, not inherent limitations.

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

Without `MCP_STORE_KEY` the first start generates
`./.dev-registrations.json.key` next to the store; keep it with the
store or delete both together. Without `MCP_PUBLIC_URL` only
`localhost:8000` / `127.0.0.1:8000` are accepted as `Host`.

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
controlled-access institutional deployment behind a reverse proxy,
with each user registering their own API key against their own
bearer token. It is **not** designed for an open-to-the-public
registration page — for that, layer OAuth on top.

### Both modes

- **Writes are off by default.** Even a read-write API key is exposed
  to the model as read-only unless writes are enabled. In stdio mode
  set `ELABFTW_ALLOW_WRITES=true`; in hosted mode the env var caps
  the operator's policy *and* each registration must tick the
  matching checkbox at `/register` or `/manage`. Audit-trail actions
  (lock / unlock / timestamp / bloxberg) and deletes require a second flag,
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
