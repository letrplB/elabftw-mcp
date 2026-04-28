# Multi-stage build for the elabftw MCP server in hosted mode.
#
# Build stage compiles TypeScript with tsup; runtime stage carries
# only production deps + the compiled bundle. Runs as a non-root user.

FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
RUN addgroup -S elabftw && adduser -S elabftw -G elabftw
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Registrations file lives under a volume mount so it survives restart.
RUN mkdir -p /var/lib/elabftw-mcp && chown elabftw:elabftw /var/lib/elabftw-mcp
ENV MCP_REGISTRATIONS_PATH=/var/lib/elabftw-mcp/registrations.json
ENV MCP_MODE=hosted
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=8000
ENV NODE_ENV=production

USER elabftw
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/healthz || exit 1

CMD ["node", "dist/cli.js"]
