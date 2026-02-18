# Indexer File-Based Logging

**Date:** 2026-02-18
**Duration:** ~20 minutes
**Scope:** Add persistent file-based logging for the entire indexer pipeline

## Summary

Added an `IndexerLogger` class that creates a timestamped directory per batch run under `data/indexer-logs/`, with a combined `batch.log`, per-phase log files, and full subprocess stdout/stderr capture in an `agents/` subdirectory. Threaded the logger through all 5 phases of the indexer pipeline. Everything still logs to console too.

## Changes

### New file
- `packages/api/src/lib/indexer-logger.ts` — `IndexerLogger` class implementing `Logger` interface. Creates dir structure, manages write streams, supports `startPhase(n)`/`endPhase(n)`, provides `getAgentLogPaths()` for agent subprocess capture. Falls back to console-only if dir creation fails.

### Agent spawners (identical pattern across all 4)
- `packages/api/src/services/extraction-agent.ts`
- `packages/api/src/services/cross-linker.ts`
- `packages/api/src/services/cleanup-agent.ts`
- `packages/api/src/services/metadata-agent.ts`

Each got: optional `indexerLog` param, `createWriteStream` for stdout/stderr piped from subprocess, full CLI args logged for reproducibility, full stderr/stdout logged on error (not truncated to 500 chars).

### Service layer (pass-through)
- `packages/api/src/services/graph-indexer.ts` — `indexResourceGraph()` and `extractWithRetries()` accept and pass `indexerLog`
- `packages/api/src/services/metadata-indexer.ts` — same pattern
- `packages/api/src/services/graph-cleanup.ts` — `runProgrammaticCleanup()` accepts `Logger` param for cleanup stats

### Orchestrator
- `packages/api/src/lib/queue.ts` — `runPhasedBatch()` creates `IndexerLogger`, logs batch config (resource list, phases, thoroughness), wraps each phase with `startPhase()`/`endPhase()`, passes logger to `runIndexJob()`, `runCrossLinking()`, `runGraphCleanup()`, `runMetadataExtraction()`. Logs per-resource timing, circuit breaker events, phase summaries, total batch duration. Closes logger in `finally`.

## Verification

- `pnpm build` — compiles with no errors
- `pnpm lint` — passes clean (after auto-fix of formatting)
- Test failures are pre-existing (schema migration issue with `indexErrorMessage` column)
- All new params are optional — standalone callers unaffected

## Decisions & Notes

- `IndexerLogger` lives in `packages/api`, not `shared` — it depends on `node:fs` and is indexer-specific
- Used `activeLog = indexerLog ?? log` pattern everywhere so existing code paths are unchanged when called without the logger
- Agent output streams to files in real-time via `createWriteStream` (survives crashes, no memory buffering)
- `graph-cleanup.ts` accepts `Logger` (interface) rather than `IndexerLogger` (concrete) since it doesn't need agent log paths
- Pre-existing TS diagnostic warnings about `phase3Status`/`phase4Status`/`phase5Status` in `getSessionBatchStatus` — these are Prisma type inference issues, not related to this work
- The `data/indexer-logs/` directory is not gitignored yet — may want to add it
