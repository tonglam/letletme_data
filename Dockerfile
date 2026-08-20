# syntax=docker/dockerfile:1

# Pinned to the exact Bun version CI tests against (package.json#packageManager).
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS base
WORKDIR /app

RUN apk upgrade --no-cache libcrypto3 libssl3

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
# Ensure `bun build` inlines production NODE_ENV so the prod logger path is used
# and pino-pretty (devDependency) is not required at runtime.
ENV NODE_ENV=production
COPY . ./
RUN bun run build

# Final runtime image
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk upgrade --no-cache libcrypto3 libssl3

# Copy runtime files
COPY --from=build /app/package.json ./
COPY --from=build /app/bun.lock ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/drizzle.config.ts ./
COPY --from=build /app/validate-env.ts ./
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/.grok ./.grok

RUN addgroup -S -g 1001 appuser \
    && adduser -S -D -H -u 1001 -G appuser appuser \
    && mkdir -p /home/appuser/.grok /tmp \
    && chown -R appuser:appuser /app /home/appuser
USER appuser

EXPOSE 3000

CMD ["bun", "dist/index.js"]
