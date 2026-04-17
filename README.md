# @sura_ai/elabftw

Model Context Protocol server for [elabftw](https://www.elabftw.net/) —
search, read, and (optionally) mutate experiments, items, attachments,
comments, steps, and links in an electronic lab notebook from any
MCP-aware AI client.

Target: elabftw **5.5+** via the [API v2](https://doc.elabftw.net/api/v2/).
Node 18+.

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

## Environment

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
| `elab_get` | Fetch a single entity with body and parsed `extra_fields`. HTML body is stripped to plain text. |
| `elab_list_attachments` | File attachment metadata on an entity. |
| `elab_download_attachment` | Raw bytes. Text files returned as text; binary as base64. Files >2 MB are truncated with a note. |
| `elab_list_comments` | Comments on an entity. |
| `elab_list_steps` | Checklist steps. Unfinished shown as `[ ]`, finished as `[x]`. |
| `elab_list_links` | Cross-entity links (pass `targetKind=experiments` or `items`). |
| `elab_list_templates` | Experiment templates in a team. |
| `elab_list_items_types` | Items type schemas. |
| `elab_list_tags` | Tags in a team. |
| `elab_list_events` | Scheduler / booking events. |
| `elab_list_teams` | All teams on the instance (for id → name mapping). Marks which teams have keys configured. |
| `elab_configured_teams` | List teams this MCP has keys for. |
| `elab_export` | PDF / PDF-A / ZIP / ZIP-A / ELN / ELN-HTML / CSV / JSON / QR-PNG / QR-PDF. |
| `elab_search_all_teams` | (multi-team only) Fan out a search across every configured team in parallel. |

### Write (requires `ELABFTW_ALLOW_WRITES=true`)

| Tool | Purpose |
|---|---|
| `elab_create_entity` | Create an experiment or item (optionally from a template). Verifies the new entry lands in the requested team. |
| `elab_update_entity` | Patch title / body / category / status / rating / date / metadata / permissions. |
| `elab_update_extra_field` | Patch a single `extra_fields` value without rewriting the whole metadata blob. |
| `elab_duplicate_entity` | Duplicate with optional file copy and back-link. |
| `elab_delete_entity` | Soft-delete (state=3). Permanent deletion is sysadmin-only and not exposed. |
| `elab_add_comment` | Add a comment. |
| `elab_add_step` / `elab_toggle_step` | Manage checklist steps. |
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

## Development

```bash
npm install
npm run typecheck
npm run build      # emits dist/index.js, dist/cli.js, and dist/*.d.ts via tsup
```

Run the server locally against your instance:

```bash
ELABFTW_BASE_URL=https://elab.example.com \
ELABFTW_API_KEY=3-... \
node dist/cli.js
```

## Security model

The deployment model here is deliberately conservative. This is worth
saying plainly because MCP tool-calling has drawn real critique from
the elabftw community (see
[elabftw#5649](https://github.com/elabftw/elabftw/issues/5649) where
upstream declined to build an official MCP, citing tool-poisoning and
firewall concerns).

- **stdio only, no network exposure.** The server talks MCP over
  stdin/stdout to a locally-trusted parent process (Claude Desktop,
  Claude Code, Cursor, etc.). No port is opened.
- **The user's own API key.** All elabftw calls are authenticated with
  a key you minted in *your* UI, with *your* permissions. The MCP has
  no elevated access — it can only do what you could do by hand.
- **Firewall-bound instances stay that way.** The MCP runs on your
  machine; only your machine talks to elabftw. It does not route data
  through any third-party service.
- **Writes are off by default.** Even a read-write API key is exposed
  to the model as read-only unless you set `ELABFTW_ALLOW_WRITES=true`.
  Audit-trail actions (lock/sign/timestamp/bloxberg) require a second
  flag, `ELABFTW_ALLOW_DESTRUCTIVE=true`.
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
