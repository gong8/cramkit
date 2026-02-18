# Fix Question Tree Nesting

**Date:** 2026-02-18
**Duration:** ~10 minutes
**Scope:** Fix 3-level question hierarchy (Q1 > 1a > 1a(i)) being truncated to 2 levels

## Summary

The question tree builder and MCP tool only rendered 2 levels of nesting, silently dropping Roman numeral sub-parts like Q1a(i). Fixed the tree builder to recurse to arbitrary depth, fixed the MCP summary layer to match, and improved the metadata agent prompt to explicitly instruct sub-part extraction.

## Changes

### packages/api/src/routes/questions.ts
- Replaced flat 2-level tree builder with recursive `buildSubtree` function that walks `byParent` map to arbitrary depth

### packages/mcp/src/tools/papers.ts
- Replaced inline 1-level parts mapping with recursive `summarize` function so MCP responses include all nesting levels

### packages/api/src/services/metadata-agent.ts
- Added explicit 3-level `parentNumber` examples to PAST_PAPER prompt (e.g. `parentNumber="1a"` for `"1a(i)"`)
- Added CRITICAL directive requiring each sub-part (i), (ii), etc. to be extracted as separate question entries with verbatim content

## Verification

- `pnpm build` passes cleanly
- `pnpm test` failures are pre-existing (unrelated schema migration issue with `indexErrorMessage` column)
- No existing question-specific tests in the test suite

## Decisions & Notes

- Affected resources need metadata re-indexing to benefit from the improved prompt — the tree builder fix applies immediately but won't help if sub-parts were never extracted in the first place
- The specific resource mentioned in the bug report: `cmlpvayst00078ubpm9e8j37d` (21/22 Midterm)
- Should audit other papers for the same issue — any question with 3+ levels of nesting was affected
