# Monorepo Scaffold

**Date:** 2026-02-16
**Duration:** ~10 min
**Scope:** Full Phase 0 monorepo scaffolding

## Summary

Set up the CramKit monorepo from scratch with four packages (shared, api, mcp, web), all wired together and building successfully via Turborepo.

## Changes

### Root Config
- `package.json` — pnpm workspace root with scripts: dev, build, lint, db:generate, db:push
- `pnpm-workspace.yaml` — declares `packages/*`
- `turbo.json` — pipeline: build (with ^build dep), dev (persistent), lint, db:generate, db:push
- `tsconfig.base.json` — strict, ESM, bundler moduleResolution
- `biome.json` — tabs, double quotes, organized imports, recommended lint rules
- `.gitignore` — node_modules, dist, data/, *.db, .env
- `.env.example` / `.env` — DATABASE_URL, LLM_*, CRAMKIT_API_URL
- `prisma/schema.prisma` — Session, File (with FileType enum), Chunk, Relationship models
- `data/sessions/.gitkeep` — ensures data dir exists

### packages/shared (`@cramkit/shared`)
- Prisma client singleton (`db.ts`)
- TypeScript types mirroring Prisma models (`types.ts`)
- Zod validation schemas for API endpoints (`schemas.ts`)
- Constants for file type labels, processing statuses (`constants.ts`)
- tsup build config (ESM + dts)

### packages/api (`@cramkit/api`)
- Hono server on port 8787
- Routes: sessions, files, chunks, relationships, search
- Services: file-processor (Phase 0 stub — stores raw as single chunk), storage (fs helpers)
- Processing queue via p-queue
- CORS middleware

### packages/mcp (`@cramkit/mcp`)
- MCP server with stdio transport (`@modelcontextprotocol/sdk`)
- Tool definitions: list_sessions, get_session, get_exam_scope, search_notes, get_file_content, get_chunk, get_file_index, list_past_papers, get_past_paper, list_problem_sheets
- HTTP API client for calling the API server

### packages/web (`@cramkit/web`)
- Vite + React 19 + Tailwind v4 + shadcn-compatible CSS variables
- Pages: Dashboard (session cards), NewSession (form), SessionDetail (header + files)
- Components: Layout (app shell), FileUpload (drag & drop), FileList (type badges + status)
- API client with Vite proxy (`/api` -> `:8787`)
- React Query for data fetching, React Router for navigation

## Verification

- `pnpm install` — 253 deps resolved
- `pnpm db:generate && db:push` — SQLite DB created at `data/cramkit.db`
- `pnpm build` — all 4 packages build successfully
- `pnpm lint` — 0 errors
- `pnpm dev` — web (:5173), API (:8787), MCP (stdio) all start
- `GET /sessions` returns `[]`, `GET /` returns version info

## Decisions & Notes

- Used Biome with tabs (not spaces) — auto-formatted on first lint:fix
- MCP tools use zod for parameter schemas, registered via a shared `registerTools` helper
- Web package uses Tailwind v4 with `@tailwindcss/vite` plugin (no PostCSS config needed)
- API uses Bun's native `--watch` for dev, tsup for production build
- File processing is Phase 0 stub: saves raw text as single chunk, no PDF conversion yet
