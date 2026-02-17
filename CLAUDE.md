# CramKit

Local-first study tool that gives Claude (via MCP) structured, indexed access to exam materials. pnpm monorepo with 4 packages.

## Quick Reference

```sh
pnpm install              # Install deps
pnpm db:generate          # Generate Prisma client (run after schema changes)
pnpm db:push              # Push schema to SQLite
pnpm dev                  # Start all services (web + api + mcp + Claude proxy)
pnpm build                # Build all packages
pnpm test                 # Run all tests
pnpm test:watch           # Tests in watch mode
pnpm lint                 # Check with Biome
pnpm lint:fix             # Auto-fix with Biome
pnpm kill                 # Kill ports 8787, 5173, 3456
```

## Architecture

```
packages/
  web/       — React 19 + Vite + Tailwind v4 + shadcn/ui (port 5173)
  api/       — Hono server, runs via Bun (port 8787)
  mcp/       — MCP server, HTTP (port 3001) + stdio for Claude Desktop
  shared/    — Prisma client, Zod schemas, types, constants, logger
```

- **Database**: SQLite via Prisma. Schema at `prisma/schema.prisma`. DB file at `data/cramkit.db`.
- **File storage**: Local filesystem under `data/sessions/{id}/raw/` and `data/sessions/{id}/processed/`.
- **Shared package**: Import from `@cramkit/shared` — exports `getDb()`, Zod schemas, types, constants, `createLogger()`.

## Code Style

- **Formatter/Linter**: Biome (not ESLint/Prettier)
- **Indent**: Tabs
- **Quotes**: Double quotes
- **Semicolons**: Always
- **Line width**: 100
- **Imports**: Use `.js` extensions in relative imports (ESM). Biome auto-organizes imports.
- **TypeScript**: Strict mode, target ES2022, module ESNext, bundler resolution
- **No unused imports/variables** (Biome warns)

## Conventions

- Routes go in `packages/api/src/routes/` — one file per resource, exported as `{name}Routes`
- Services go in `packages/api/src/services/` — business logic separate from routes
- Validation: Zod schemas defined in `packages/shared/src/schemas.ts`, shared across packages
- Logger: Use `createLogger("tag")` from `@cramkit/shared` (e.g. `const log = createLogger("api")`)
- API uses Hono — test routes with `app.request()`, not HTTP calls
- Web uses TanStack React Query for server state
- Web path alias: `@/*` maps to `packages/web/src/*`

## Testing

- **Framework**: Vitest with globals enabled (`describe`, `it`, `expect`, `vi` available without imports)
- **Test location**: `tests/` at monorepo root (not per-package)
  - `tests/unit/` — unit tests
  - `tests/integration/` — route/API tests
  - `tests/e2e/` — end-to-end flows
  - `tests/fixtures/` — helpers, seed data, mock LLM responses
- **Test DB**: Separate SQLite at `data/cramkit-test.db` (set in `tests/setup.ts`)
- **Mocking**: Use `vi.mock()` for module-level mocks (especially `llm-client.ts`)
- **DB cleanup**: Use `cleanDb(db)` from `tests/fixtures/helpers` in `beforeEach`
- **Timeout**: 30s per test, no file parallelism

## Database

After changing `prisma/schema.prisma`:
1. `pnpm db:generate` — regenerate Prisma client
2. `pnpm db:push` — apply to SQLite

Key models: Session → Resource → File/Chunk. Relationship and Concept for knowledge graph. Conversation → Message for chat.

## Commit Messages

Use conventional commits: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`

## Environment

Copy `.env.example` to `.env`. Key vars:
- `DATABASE_URL` — SQLite path (default: `file:./data/cramkit.db`)
- `LLM_BASE_URL` — Claude proxy URL
- `LLM_API_KEY` — Proxy key
- `LLM_MODEL` — Model ID
- `CRAMKIT_API_URL` — API base URL (default: `http://localhost:8787`)
