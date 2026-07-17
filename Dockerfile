# syntax=docker/dockerfile:1

# Pinned to the exact Bun version CI tests against (package.json#packageManager).
FROM oven/bun:1.3.3 AS base
WORKDIR /app

# Install dependencies separately for caching
FROM base AS deps
COPY bun.lock package.json tsconfig.json ./
COPY drizzle.config.ts ./
RUN bun install --frozen-lockfile

# Production-only dependencies for the runtime image (devDeps never ship)
FROM base AS prod-deps
COPY bun.lock package.json tsconfig.json ./
COPY drizzle.config.ts ./
RUN bun install --frozen-lockfile --production

# Build the application
FROM deps AS build
COPY . ./
RUN bun run build

# Final runtime image
FROM oven/bun:1.3.3 AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy runtime files
COPY --from=build /app/package.json ./
COPY --from=build /app/bun.lock ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/sql ./sql
COPY --from=build /app/drizzle.config.ts ./
COPY --from=build /app/validate-env.ts ./
COPY --from=build /app/tsconfig.json ./

RUN groupadd -g 1001 appuser \
    && useradd -r -u 1001 -g appuser appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 3000

CMD ["bun", "dist/index.js"]
