# Graph Indexer Thoroughness Setting

**Date:** 2026-02-18
**Duration:** ~30 minutes
**Scope:** Add configurable thoroughness (quick/standard/thorough) to knowledge graph indexing

## Summary

Added a `thoroughness` setting that controls how deeply the graph indexer extracts concepts and relationships. Three levels — quick, standard, thorough — adjust content limits, chunk preview length, prompt selectivity, and whether multi-pass extraction is used. Also removed per-resource index/reindex buttons from the Materials tab, consolidating all indexing actions to the Index tab.

## Changes

### Schema (`prisma/schema.prisma`)
- Added `graphThoroughness` (default "standard") to `Session` model
- Added `thoroughness` (default "standard") to `IndexJob` model

### Shared (`packages/shared/src/schemas.ts`)
- Added `GraphThoroughnessEnum` Zod enum
- Added `graphThoroughness` to session create/update schemas
- Added `thoroughness` to `indexResourceRequestSchema`
- Added new `indexAllRequestSchema` with `reindex?` and `thoroughness?`

### API — Graph Indexer (`packages/api/src/services/graph-indexer.ts`)
- Added `Thoroughness` type, `ThoroughnessConfig` interface, `THOROUGHNESS_CONFIGS` lookup table
- Parameterized `buildStructuredContent()` with `previewLimit` (null = full content)
- Parameterized `buildContentString()` with config's `contentLimit`
- Parameterized `buildPrompt()` with `promptStyle` — swaps rules per level, adds cross-linking for thorough
- Added `splitIntoSections()` — groups by root chunks (hierarchical) or batches of 6 (flat)
- Added `mergeExtractionResults()` — deduplicates concepts and relationships across passes
- Extracted `writeResultToDb()` helper (shared by single/multi-pass)
- Added `indexResourceMultiPass()` — per-section LLM calls with cumulative concept context
- `indexResourceGraph()` now accepts optional `thoroughness`, dispatches accordingly

### API — Queue (`packages/api/src/lib/queue.ts`)
- `enqueueGraphIndexing()`, `enqueueSessionGraphIndexing()`, `runIndexJob()` — all forward thoroughness

### API — Routes (`packages/api/src/routes/graph.ts`)
- `POST /index-resource` and `POST /index-all` — resolve thoroughness from body → session default → "standard"

### Web — Types & API (`packages/web/src/lib/`)
- Added `GraphThoroughness` type and `graphThoroughness` to `Session` interface
- `indexAllResources()` and `reindexAllResources()` accept/forward thoroughness

### Web — UI
- `IndexTab.tsx` — added `ThoroughnessSelector` (3-option segmented control with descriptions)
- `useIndexing.ts` — `handleIndexAll`/`handleReindexAll` accept thoroughness param
- `ResourceList.tsx` — removed per-resource Index/Reindex buttons, replaced with read-only "Indexed" badge
- `MaterialsTab.tsx` — removed `onIndexResource` prop
- `SessionDetail.tsx` — removed `handleIndexResource`, passes `defaultThoroughness` to IndexTab

## Verification

- `pnpm db:generate && pnpm db:push` — schema applied cleanly
- `pnpm build` — no type errors across all 4 packages
- `pnpm lint` — no new Biome warnings (only 2 pre-existing in cli-chat.ts and ConversationItem.tsx)

## Decisions & Notes

- Thoroughness is resolved at request time: body param → session default → "standard". This means the session-level default acts as a preference, not a lock.
- Multi-pass falls back to single-pass if only 1 section exists (avoids unnecessary overhead).
- Flat resources batch 6 chunks per pass; hierarchical resources split by depth-0 sections.
- The `indexResource()` API function in `api.ts` is still exported but no longer called from the UI — kept for potential MCP/programmatic use.
- Per-resource index buttons were removed from the Materials tab per user request. All indexing is now done from the Index tab.
