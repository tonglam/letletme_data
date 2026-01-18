# syntax=docker/dockerfile:1

FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies separately for caching
FROM base AS deps
COPY bun.lock package.json tsconfig.json ./
COPY drizzle.config.ts ./
RUN bun install --frozen-lockfile

# Build the application
FROM deps AS build
COPY . ./
RUN bun run build

# Final runtime image
FROM oven/bun:1 AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy runtime files
COPY --from=build /app/package.json ./
COPY --from=build /app/bun.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/sql ./sql
COPY --from=build /app/drizzle.config.ts ./
COPY --from=build /app/validate-env.ts ./
COPY --from=build /app/tsconfig.json ./

RUN groupadd -g 1001 appuser \
    && useradd -r -u 1001 -g appuser appuser
USER appuser

EXPOSE 3000

CMD ["bun", "dist/index.js"]
