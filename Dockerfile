# Multi-stage build for the @sura_ai/elabftw-hosted server.
#
# Builds both workspace packages (toolkit + hosted), then ships only
# the hosted runtime + its production deps (which include the toolkit
# via the symlinked workspace). Runs as a non-root user.

FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/toolkit/package.json ./packages/toolkit/
COPY packages/hosted/package.json ./packages/hosted/
RUN npm ci
COPY packages ./packages
RUN npm run build --workspaces

FROM node:22-slim AS runtime
RUN groupadd -r elabftw && useradd -r -g elabftw elabftw \
    && apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install production deps for both workspaces — the hosted package
# depends on @sura_ai/elabftw which npm resolves to the local workspace.
# better-sqlite3 ships prebuilt binaries for linux glibc x64/arm64.
COPY package.json package-lock.json ./
COPY packages/toolkit/package.json ./packages/toolkit/
COPY packages/hosted/package.json ./packages/hosted/
RUN npm ci --omit=dev --workspaces && npm cache clean --force

# Built artifacts. The toolkit is consumed via its dist/ output through
# the workspace symlink npm sets up under node_modules/@sura_ai/elabftw.
COPY --from=builder /app/packages/toolkit/dist ./packages/toolkit/dist
COPY --from=builder /app/packages/hosted/dist ./packages/hosted/dist

# Registrations live under a volume mount so they survive restart.
# Default path is the JSON file; switch with MCP_STORE_BACKEND=sqlite
# and (optionally) point MCP_REGISTRATIONS_PATH at a .db file.
RUN mkdir -p /var/lib/elabftw-mcp && chown elabftw:elabftw /var/lib/elabftw-mcp
ENV MCP_REGISTRATIONS_PATH=/var/lib/elabftw-mcp/registrations.json
ENV MCP_STORE_BACKEND=json
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=8000
ENV NODE_ENV=production

USER elabftw
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/healthz >/dev/null || exit 1

CMD ["node", "packages/hosted/dist/cli.js"]
