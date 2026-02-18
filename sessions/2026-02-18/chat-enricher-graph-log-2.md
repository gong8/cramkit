# Chat Enricher + Graph Log — Frontend

**Date:** 2026-02-18
**Duration:** ~30 minutes (total session including backend)
**Scope:** Backend for chat enricher agent + graph log, then frontend Activity Log panel in knowledge graph sidebar

## Summary

Implemented the full chat enricher agent and graph log system from the plan, then added the missing frontend. The Activity Log is a collapsible panel at the bottom of the Knowledge Graph sidebar showing color-coded graph mutation history from all sources (indexer, enricher, cross-linker, amortiser).

## Changes

### Backend (Part 1)

#### Database
- `prisma/schema.prisma` — Added `GraphLog` model with session relation, indexed on sessionId/source/createdAt

#### Chat Enricher Agent
- `packages/api/src/services/chat-enricher.ts` (NEW) — LLM agent with inline MCP server (4 tools), spawns `claude` CLI with `--max-turns 5`
- `packages/api/src/services/stream-manager.ts` — Entity extraction from `toolCallsData`, fire-and-forget enrichment in `finalizeStream()`
- `packages/api/src/lib/queue.ts` — `enrichmentQueue`, `enqueueEnrichment()`, result writing with dedup

#### Graph Log Write Points
- `packages/api/src/services/graph-indexer.ts` — GraphLog after `writeResultToDb()` (source: "indexer")
- `packages/api/src/lib/queue.ts` — GraphLog after cross-linking (source: "cross-linker")
- `packages/api/src/services/amortiser.ts` — GraphLog in both `amortiseSearchResults()` and `amortiseRead()` (source: "amortiser")

#### API + MCP
- `packages/api/src/routes/graph.ts` — `GET /sessions/:sessionId/graph-log`
- `packages/mcp/src/lib/api-client.ts` — `getGraphLog()` method
- `packages/mcp/src/tools/graph.ts` — `get_graph_log` MCP tool

### Frontend (Part 2)

- `packages/web/src/lib/api-types.ts` — `GraphLogEntry` interface
- `packages/web/src/lib/api.ts` — `fetchGraphLog()` function, re-export type
- `packages/web/src/components/graph/GraphSidebar.tsx` — `ActivityLogPanel` + `ActivityLogEntry` components; collapsible, lazy-loaded, auto-refreshes every 15s; color-coded source dots, relative timestamps, duration display
- `packages/web/src/pages/KnowledgeGraph.tsx` — passes `sessionId` to `GraphSidebar`

## Verification

- `pnpm db:generate && pnpm db:push` — schema applied cleanly
- `pnpm build` — all 4 packages build with no type errors
- `pnpm lint:fix` — only 3 pre-existing lint warnings remain (none from new code)

## Decisions & Notes

- Activity Log panel is **collapsed by default** — only fetches data when user clicks to expand (lazy via `enabled: expanded`)
- Auto-refresh at 15s interval while expanded, stops when collapsed
- `linkedPairs` computed in `extractAccessedEntities` but not used for filtering yet — kept for future if we want to skip entities already explicitly linked via `create_link`
- Enricher creates relationships with `createdBy: "enricher"` (distinct from "system" and "amortised")
- All GraphLog writes are try/catch wrapped — never fatal to the parent operation
