# Build context: kamori/ root
# Usage: docker build -t kamori:local -f packages/ingest/Dockerfile .

# ---- build ----------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# better-sqlite3 requires native compilation tools
RUN apk add --no-cache python3 make g++

# Copy manifests for all workspaces first (layer-cache friendly)
COPY package*.json ./
COPY packages/core/package.json         ./packages/core/
COPY packages/ingest/package.json       ./packages/ingest/
COPY packages/mcp/package.json          ./packages/mcp/
COPY packages/sdk/package.json          ./packages/sdk/

RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Copy only what needs to compile
COPY tsconfig.json ./
COPY packages/core   ./packages/core
COPY packages/ingest ./packages/ingest
COPY packages/mcp    ./packages/mcp

RUN npm run build --workspace=@usekamori/core && \
    npm run build --workspace=@usekamori/ingest && \
    npm run build --workspace=@usekamori/mcp

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

COPY package*.json ./
COPY packages/core/package.json         ./packages/core/
COPY packages/ingest/package.json       ./packages/ingest/
COPY packages/mcp/package.json          ./packages/mcp/
COPY packages/sdk/package.json          ./packages/sdk/

RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev --ignore-scripts

COPY --from=build /app/packages/core/dist   ./packages/core/dist
COPY --from=build /app/packages/ingest/dist ./packages/ingest/dist
COPY --from=build /app/packages/mcp/dist    ./packages/mcp/dist

# Pre-built native binary — avoids rebuilding in runtime stage
COPY --from=build /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3

# Entrypoint script
COPY packages/ingest/docker-entrypoint.sh /app/docker-entrypoint.sh

# Persistent log data
RUN mkdir -p /app/data/logs /app/data/system

# Non-root user
RUN addgroup -S kamori && adduser -S kamori -G kamori && \
    chown -R kamori:kamori /app/data && \
    chmod +x /app/docker-entrypoint.sh
USER kamori

EXPOSE 3110 3111

CMD ["/app/docker-entrypoint.sh"]
