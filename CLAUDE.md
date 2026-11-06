# CLAUDE.md

Guidance for Claude Code in this repository: the **elabftw MCP toolkit** — an MCP server and programmatic client for the eLabFTW electronic lab notebook (API v2), plus a hosted HTTP mode. Target: eLabFTW 6.x (5.6 kept working where cheap).

## Layout

npm workspaces monorepo (`packages/*`), TypeScript, ESM, Node ≥ 22.

| Package | npm | What |
|---------|-----|------|
| `packages/toolkit` | `@sura_ai/elabftw` (bin `sura-elabftw-mcp`) | stdio MCP server + `ElabftwClient` |
| `packages/hosted` | `@sura_ai/elabftw-hosted` (bin `sura-elabftw-mcp-hosted`) | Express HTTP server wrapping the toolkit for remote clients: self-service registration, per-token isolation, JSON or SQLite token store, encrypted keys |

Toolkit source (`packages/toolkit/src/`):
- `client/` — the eLabFTW v2 client: `http.ts` (transport, `PACKAGE_VERSION`, user agent), `client.ts` (endpoints), `types.ts`, `native.ts` (round-trippable native view), `format.ts` (prose rendering), `markdown.ts` (markdown → HTML bodies).
- `mcp/server.ts` — server construction and the **server instructions** sent to clients (`serverInstructions`).
- `mcp/config.ts` — env parsing (keys per team, write gates, toolsets, timeouts).
- `mcp/toolsets.ts` — which tool belongs to which `ELABFTW_TOOLSETS` group; unlisted tools are `core`.
- `mcp/tools/` — `read.ts`, `write.ts`, `extra-fields.ts`, `team-guard.ts` (entity/team scoping), `fanout.ts` (cross-team search), `helpers.ts`.

Hosted source (`packages/hosted/src/`): `server.ts`, `sessions.ts`, `guards.ts` (Host/Origin, rate limiting, headers), `store/` (json, sqlite, crypto), `views.ts`, `env.ts`.

The root `dist/` is a stale leftover from the pre-monorepo layout (gitignored); builds go to `packages/*/dist/`.

## Commands

```bash
npm ci
npm run typecheck      # builds the toolkit first (hosted imports it), then tsc --noEmit in both
npm run build          # tsup in both packages
npm run dev:hosted     # build toolkit, run the hosted server
node packages/toolkit/dist/cli.js   # run the stdio server (needs ELABFTW_* env)
```

There is no automated test suite. Verify behaviour against a real eLabFTW instance (a local `.mcp.json`, gitignored, points a client at the built CLI) and say in the PR what was checked.

## Rules for changing tools

- **Gating.** Every mutating tool must respect `ELABFTW_ALLOW_WRITES`; lock/unlock/timestamp/bloxberg/deletes additionally `ELABFTW_ALLOW_DESTRUCTIVE`. Hosted mode ANDs the env flags with per-user choices — never widen either.
- **Toolsets.** A new tool outside `core` gets an entry in `TOOLSET_OF` (`mcp/toolsets.ts`) and in the README's Toolsets table.
- **Team scope.** Entity tools resolve and validate the team through `team-guard.ts`; with a single key the `team` param is stripped from schemas automatically — don't hand-roll either.
- **Descriptions are the agent's manual.** Tool descriptions and the server instructions are what clients read; keep them accurate, short, and in sync with behaviour. Shared vocabulary goes in `serverInstructions`, not repeated per tool.
- **Read-modify-write on `metadata`** goes through the per-entity serialization in the extra-fields tools; don't add new whole-blob writers.
- **Never** expose signing (needs the user's passphrase) or permanent deletion.
- Downstream consumer: the [`elabftw-rdm`](https://github.com/letrplB/elabftw-rdm) plugin documents this tool surface in its `elabftw-mcp` skill — a renamed, removed or re-gated tool needs a matching change there.

## Docs, changelog, release

- `README.md` (root) is also the npm page of both packages (`prepack` copies README / LICENSE / CHANGELOG into each package). Update its tool tables with every tool change.
- `CHANGELOG.md` — Keep a Changelog, SemVer; entries under `[Unreleased]` until release. Breaking changes are called out at the top of the version.
- Both packages share one version; hosted depends on `^<toolkit version>`.
- Release: bump both `package.json` versions (and hosted's toolkit dependency), date the changelog, commit `chore: release X.Y.Z`, tag `vX.Y.Z`, push the tag → `.github/workflows/publish.yml` checks that the tag matches both versions and publishes toolkit, then hosted, with provenance.
- Commit style: Conventional Commits with scope — `feat(toolkit): …`, `fix(hosted): …`, `docs: …`, `chore: …`.
- `dev-docs/` (gitignored) holds dated plan/log pairs (`YYYYMMDD-<topic>-plan.md` / `-log.md`) for larger changes.
- CI (`.github/workflows/ci.yml`) runs typecheck + build on Node 22 and 24, matching `engines`.
