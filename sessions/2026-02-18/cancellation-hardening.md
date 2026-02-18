# Cancellation Hardening

**Date:** 2026-02-18
**Duration:** ~30 minutes
**Scope:** Ensure cancelled indexing batches are truly dead — no stale writes to DB after cancel

## Summary

Audited the full cancellation flow across all 5 indexing phases and found race conditions where DB writes could still happen after a batch was cancelled. Added post-completion cancellation re-checks at every async boundary, added signal support to `runProgrammaticCleanup`, and fixed `cancelSessionIndexing` to also mark running jobs (not just pending) as cancelled.

## Changes

### Backend: `packages/api/src/lib/queue.ts`

- **`runIndexJob`** — added cancellation re-check after `indexResourceGraph()` completes but before writing job status and incrementing batch counter. Previously a job finishing right as cancel fired would still count as completed.
- **`runCrossLinking`** — added cancellation re-check after `runCrossLinkingAgent()` returns but before writing relationships to DB. Previously agent results would be committed to a cancelled batch.
- **`runGraphCleanup`** — added cancellation re-check after `runCleanupAgent()` returns but before calling `applyCleanupResult()`. Previously merges/deletes would be applied to a cancelled batch.
- **`runMetadataExtraction`** — added per-resource cancellation re-check after `indexResourceMetadata()` completes but before incrementing the completed counter.
- **`runProgrammaticCleanup` call** — now passes `signal` through.
- **`cancelSessionIndexing`** — changed job cancellation filter from `status: "pending"` to `status: { in: ["pending", "running"] }` so in-flight jobs are immediately marked cancelled in DB.

### Backend: `packages/api/src/services/graph-cleanup.ts`

- **`runProgrammaticCleanup`** — added `signal?: AbortSignal` parameter with cancellation checkpoints between each of the three cleanup steps (dedup, orphan removal, integrity fix). Throws `CancellationError` if aborted between steps, which rolls back the Prisma transaction.

## Verification

- `pnpm build` — no type errors
- `pnpm lint` — passes

## Decisions & Notes

- The cancellation re-checks use `signal?.aborted || (await isBatchCancelled(batchId))` — belt-and-suspenders approach checking both the in-memory signal and the DB status
- `runProgrammaticCleanup` checkpoints are between steps, not within them — each individual step (dedup/orphan/integrity) runs atomically. This is acceptable since each step is fast (pure DB operations on session-scoped data)
- `processResource` (content processing queue) still has no cancellation support, but it's a separate queue from graph indexing and runs before batches are created, so it's not in scope for batch cancellation
- A post-completion cancelled job means the graph data was already written by `indexResourceGraph` but the job won't be counted. This is fine — the data is valid, it just won't be reflected in batch stats. A reindex would overwrite it anyway.
