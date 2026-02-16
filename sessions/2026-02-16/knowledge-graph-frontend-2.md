# Knowledge Graph Frontend — Full Feature Set

**Date:** 2026-02-16
**Duration:** ~30 minutes
**Scope:** Added 7 interactive features to the reagraph knowledge graph page

## Summary

Extended the basic reagraph visualization into a full interactive knowledge graph explorer. Added a left sidebar with filters/stats/pathfinding, a right detail panel for inspecting nodes and their connections, search with camera centering, confidence filtering, orphan detection, BFS pathfinding between concepts, and a layout switcher with 7 layout algorithms.

## Changes

### packages/web/src/pages/KnowledgeGraph.tsx (full rewrite)

**New features:**
1. **Node detail panel** — right sidebar on node click showing name, description, aliases, and all connections (clickable to navigate)
2. **Search + zoom** — header search bar with dropdown results, selects node and centers camera via `graphRef.centerGraph()`
3. **Node type filters** — checkboxes for concept/file/chunk/question with counts, hiding nodes also hides their edges
4. **Relationship type filters** — checkboxes for each relationship type (prerequisite, covers, etc.) with counts
5. **Confidence slider** — range input 0–1, filters out low-confidence edges. Header shows filtered/total counts
6. **Stats + orphan detection** — total nodes/edges, avg confidence, orphan count with highlight toggle
7. **Pathfinding** — two searchable `NodePicker` components for concept selection, BFS shortest path, result shown as clickable breadcrumbs with camera fit
8. **Layout switcher** — dropdown: Force Directed, Circular, Hierarchical, Tree TD/LR, Radial, No Overlap

**Architecture:**
- `buildGraphData()` now returns `FullGraphData` with `nodeTypes` and `relTypes` arrays, and stores `relationship`/`confidence` on edge `data`
- `findPath()` — BFS on adjacency list built from edges, returns node IDs + edge IDs
- `computeStats()` — computes nodesByType, edgesByType, avgConfidence, orphanIds
- `NodePicker` — reusable searchable dropdown for concept selection (used by pathfinder)
- Filtering uses `disabledNodeTypes`/`disabledRelTypes` Sets (disabled-set pattern: new types auto-enabled)
- `selections` prop merges selected node + path highlight + orphan highlight
- Full graph (unfiltered) used for stats, detail panel, pathfinding; filtered graph used for canvas rendering

### packages/api/src/middleware/cors.ts
- Fixed pre-existing TS error: `c.text("", 204)` → `c.body(null, 204)`

### packages/api/src/routes/graph.ts
- Added `GET /graph/sessions/:sessionId/full` endpoint (concepts + relationships in one request)

### packages/web/src/lib/api.ts
- Added `Relationship`, `SessionGraph` interfaces and `fetchSessionGraph()`

### packages/web/src/router.tsx
- Added `/session/:id/graph` route under fullscreen layout

### packages/web/src/pages/SessionDetail.tsx
- Added "View Knowledge Graph" link button

## Verification

- `tsc --noEmit` passes clean for both `packages/web` and `packages/api`
- `vite build` succeeds (1714 kB bundle)
- Fixed two TS errors: `n.label` possibly undefined in reagraph's `GraphNode` type — added nullish coalescing

## Decisions & Notes

- **reagraph over react-force-graph-2d**: Chose reagraph for first-class edge labels on canvas, built-in clustering, multiple layout algorithms, and pathfinding support. react-force-graph only shows edge labels on hover.
- **Single file**: All 7 features in one ~840 line file. Acceptable for now; could extract sidebar/detail panel if it grows further.
- **Disabled-set pattern**: Storing disabled types rather than enabled types means new relationship/node types from future indexing runs are automatically visible.
- **Pathfinding is client-side BFS**: Runs on the full graph edges. Fine for academic knowledge graphs (hundreds of nodes), would need server-side for larger graphs.
- **Bundle size**: 1.7 MB total. reagraph added ~90 deps. Should code-split with `React.lazy` if it becomes a problem.
- **Confirmed indexer changes are safe**: The frontend is decoupled from the indexer — it reads from Concept/Relationship tables via the `/full` API. Changing how the indexer extracts data won't break the frontend as long as the Prisma schema stays the same.
