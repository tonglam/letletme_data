# Repository Guidelines

## Project Structure & Module Organization
- Source: `src/` with feature-focused folders: `api/`, `services/`, `jobs/`, `clients/`, `transformers/`, `repositories/`, `cache/`, `db/` (schemas, config), `types/`, `utils/`.
- Tests: `tests/unit/*.test.ts`, `tests/integration/*.test.ts`, fixtures in `tests/fixtures/`.
- Data & migrations: `migrations/`, `sql/`.
- Scripts and ops: `scripts/`, single-purpose `.ts` tools in repo root.

## Build, Test, and Development Commands
- `bun run dev` — start local server with watch (`src/index.ts`).
- `bun run build` — compile to `dist/` for Bun target.
- `bun start` — run compiled app in production mode.
- `bun test` / `bun run coverage` — run tests / with coverage.
- Lint/format: `bun run lint`, `bun run lint:fix`, `bun run format:fix`.
- Database (Drizzle): `bun run db:generate`, `bun run db:migrate`, `bun run db:studio`.

## Coding Style & Naming Conventions
- Language: TypeScript (ESM). Indent 2 spaces; max line width 100; single quotes; semicolons.
- Tools: ESLint + Prettier enforced; no `any` in source (tests allowed). Run `lint:fix` before PRs.
- Naming: camelCase for vars/functions, PascalCase for types/interfaces/enums, UPPER_SNAKE for constants/env keys. File names use kebab-case with role suffixes (e.g., `player-stats.service.ts`, `events.api.ts`, `events.schema.ts`).
- Data mapping: database fields may be snake_case; convert to camelCase in domain/types (tests assert this).

## Testing Guidelines
- Runner: Bun test (`bun:test`). Place unit tests under `tests/unit/` and integration under `tests/integration/`.
- Naming: `*.test.ts`. Use clear `describe` blocks and deterministic fixtures from `tests/fixtures/`.
- Aim to cover transformers, repositories, and API handlers; prefer fast unit tests, with selective integration tests for DB/cache paths.

## Commit & Pull Request Guidelines
- Commits: short imperative summary (≤72 chars), optional scope (e.g., `db:`, `api:`). Example: `feat(api): add events next endpoint`.
- PRs: include purpose, linked issues, test plan (`bun test` output), and any DB migration notes. Attach sample requests/responses for API changes (e.g., `curl /events/next`). Ensure lint and tests pass.

## Security & Configuration Tips
- Configure via `.env` (copy from `.env.example`); do not commit secrets. Required: `DATABASE_URL`, `REDIS_*`, `SUPABASE_*`, `PORT`.
- Use `bun run db:migrate` before local runs; prefer `db:studio` to inspect schema.
