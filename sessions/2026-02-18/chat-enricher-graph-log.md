# Chat Enricher Agent + Graph Log

**Date:** 2026-02-18
**Duration:** ~20 minutes
**Scope:** Background LLM agent to enrich knowledge graph after chat turns, plus audit trail for all graph mutations

## Summary

Implemented a chat enricher agent that fires in the background after each assistant response, analyzing which entities (concepts, chunks, resources) were accessed during the turn and creating missing knowledge graph relationships. Also added a persistent GraphLog model that tracks all graph mutations across every source (indexer, enricher, cross-linker, amortiser).

## Changes

### New: Chat Enricher Agent
- `packages/api/src/services/chat-enricher.ts` — LLM agent following cross-linker pattern: inline stdio MCP server with 4 tools (`get_accessed_entities`, `get_entity_relationships`, `list_session_concepts`, `submit_links`), spawns `claude` CLI with `--max-turns 5`

### Stream Manager Integration
- `packages/api/src/services/stream-manager.ts` — Added `extractAccessedEntities()` to parse toolCallsData for MCP tool calls (`get_concept`, `get_chunk`, `get_related`, `get_resource_info/content`). `finalizeStream()` fire-and-forgets enrichment when 2+ distinct entities accessed

### Enrichment Queue
- `packages/api/src/lib/queue.ts` — Added `enrichmentQueue` (concurrency=1), `enqueueEnrichment()`, and `writeEnrichmentResults()` that resolves concept names, deduplicates against existing relationships, creates with `createdBy: "enricher"`, writes GraphLog

### GraphLog Model
- `prisma/schema.prisma` — New `GraphLog` model: sessionId, source, action, resourceId, conversationId, conceptsCreated/Updated, relationshipsCreated, durationMs, details (JSON). Indexed on sessionId, source, createdAt

### GraphLog Write Points
- `packages/api/src/services/graph-indexer.ts` — Writes entry after `writeResultToDb()` (source: "indexer")
- `packages/api/src/lib/queue.ts` — Writes entry after cross-linking (source: "cross-linker")
- `packages/api/src/services/amortiser.ts` — Writes entries in both `amortiseSearchResults()` and `amortiseRead()` (source: "amortiser"), with query/matchText in details JSON

### API + MCP
- `packages/api/src/routes/graph.ts` — `GET /sessions/:sessionId/graph-log` with `?source=` and `?limit=` params
- `packages/mcp/src/lib/api-client.ts` — `getGraphLog()` method
- `packages/mcp/src/tools/graph.ts` — `get_graph_log` tool for chat agent to view indexing history

## Verification

- `pnpm db:generate` + `pnpm db:push` — schema applied cleanly
- `pnpm build` — all 4 packages build with no type errors
- `pnpm lint:fix` — only pre-existing lint warnings remain (cli-chat.ts non-null assertion, mcp/index.ts template literal, ConversationItem.tsx semantic element)

## Decisions & Notes

- Enricher uses `createdBy: "enricher"` on relationships (distinct from "system" used by indexer/cross-linker and "amortised" used by amortiser)
- GraphLog writes are wrapped in try/catch and non-fatal — a logging failure never crashes the primary operation
- `linkedPairs` set is computed in `extractAccessedEntities` but not yet used to filter entities — kept for future use if we want to skip entities the agent already explicitly linked via `create_link`
- Enrichment runs on any stream with 2+ accessed entities; could add a minimum threshold or debounce if it fires too often
