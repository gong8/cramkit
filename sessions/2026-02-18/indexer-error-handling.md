# Indexer Error Handling, State Management & Display

**Date:** 2026-02-18
**Duration:** ~20 minutes
**Scope:** Fix misleading indexer UI by persisting phase status, surfacing errors, and keeping completion state visible

## Summary

The indexer UI was misleading: when indexing failed (partially or fully), the progress section vanished and looked identical to success. Errors were swallowed at multiple levels, phase 5 was invisible to the frontend done-check, and content processing failures left resources stuck at "Processing" forever. This session implemented a 9-step plan across schema, backend, and frontend to fix all of these issues.

## Changes

### Schema (`prisma/schema.prisma`)
- Added `indexErrorMessage` field to `Resource` model (set on processResource failure, cleared on success)
- Added `phase3Status`, `phase4Status`, `phase5Status` JSON fields to `IndexBatch` model (persist terminal phase state to DB)

### Backend: `packages/api/src/services/resource-processor.ts`
- `processResource()` catch block now writes error message to `resource.indexErrorMessage`
- `executeChunkPlan()` success path clears `indexErrorMessage: null` alongside `isIndexed: true`

### Backend: `packages/api/src/lib/queue.ts`
- Added `persistPhaseStatus()` helper to write phase JSON to DB
- All terminal state transitions in `runCrossLinking`, `runGraphCleanup`, `runMetadataExtraction` now persist to DB
- `cancelSessionIndexing` persists skipped status for incomplete phases before clearing in-memory maps
- `getSessionBatchStatus` fallback logic now checks DB `phase*Status` fields when in-memory maps are empty (fixes post-restart state)

### Frontend types: `packages/web/src/lib/api-types.ts`
- Added `indexErrorMessage: string | null` to `Resource` interface
- Added `batchId: string` to `BatchStatus` interface

### Frontend hook: `packages/web/src/components/session/useIndexing.ts`
- Added `lastCompletedBatch` state — preserves final batch result after polling stops
- Added `actionError` state — surfaces API call failures to user
- Fixed phase 5 missing from done-check (was causing premature completion detection)
- Mount effect loads completed batches with failures so they're visible on page refresh

### Frontend: `packages/web/src/pages/SessionDetail.tsx`
- Wired `lastCompletedBatch`, `dismissLastBatch`, `actionError`, `clearActionError` to `IndexTab`
- `MaterialsTab` falls back to `lastCompletedBatch?.resources` for batch status badges after completion

### Frontend: `packages/web/src/components/IndexTab.tsx`
- New `CompletionBanner` component: green (success), amber (partial failure), red (total failure), muted (cancelled) with elapsed time and dismiss button
- `BatchFailuresSection` and Retry Failed button now source from `lastCompletedBatch` instead of `indexStatus.batch`
- Added red dismissible action error banner at top

### Frontend: `packages/web/src/components/IndexTabParts.tsx`
- ETA fix: passes `null` for `avgDurationMs` so each phase uses within-phase elapsed time instead of cross-phase session average

### Frontend: `packages/web/src/components/ResourceList.tsx`
- Shows "Failed" (red, with error tooltip) for resources with `indexErrorMessage` instead of perpetual "Processing"

## Verification

- `pnpm db:generate && pnpm db:push` — schema applied cleanly
- `pnpm build` — no type errors across all 4 packages
- `pnpm lint` — passes Biome checks (auto-fixed 2 formatting issues)

## Decisions & Notes

- Phase status is stored as JSON strings in SQLite since the schema is simple and doesn't warrant separate tables
- The `persistPhaseStatus` helper silently logs failures rather than throwing — phase persistence is best-effort, not critical path
- `lastCompletedBatch` uses the full `BatchStatus` type rather than a trimmed version, keeping it simple
- The `CompletionBanner` elapsed time is computed from `Date.now() - startedAt` which is approximate after refresh (shows total time since batch started, not just active time)
- No tests were added — this was a UI/UX fix with manual verification path
