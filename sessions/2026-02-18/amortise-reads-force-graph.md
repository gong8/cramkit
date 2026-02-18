# Amortise Reads & Force Graph Mode

**Date:** 2026-02-18
**Duration:** ~30 min
**Scope:** Knowledge graph amortisation on every read + flag to ban direct reads from MCP

## Summary

Added `amortiseRead()` to silently strengthen the knowledge graph whenever chunks or resources are read via the API. Also added a `--force-graph-reads` flag (`pnpm dev:force-graph`) that blocks direct read tools in the MCP server, forcing the agent to navigate through the knowledge graph instead. The initial env-var-based flag didn't survive turbo's process chain, so it was replaced with a file-based flag.

## Changes

### `packages/api/src/services/amortiser.ts`
- New `amortiseRead(sessionId, entities, matchText)` function
- Reversed matching: checks if concept names/aliases appear as substrings in matchText (vs search amortiser which checks query terms against concept names)
- Confidence 0.5, same dedup and cap (10) as existing `amortiseSearchResults`
- Skips concepts with names < 3 chars

### `packages/api/src/routes/chunks.ts`
- `GET /:id` now includes `sessionId` in resource select
- Fire-and-forget `amortiseRead()` with chunk title + keywords + resource name

### `packages/api/src/routes/resources.ts`
- `GET /:id` fires amortisation using all chunk titles/keywords (guarded on chunks.length > 0)
- `GET /:id/content` fetches chunks in parallel with content read, then fires amortisation

### `packages/mcp/src/index.ts`
- `forceGraphReads` flag checked from 3 sources: CLI arg, env var, file (`data/.force-graph-reads`)
- Blocked tools: `get_resource_content`, `get_chunk`, `get_resource_index`, `get_past_paper`
- Blocked tools get `[DISABLED]` description prefix and return `isError: true` with guidance
- Always logs flag status at startup with which source triggered it
- Health endpoint now reports `forceGraphReads` status

### `package.json` (root)
- `dev:force-graph` script: touches `data/.force-graph-reads` then runs turbo
- `dev` script: removes flag file then runs turbo

### `tests/unit/amortiser.test.ts`
- 9 new tests for `amortiseRead`: concept matching, alias matching, confidence/createdBy values, short name filtering, dedup, cap at 10, no-match/empty guards, error swallowing

## Verification

- `pnpm test` — 89/89 tests pass (17 in amortiser suite)
- `pnpm lint` — no issues in changed files
- Typecheck clean on MCP package
- Health endpoint verifiable: `curl localhost:3001/health` returns `forceGraphReads` status

## Decisions & Notes

- **File-based flag over env var**: `FORCE_GRAPH_READS=1` didn't propagate through `pnpm → turbo → bun --watch`. File at `data/.force-graph-reads` is bulletproof. Already gitignored via `data/`.
- **Kept env var + CLI arg**: Still checked as fallback (useful for stdio mode / Claude Desktop).
- **`search_notes` not blocked**: It already returns content + graph links, so it's the intended entry point when direct reads are disabled.
- **`get_resource_info` not blocked**: Returns metadata + chunk list, no raw text.
- **Amortise confidence 0.5 vs search's 0.6**: Read amortisation is weaker signal (reading != searching for), so lower confidence.
- **User feedback**: Agent still defaulted to direct reads even with strong system prompt instructions. The force-graph flag is an empirical test to see if blocking reads entirely degrades answer quality or forces better graph usage.
