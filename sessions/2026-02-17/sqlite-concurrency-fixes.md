# SQLite Concurrency Fixes

**Date:** 2026-02-17
**Duration:** ~20 min
**Scope:** Fix concurrent read/write issues when indexing and chatting simultaneously

## Summary

Identified and fixed SQLite concurrency problems that could cause blocked reads, inconsistent intermediate state, and write contention when the indexer and chat agent run simultaneously. Added WAL mode, busy timeout, atomic transactions, and reduced indexing queue concurrency.

## Changes

### packages/shared/src/db.ts
- Added `initDb()` function that sets `PRAGMA journal_mode=WAL` and `PRAGMA busy_timeout=5000`
- Uses `$queryRawUnsafe` (not `$executeRawUnsafe`) because PRAGMAs return results

### packages/shared/src/index.ts
- Exported `initDb`

### packages/api/src/index.ts
- Calls `await initDb()` at startup before serving requests

### packages/api/src/lib/queue.ts
- Reduced `indexingQueue` concurrency from 2 to 1 to prevent two graph indexers competing for the write lock

### packages/api/src/services/resource-processor.ts
- `createChunkRecords` now accepts a `Prisma.TransactionClient` parameter instead of calling `getDb()` internally
- All file I/O (markdown conversion, disk writes) happens before the transaction
- `chunk.deleteMany` + all `chunk.create` + `resource.update` wrapped in `db.$transaction()` (30s timeout)

### packages/api/src/services/graph-indexer.ts
- All DB writes (delete relationships, upsert concepts, create relationships, update resource) wrapped in `db.$transaction()` (30s timeout)
- Relationship creates batched into a single `createMany()` instead of individual `create()` in loops

### tests/unit/queue.test.ts
- Updated concurrency assertion from 2 to 1
- Fixed test isolation issues (leaked queue items between tests)

## Verification

- `pnpm build` passes all 4 packages
- `pnpm test` — 77/79 tests pass; 2 failures are pre-existing (llm-client max-tokens flag, graph-routes mock wiring)
- Queue test updated and passing with new concurrency behavior

## Decisions & Notes

- Kept two separate queues (processing + indexing) rather than merging into one — content processing is fast and shouldn't be blocked by slow graph indexing LLM calls. WAL + busy_timeout handles the rare overlap.
- 30s transaction timeout chosen to accommodate large resources with many chunks
- WAL mode is set per-connection at API startup. The MCP server (read-only) benefits automatically since WAL is a database-level setting persisted in the file.
- `$queryRawUnsafe` used instead of `$executeRawUnsafe` because Prisma/SQLite rejects execute calls that return results.
