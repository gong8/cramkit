Run a massive parallel code-simplification sweep across the entire CramKit codebase.

Use `TeamCreate` to create a team named `simplify-sweep`, then orchestrate 2 phases using `Task` with `subagent_type: code-simplifier:code-simplifier` for all agents. Each agent gets `team_name: simplify-sweep`. Use `mode: bypassPermissions` for all agents.

---

## Rules for ALL agents

Embed these rules in every agent prompt:

- Do NOT change any functionality — simplify, abstract, and clean up only
- Follow CramKit code style: Biome formatter, tabs for indentation, double quotes, semicolons, 100-char line width
- Use `.js` extensions in all relative imports (ESM)
- Do NOT add new npm dependencies
- Keep all existing exports intact (other files depend on them)
- Do NOT add comments, docstrings, or type annotations to code you didn't change
- Do NOT create README or documentation files
- Import shared utilities from `@cramkit/shared`
- When extracting helpers, colocate them in the same file or an adjacent local file — do NOT modify files outside your assigned scope
- You may create NEW files (sub-components, hooks, local utils) within your package scope but NEVER edit files assigned to other agents

---

## Phase 1: EXECUTION (21 agents in parallel)

Launch ALL 21 agents simultaneously in a single message with 21 Task tool calls. Every source file in the codebase is assigned to exactly one agent — zero overlaps. Each agent reads, analyzes, and simplifies its own files independently.

---

### API Agents (10 agents)

### Agent 1: `exec-graph-indexer`

**Prompt:**
> Simplify `packages/api/src/services/graph-indexer.ts` (467 lines).
>
> This is the knowledge graph indexing service. Read it, identify overly complex control flow, large functions, duplicated patterns, and dead code. Decompose large functions, flatten nested logic, extract local helpers. You may create helper files adjacent in `packages/api/src/services/` if needed.
>
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 2: `exec-graph-search-route`

**Prompt:**
> Simplify the following graph query files:
> - `packages/api/src/services/graph-search.ts` (147 lines)
> - `packages/api/src/routes/graph.ts` (256 lines)
>
> These are tightly coupled — the route calls the search service. Simplify both, reduce duplication between them, flatten complex control flow, extract shared patterns.
>
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 3: `exec-resource-processor`

**Prompt:**
> Simplify the following resource processing files:
> - `packages/api/src/services/resource-processor.ts` (351 lines)
> - `packages/api/src/services/storage.ts` (104 lines)
>
> The processor uses storage. Simplify both, decompose large functions, reduce duplication, flatten nested logic.
>
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 4: `exec-parser-writer`

**Prompt:**
> Simplify the following parsing/writing files:
> - `packages/api/src/services/markdown-parser.ts` (286 lines)
> - `packages/api/src/services/tree-writer.ts` (133 lines)
>
> Parser produces structured data, tree-writer consumes it. Simplify both, decompose large functions, flatten complex control flow, extract local helpers.
>
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 5: `exec-chat-route`

**Prompt:**
> Simplify `packages/api/src/routes/chat.ts` (462 lines).
>
> This is the chat API route handler. It's one of the largest route files. Read it, decompose large handler functions, extract middleware or helper functions, flatten nested callbacks/promises, simplify error handling patterns.
>
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 6: `exec-chat-services`

**Prompt:**
> Simplify the following chat service files:
> - `packages/api/src/services/cli-chat.ts` (401 lines)
> - `packages/api/src/services/stream-manager.ts` (287 lines)
>
> These handle CLI chat and streaming. Simplify both, decompose large functions, reduce duplication between them, flatten nested async logic.
>
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 7: `exec-session-export`

**Prompt:**
> Simplify `packages/api/src/services/session-export.ts` (337 lines).
>
> This handles exporting sessions. Decompose large functions, flatten control flow, extract local helpers, simplify data transformation logic.
>
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 8: `exec-session-import-route`

**Prompt:**
> Simplify the following session import files:
> - `packages/api/src/services/session-import.ts` (441 lines)
> - `packages/api/src/routes/sessions.ts` (188 lines)
>
> The route calls the import service. Simplify both, decompose large functions, reduce duplication, flatten nested logic.
>
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 9: `exec-resources-search`

**Prompt:**
> Simplify the following route files:
> - `packages/api/src/routes/resources.ts` (485 lines — the largest route file)
> - `packages/api/src/routes/search.ts` (196 lines)
>
> These are the two biggest remaining route files. Decompose large handlers, extract shared route patterns, simplify query building logic, flatten nested error handling.
>
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 10: `exec-api-small`

**Prompt:**
> Simplify the following smaller API files:
> - `packages/api/src/services/amortiser.ts` (96 lines)
> - `packages/api/src/services/llm-client.ts` (124 lines)
> - `packages/api/src/lib/queue.ts` (75 lines)
> - `packages/api/src/index.ts` (37 lines)
> - `packages/api/src/middleware/cors.ts` (19 lines)
> - `packages/api/src/routes/chunks.ts` (33 lines)
> - `packages/api/src/routes/relationships.ts` (48 lines)
>
> These are all under 125 lines each. Look for: unnecessary complexity, dead code, verbose patterns that could be tightened, inconsistent error handling. Simplify what you can.
>
> Do NOT change functionality. Do NOT modify any other existing files.

---

### Web Agents (8 agents)

### Agent 11: `exec-chat-page`

**Prompt:**
> Decompose and simplify `packages/web/src/pages/Chat.tsx` (1204 lines — the LARGEST file in the codebase).
>
> This needs aggressive decomposition:
> 1. Extract custom hooks for state logic (e.g., `useChatMessages`, `useChatInput`, `useChatScroll`) into `packages/web/src/hooks/`
> 2. Extract sub-components (message list, input area, sidebar, etc.) into `packages/web/src/components/chat/`
> 3. Move complex inline logic into named functions
> 4. Flatten deeply nested JSX
> 5. The main Chat.tsx should become a thin orchestrator that composes hooks + sub-components
>
> You may create new files under `packages/web/src/hooks/` and `packages/web/src/components/chat/`.
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 12: `exec-knowledge-graph`

**Prompt:**
> Decompose and simplify `packages/web/src/pages/KnowledgeGraph.tsx` (989 lines — the SECOND largest file).
>
> This needs aggressive decomposition:
> 1. Extract custom hooks for graph state/layout (e.g., `useGraphData`, `useGraphLayout`, `useGraphInteraction`) into `packages/web/src/hooks/`
> 2. Extract sub-components (graph canvas, node details panel, controls, legend, etc.) into `packages/web/src/components/graph/`
> 3. Move complex inline logic (layout calculations, force simulation config) into named functions
> 4. Flatten deeply nested JSX
> 5. The main KnowledgeGraph.tsx should become a thin orchestrator
>
> You may create new files under `packages/web/src/hooks/` and `packages/web/src/components/graph/`.
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 13: `exec-dashboard`

**Prompt:**
> Simplify `packages/web/src/pages/Dashboard.tsx` (351 lines).
>
> Decompose large render sections into sub-components, extract repeated patterns, simplify state management. You may create new component files under `packages/web/src/components/` if extracting sub-components.
>
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 14: `exec-session-detail`

**Prompt:**
> Simplify `packages/web/src/pages/SessionDetail.tsx` (406 lines).
>
> Decompose large render sections into sub-components, extract repeated patterns, simplify state management. You may create new component files under `packages/web/src/components/` if extracting sub-components.
>
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 15: `exec-resource-components`

**Prompt:**
> Simplify the following resource-related component files:
> - `packages/web/src/components/ResourceList.tsx` (337 lines)
> - `packages/web/src/components/ResourceUpload.tsx` (389 lines)
>
> Decompose large components, extract shared patterns between them, simplify state logic, flatten nested JSX. You may create new component files under `packages/web/src/components/` if extracting sub-components.
>
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 16: `exec-tab-components`

**Prompt:**
> Simplify the following tab/layout component files:
> - `packages/web/src/components/IndexTab.tsx` (299 lines)
> - `packages/web/src/components/MaterialsTab.tsx` (41 lines)
> - `packages/web/src/components/Layout.tsx` (18 lines)
>
> Decompose large components, extract shared patterns, simplify render logic. You may create new component files under `packages/web/src/components/` if extracting sub-components.
>
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 17: `exec-web-lib`

**Prompt:**
> Simplify the following web library files:
> - `packages/web/src/lib/api.ts` (435 lines)
> - `packages/web/src/lib/chat-adapter.ts` (352 lines)
> - `packages/web/src/lib/logger.ts` (26 lines)
> - `packages/web/src/lib/utils.ts` (6 lines)
>
> Focus on api.ts (435 lines) and chat-adapter.ts (352 lines) — decompose large functions, extract shared request/response patterns, simplify error handling, reduce duplication between API call functions.
>
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 18: `exec-web-small`

**Prompt:**
> Simplify the following smaller web files:
> - `packages/web/src/pages/NewSession.tsx` (93 lines)
> - `packages/web/src/router.tsx` (33 lines)
> - `packages/web/src/main.tsx` (17 lines)
>
> These are small but check for: unnecessary complexity, dead code, verbose patterns. Simplify what you can.
>
> Do NOT change functionality. Do NOT modify any other existing files.

---

### MCP, Shared, and Test Agents (3 agents)

### Agent 19: `exec-mcp`

**Prompt:**
> Simplify all MCP package files:
> - `packages/mcp/src/index.ts` (100 lines)
> - `packages/mcp/src/lib/api-client.ts` (75 lines)
> - `packages/mcp/src/tools/content.ts` (154 lines)
> - `packages/mcp/src/tools/graph.ts` (104 lines)
> - `packages/mcp/src/tools/papers.ts` (91 lines)
> - `packages/mcp/src/tools/sessions.ts` (49 lines)
>
> Look for: duplicated tool registration patterns, shared request logic that could be extracted, verbose error handling. Simplify and deduplicate.
>
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 20: `exec-shared`

**Prompt:**
> Simplify all shared package files:
> - `packages/shared/src/constants.ts` (24 lines)
> - `packages/shared/src/db.ts` (32 lines)
> - `packages/shared/src/index.ts` (6 lines)
> - `packages/shared/src/logger.ts` (26 lines)
> - `packages/shared/src/schemas.ts` (184 lines)
> - `packages/shared/src/types.ts` (67 lines)
>
> Focus on schemas.ts (184 lines) — look for duplicated Zod patterns, schemas that could be composed from base schemas, dead exports. Simplify types.ts if there's redundancy with schemas.
>
> IMPORTANT: This is the shared package — all other packages depend on it. Be extra careful to keep all existing exports intact and not change any type signatures.
>
> Do NOT change functionality. Do NOT modify any other existing files.

### Agent 21: `exec-tests`

**Prompt:**
> Simplify all test files:
>
> **Fixtures:**
> - `tests/setup.ts` (6 lines)
> - `tests/fixtures/helpers.ts` (78 lines)
> - `tests/fixtures/llm-responses.ts` (93 lines)
> - `tests/fixtures/pde-session.ts` (25 lines)
>
> **Unit tests:**
> - `tests/unit/amortiser.test.ts` (183 lines)
> - `tests/unit/graph-indexer.test.ts` (322 lines)
> - `tests/unit/graph-search.test.ts` (246 lines)
> - `tests/unit/llm-client.test.ts` (162 lines)
> - `tests/unit/markdown-parser.test.ts` (122 lines)
> - `tests/unit/queue.test.ts` (125 lines)
> - `tests/unit/schemas.test.ts` (46 lines)
>
> **Integration tests:**
> - `tests/integration/graph-routes.test.ts` (244 lines)
> - `tests/integration/mcp-tools.test.ts` (97 lines)
> - `tests/integration/search-routes.test.ts` (243 lines)
>
> **E2E tests:**
> - `tests/e2e/full-indexing-flow.test.ts` (180 lines)
>
> Focus on: consolidating duplicated setup/teardown into shared fixtures, extracting repeated assertion patterns into helpers in `tests/fixtures/`, reducing boilerplate mock setup, simplifying verbose test arrangements.
>
> Do NOT change what the tests are testing. Do NOT modify any source files outside `tests/`.

---

**Wait for ALL 21 execution agents to complete before proceeding to Phase 2.**

---

## Phase 2: VERIFICATION (1 agent, sequential)

### Agent: `verifier`

**Prompt:**
> You are the final verification agent for the CramKit simplification sweep. 21 agents just edited every source file in the codebase in parallel. Your job is to make it all compile and pass.
>
> Run these commands in order:
>
> 1. `pnpm lint:fix` — auto-fix any Biome style issues
> 2. `pnpm db:generate` — regenerate Prisma client
> 3. `pnpm build` — build all packages, confirm no TypeScript errors
> 4. `pnpm test` — run full test suite, confirm all tests pass
>
> If any step fails:
> - Read the error output carefully
> - Fix the issue (missing imports, broken references, type errors, etc.)
> - Re-run the failing command to confirm the fix
> - Repeat until all 4 commands pass cleanly
>
> You have full access to edit any file in the codebase to fix issues. Be thorough — 21 agents edited files in parallel so there may be cross-cutting issues (duplicate new files, conflicting helper names, missing re-exports, etc.).
>
> After everything passes, report which commands passed on first try and what you had to fix.

---

## Orchestration summary

```
1. TeamCreate("simplify-sweep")
2. Launch ALL 21 exec-* agents simultaneously    (21 parallel agents)
3. Wait for all 21 to finish
4. Launch verifier                                (1 sequential agent)
5. Wait for verifier to finish
6. TeamDelete
7. Report final status to user
```

Total agents: 22. Peak parallelism: 21 (Phase 1).
