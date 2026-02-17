# Create `/simplify-all` Slash Command

**Date:** 2026-02-17
**Duration:** ~15 minutes
**Scope:** Created a custom Claude Code slash command for massive parallel code simplification

## Summary

Created `.claude/commands/simplify-all.md` — a slash command that orchestrates a 21-agent parallel code-simplification sweep across the entire CramKit codebase (~65 source files, ~13,000 lines). The command was initially designed with 3 phases and 14 agents (peak parallelism 10), then revised to 2 phases and 22 agents (peak parallelism 21) at user request.

## Changes

### `.claude/commands/`

- **Created `simplify-all.md`** — defines a 2-phase orchestration:
  - **Phase 1:** 21 `code-simplifier:code-simplifier` agents launched simultaneously, each with non-overlapping file assignments:
    - 10 API agents (graph-indexer, graph-search+route, resource-processor+storage, parser+writer, chat-route, chat-services, session-export, session-import+route, resources+search, api-small-files)
    - 8 Web agents (Chat.tsx solo, KnowledgeGraph.tsx solo, Dashboard solo, SessionDetail solo, resource-components, tab-components, web-lib, web-small)
    - 3 MCP/Shared/Test agents (mcp, shared, tests)
  - **Phase 2:** 1 verifier agent runs lint, build, test and fixes breakage

## Verification

- Confirmed `.claude/commands/` directory existed and checked existing command format (`log-session.md`)
- Inventoried all 65 source files with line counts to ensure complete coverage and zero overlaps
- Verified every source file appears in exactly one agent's scope

## Decisions & Notes

- **Eliminated analysis + shared-utils phases** from original plan to maximize parallelism (was 3 phases → now 2 phases)
- **Each agent analyzes + simplifies inline** rather than waiting for a centralized analysis report
- **No shared utility creation phase** — agents create local helpers within their own scope to avoid cross-agent conflicts
- **Chat.tsx (1204 lines) and KnowledgeGraph.tsx (989 lines)** each get dedicated solo agents with specific decomposition instructions (extract hooks to `src/hooks/`, sub-components to `src/components/{chat,graph}/`)
- Uses `TeamCreate`/`TeamDelete` for coordination, `mode: bypassPermissions` for all agents
- The command has not been test-run yet — first execution will be the real test
