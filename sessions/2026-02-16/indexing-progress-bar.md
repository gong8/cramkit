# Indexing Progress Bar, ETA, Cancel & Reindex

**Date:** 2026-02-16
**Duration:** ~15 minutes
**Scope:** Add progress bar, ETA, cancellation, reindex support, and indexing metrics to graph indexing

## Summary

Implemented a full progress tracking system for graph indexing across 8 files in 5 phases. The "Index All" flow now shows a visual progress bar with ETA, supports cancellation mid-batch, and offers "Reindex All" when all files are already indexed. Indexing duration and file size metrics are now stored for future ETA estimates.

## Changes

### Schema (`prisma/schema.prisma`)
- Added `fileSize Int?` and `graphIndexDurationMs Int?` to `File` model

### API — Metrics Storage
- `packages/api/src/routes/files.ts` — Store `fileSize: file.size` during upload
- `packages/api/src/services/graph-indexer.ts` — Measure and store `graphIndexDurationMs` on completion

### API — Queue Tracking (`packages/api/src/lib/queue.ts`)
- Added `SessionBatchState` in-memory map tracking fileIds, completedFileIds, currentFileId, startedAt, cancelled per session
- `enqueueSessionGraphIndexing` checks cancelled flag before running each task
- Added `cancelSessionIndexing()` and `getSessionBatchStatus()` exports

### API — Endpoints (`packages/api/src/routes/graph.ts`)
- `GET index-status` now returns `batch` object (batchTotal, batchCompleted, currentFileId, startedAt, cancelled) and `avgDurationMs`
- `POST cancel-indexing` — new endpoint to cancel a session's indexing batch
- `POST index-all` — accepts optional `{ reindex: true }` body to re-index already-indexed files

### Frontend — API Layer (`packages/web/src/lib/api.ts`)
- Updated `IndexStatus` and `FileItem` types with new fields
- Added `cancelIndexing()` and `reindexAllFiles()` functions

### Frontend — Session Detail (`packages/web/src/pages/SessionDetail.tsx`)
- Progress bar (colored div with percentage width, smooth transition)
- ETA text: historical avg → elapsed/completed ratio → "Estimating..."
- Cancel button (X icon) during indexing
- "Index All" when unindexed files exist, "Reindex All" when all are indexed

### Frontend — File List (`packages/web/src/components/FileList.tsx`)
- Per-file "Reindex" button next to "Indexed" badge
- Imports `FileItem` type from `@/lib/api` instead of local interface

## Verification

- `pnpm db:push` succeeded (schema migration applied)
- `pnpm build` succeeded across all 4 packages (shared, api, mcp, web)

## Decisions & Notes

- Cancel only skips pending tasks — in-flight LLM calls (up to 2 with concurrency 2) complete naturally
- Batch state is in-memory (lost on server restart, same as p-queue itself)
- ETA priority: historical `avgDurationMs` from DB → elapsed/completed ratio → "Estimating..."
- Per-file reindex reuses existing `indexFileGraph` which already cleans up old relationships before re-indexing
- `POST index-all` with `reindex: true` resets `isGraphIndexed` and `graphIndexDurationMs` before queuing
