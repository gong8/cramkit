# Kill Spawned Processes on Indexing Cancellation

**Date:** 2026-02-18
**Duration:** ~10 minutes
**Scope:** Thread AbortSignal through indexing pipeline so cancellation kills running `claude` CLI processes

## Summary

When a user cancelled indexing, the DB flag was set but any already-running `claude` CLI process (spawned by extraction or cross-linking agents) continued to completion, wasting compute and potentially writing stale results. This change threads `AbortSignal` through the entire call chain so cancellation sends SIGTERM to child processes immediately.

## Changes

### packages/api/src/services/errors.ts (NEW)
- `CancellationError` class shared across queue, graph-indexer, extraction-agent, cross-linker

### packages/api/src/services/extraction-agent.ts
- `runExtractionAgent` accepts optional `signal?: AbortSignal`
- Checks `signal.aborted` before spawn, registers abort listener that sends SIGTERM, rejects with `CancellationError` on abort, cleans up listener in close/error handlers

### packages/api/src/services/cross-linker.ts
- `runCrossLinkingAgent` accepts optional `signal?: AbortSignal` with same pattern as extraction-agent

### packages/api/src/services/graph-indexer.ts
- `extractWithRetries` accepts signal, checks abort before each attempt, re-throws `CancellationError` without retrying
- `indexResourceGraph` accepts signal, passes through, checks abort before `writeResultToDb` to prevent stale writes

### packages/api/src/lib/queue.ts
- `batchAbortControllers` map tracks `AbortController` per active batch
- `runPhasedBatch` creates controller, passes signal to all phases, uses PQueue's `{ signal }` option for auto-rejecting pending Phase 2 tasks, cleans up in `finally`
- `runIndexJob` marks cancelled jobs as `"cancelled"` not `"failed"`
- `runCrossLinking` sets cross-link status to `"skipped"` on cancellation
- `cancelSessionIndexing` calls `controller.abort()` after DB updates

## Verification

- `pnpm build` passes with no type errors
- `pnpm lint` shows only pre-existing warnings (none in modified files)

## Decisions & Notes

- Used `DOMException` name check (`error.name === "AbortError"`) to catch PQueue's abort errors in Phase 2 `onIdle()` -- this is the standard pattern PQueue uses
- Signal is optional (`signal?: AbortSignal`) everywhere so the non-batch `enqueueGraphIndexing` path still works without changes
- SIGTERM (not SIGKILL) is used so the `claude` CLI can clean up gracefully
- The `finally` block in extraction-agent/cross-linker still runs (temp dir cleanup) regardless of abort
