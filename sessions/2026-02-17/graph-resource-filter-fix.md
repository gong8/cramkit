# Graph Resource Filter Fix

**Date:** 2026-02-17
**Duration:** ~15 min
**Scope:** Fix knowledge graph resource toggle not filtering lecture note chunks

## Summary

Toggling lecture notes in the knowledge graph sidebar had no effect on the graph. The resource filter only hid `resource`-type nodes, but lecture notes' relationships were primarily `chunk → concept` (because the LLM includes `chunkTitle` for structured content). Chunk nodes had no `resourceId`, so the filter couldn't associate them with their parent resource.

## Changes

### packages/api (API)
- `src/routes/graph.ts` — `/sessions/:id/full` endpoint now fetches all chunks and returns a `chunkResourceMap` (chunk ID → resource ID) alongside concepts, relationships, and resources.

### packages/web (Frontend)
- `src/lib/api-types.ts` — Added `chunkResourceMap: Record<string, string>` to `SessionGraph` type.
- `src/components/graph/graph-utils.ts` — `buildGraphData()` accepts `chunkResourceMap`, attaches `resourceId` to chunk nodes, and uses parent resource's color for chunk node fill.
- `src/hooks/useGraphData.ts` — Simplified filter: any node with a `resourceId` in the disabled set is hidden (not just `type === "resource"` nodes). Passes `chunkResourceMap` to `buildGraphData()`.

## Verification

- `pnpm build` — clean build across all 4 packages
- `pnpm test -- --run tests/integration/graph-routes.test.ts` — all 12 tests pass

## Decisions & Notes

- The `chunkResourceMap` is built from a single query (`chunk.findMany` with `select: { id, resourceId }`). For very large sessions this could be many rows, but it's just two small string columns so should be fine.
- Chunk nodes now inherit their parent resource's color from `RESOURCE_TYPE_COLORS`, making the visual grouping clearer.
