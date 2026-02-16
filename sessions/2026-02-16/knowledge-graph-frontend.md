# Knowledge Graph Frontend Visualization

**Date:** 2026-02-16
**Duration:** ~20 minutes
**Scope:** Added reagraph-based knowledge graph visualization page to the web frontend

## Summary

Researched and compared graph visualization libraries (react-force-graph-2d, reagraph, cytoscape.js) for rendering the knowledge graph. Chose reagraph for its first-class edge labels, built-in clustering, and multiple layout algorithms — features that genuinely fit knowledge graph use cases better than simpler alternatives. Implemented a full-screen graph page with color-coded nodes/edges.

## Changes

### packages/api/src/routes/graph.ts
- Added `GET /graph/sessions/:sessionId/full` endpoint returning all concepts + relationships for a session in one request

### packages/api/src/middleware/cors.ts
- Fixed pre-existing TS error: `c.text("", 204)` → `c.body(null, 204)` (Hono doesn't accept 204 as a `ContentfulStatusCode`)

### packages/web/src/lib/api.ts
- Added `Relationship`, `SessionGraph` interfaces
- Added `fetchSessionGraph()` function

### packages/web/src/pages/KnowledgeGraph.tsx (new)
- Full-screen reagraph `GraphCanvas` with force-directed 2D layout
- Nodes from concepts (purple) + files (blue) + chunks (green) + questions (amber)
- Edges color-coded by relationship type (prerequisite=red, covers=blue, etc.)
- Edge thickness scaled by confidence score
- Labels on all nodes and edges
- Header with back link, session name, node/edge count
- Legend bar at bottom

### packages/web/src/pages/SessionDetail.tsx
- Added "View Knowledge Graph" link button with `Network` icon

### packages/web/src/router.tsx
- Added `/session/:id/graph` route under a separate fullscreen layout (no max-width constraint)

## Verification

- `tsc --noEmit` passes clean for both `packages/web` and `packages/api`
- `vite build` succeeds (1695 kB bundle — chunk size warning, but fine for dev)

## Decisions & Notes

- **reagraph over react-force-graph-2d**: Edge labels render natively on edges in reagraph vs hover-only tooltips in react-force-graph. Clustering by node type and hierarchical layouts are built-in. Slightly heavier (WebGL) but worth it for a knowledge graph.
- **Fullscreen layout**: Graph page uses its own layout without the `max-w-5xl` constraint so the canvas gets the full viewport.
- **Node creation from relationships**: Non-concept nodes (files, chunks, questions) are dynamically created from relationship source/target references, since the `/full` endpoint only returns concepts explicitly. Labels fall back to `sourceLabel`/`targetLabel` or truncated IDs.
- **Bundle size**: reagraph added ~90 deps and pushed the bundle to 1.7 MB. Worth revisiting with code-splitting (`React.lazy`) if it becomes an issue.
- **Shoddy as requested**: No click-to-inspect panel, no search, no filtering. Just the raw graph. Good enough to verify the indexer works.
