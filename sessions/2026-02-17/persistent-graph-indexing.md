# Persistent, Resumable Graph Indexing with Error Logging

**Date:** 2026-02-17
**Duration:** ~20 minutes
**Scope:** Replace in-memory batch tracking with DB-backed IndexBatch/IndexJob tables for crash-resilient graph indexing

## Summary

Graph indexing batch state was tracked in an in-memory `Map`, so a dev server restart killed all pending jobs and lost all progress. Replaced this with SQLite-backed `IndexBatch` and `IndexJob` models. On startup, interrupted batches are automatically resumed. Errors are now stored per-job and surfaced in the UI with a "Retry Failed" button.

## Changes

### Schema (`prisma/schema.prisma`)
- Added `IndexBatch` model (status, total, completed, failed, timestamps)
- Added `IndexJob` model (status, sortOrder, attempts, errorMessage, errorType, durationMs)
- Relations: Session -> IndexBatch -> IndexJob, Resource -> IndexJob

### API — Graph Indexer (`packages/api/src/services/graph-indexer.ts`)
- Added `GraphIndexError` class with typed `errorType` (llm_error, parse_error, db_error, unknown)
- Changed `indexResourceGraph` to throw instead of silently returning on failures
- Wrapped `db.$transaction` in try/catch to rethrow as db_error

### API — Queue (`packages/api/src/lib/queue.ts`)
- Removed in-memory `SessionBatchState` / `sessionBatches` Map
- All batch/job state now lives in DB; p-queue remains as execution engine
- New functions: `runIndexJob()`, `resumeInterruptedBatches()`, `retryFailedJobs()`
- `enqueueSessionGraphIndexing`, `cancelSessionIndexing`, `getSessionBatchStatus` are now async

### API — Server Startup (`packages/api/src/index.ts`)
- Calls `resumeInterruptedBatches()` after `initDb()`

### API — Routes (`packages/api/src/routes/graph.ts`)
- All queue calls now awaited
- Added `POST /sessions/:sessionId/retry-failed` endpoint
- Batch status response now includes `batchFailed`, per-job `errorMessage`, `errorType`, `attempts`

### Web — Types (`packages/web/src/lib/api.ts`)
- `BatchResource` gains `"failed"` status, `errorMessage`, `errorType`, `attempts`
- `BatchStatus` gains `batchFailed`
- Added `retryFailedIndexing()` API function

### Web — UI (`packages/web/src/components/IndexTab.tsx`)
- Failed status icon (AlertTriangle) + inline error messages in batch list
- "Retry Failed (N)" button when batch has failures and not actively indexing
- Failure summary section shown after batch completes with failures
- Progress bar and ETA account for failed count

### Web — Session Page (`packages/web/src/pages/SessionDetail.tsx`)
- Added `handleRetryFailed` callback
- Polling `isDone` check accounts for `batchFailed`
- Mount restoration logic accounts for failures

### Tests
- `tests/fixtures/helpers.ts` — `cleanDb` includes `indexJob`/`indexBatch`
- `tests/unit/queue.test.ts` — `enqueueSessionGraphIndexing` test creates real DB records
- `tests/unit/graph-indexer.test.ts` — 3 tests updated to expect throws
- `tests/integration/graph-routes.test.ts` — Mocks updated for async queue functions

## Verification

- `pnpm db:generate && pnpm db:push` — schema applies cleanly to both main and test DBs
- `pnpm build` — all 4 packages compile
- `pnpm test` — 78/79 pass (1 pre-existing failure in llm-client unrelated to changes)

## Decisions & Notes

- Kept `p-queue` as execution engine for concurrency control; DB is source of truth for state
- `getSessionBatchStatus` prefers a running batch, falls back to most recent — ensures UI picks up resumed batches
- `retryFailedJobs` resets the batch back to "running" if it was completed/cancelled
- The `enqueueGraphIndexing` function (single resource, non-batch) still works without DB tracking — only session batches use the new tables
- Pre-existing test failure in `llm-client.test.ts > respects model option overrides` was not addressed (unrelated)
