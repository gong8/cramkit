# Knowledge Graph Indexer Improvements

**Date:** 2026-02-17
**Duration:** ~25 minutes
**Scope:** 10 improvements to graph indexing, search, and amortisation across 5 files

## Summary

Reviewed the knowledge graph indexer system end-to-end, identified 13 potential improvements, self-critiqued each, then implemented the 10 that passed the value/effort filter. The main themes were fuzzy matching (chunk titles, concept search, content search), batch performance (amortiser), and data integrity (relationship dedup, orphan cleanup).

## Changes

### packages/api/src/services/graph-indexer.ts
- Added Dice coefficient bigram similarity function and `fuzzyMatchTitle` for chunk title lookups (was exact-match only, now falls back to fuzzy with 0.6 threshold)
- Replaced naive `toTitleCase` with acronym-aware version that preserves all-caps words (ODE, PDE) and internal capitals (pH, mRNA)
- Added truncation indicator when content exceeds 30k chars so the LLM knows it's working with partial content
- Replaced greedy question-chunk resolution (`includes` first match) with tiered matching: exact title > starts-with > substring
- Added relationship deduplication before `createMany` to prevent duplicate edges from LLM output

### packages/api/src/services/graph-search.ts
- Replaced Prisma `contains` concept matching with token-based approach: fetches all session concepts, filters in JS where every query term appears in name/description/aliases
- Added `nodeType` and `keywords` fields to `GraphSearchResult` interface and return mapping

### packages/api/src/routes/search.ts
- Replaced single-string `contains` content search with multi-term `AND` across query tokens so "wave equation solution" matches regardless of word order
- Graph-only results now use actual `nodeType` and `keywords` from chunks instead of hardcoded `"section"` and `null`

### packages/api/src/services/amortiser.ts
- Complete rewrite: replaced N+1 sequential queries (up to 20 DB round-trips) with 3 batch queries (fetch concepts, fetch existing rels + chunk titles, createMany)
- Added token-based concept matching consistent with graph-search
- Added `sourceLabel` (chunk title) to amortised relationships (was previously null)

### packages/api/src/routes/resources.ts
- Added `relationship.deleteMany` before resource deletion (DELETE resource route) to clean up orphan relationships
- Added same cleanup before resource deletion triggered by last-file removal (DELETE file route)

## Verification

- `pnpm test`: 77 passed, 2 failed (both pre-existing: `graph-routes.test.ts` asserts wrong function name, `llm-client.test.ts` unrelated CLI args test)
- `npx biome check --fix --unsafe` on changed files: 2 remaining warnings are pre-existing `noNonNullAssertion` in `resources.ts`, not from our changes

## Decisions & Notes

- **Token search in JS vs SQL**: Chose to fetch all session concepts and filter in JS for the token-based matching. This is fine for expected scale (<1000 concepts per session) but wouldn't scale to millions. Prisma doesn't support token-level AND with `contains`.
- **Dice coefficient threshold at 0.6**: Conservative enough to avoid false positives between similarly-named sections. The haystack is small (single resource's chunks) so the O(n) scan is cheap.
- **Skipped improvements**: Confidence-weighted scoring (#5, low impact), concept merge endpoint (#10, low priority). Both are nice-to-haves for later.
- **Pre-existing test bug**: `graph-routes.test.ts:162` asserts `enqueueGraphIndexing` was called but the route calls `enqueueSessionGraphIndexing`. Should be fixed separately.
- **`as any` cast**: The deduplication `filter()` widens the Prisma type union, requiring an `as any` on the `createMany` call. Added a biome-ignore comment. Not ideal but the alternative is verbose type gymnastics.
