# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
