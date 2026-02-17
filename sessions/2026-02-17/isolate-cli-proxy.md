# Isolate Claude Proxy from Workspace Environment

**Date:** 2026-02-17
**Duration:** ~20 minutes
**Scope:** Replace `claude-max-api-proxy` with direct CLI spawning for full MCP/tool isolation

## Summary

Replaced the `claude-max-api-proxy` (which leaked all host workspace tools into the chat agent) with direct `claude` CLI spawning per-request. Both the chat streaming endpoint and the indexing `chatCompletion` function now spawn isolated CLI processes with `--strict-mcp-config`, `--disallowedTools`, and `--setting-sources ""`. The proxy script and its infrastructure were removed entirely.

## Changes

### packages/api/src/services/cli-chat.ts (new)
- Spawns `claude --print --output-format stream-json` per chat request
- `--strict-mcp-config` + `--mcp-config` pointing only to cramkit MCP at `http://127.0.0.1:3001/mcp`
- Blocks all 21 built-in tools via `--disallowedTools`
- `--setting-sources ""`, `--no-session-persistence`, `--dangerously-skip-permissions`
- Minimal env (PATH, HOME, SHELL, TERM only)
- System prompt suffix enforcing `mcp__cramkit__*` tools only
- Parses stream-json, extracts `text_delta` events, emits SSE

### packages/api/src/services/llm-client.ts (rewritten)
- `chatCompletion()` now spawns `claude --print --output-format text`
- Same isolation flags (no MCP needed for indexing)
- Function signature unchanged — all consumers (graph-indexer, tests) unaffected

### packages/api/src/routes/chat.ts (updated)
- Replaced `fetch(LLM_BASE_URL)` proxy call with `streamCliChat()`
- Removed `LLM_BASE_URL`, `LLM_API_KEY` constants
- SSE forwarding parses CLI stream format instead of OpenAI format
- Updated system prompt to reference MCP tools for content retrieval

### Cleanup
- Deleted `scripts/dev-proxy.sh`
- `package.json`: `dev` → `turbo dev` (no more concurrently), removed port 3456 from kill, removed `concurrently` dep
- `.env` / `.env.example`: removed `LLM_BASE_URL`, `LLM_API_KEY`; kept `LLM_MODEL`

### tests/unit/llm-client.test.ts (rewritten)
- Mocks `child_process.spawn` instead of `global.fetch`
- Uses `mockImplementation` with lazy process creation (avoids timing issues with event listeners)
- 8 tests covering: stdout response, CLI args, minimal env, model overrides, error codes, empty response, system prompt handling, null byte stripping

## Verification

- `npx tsc --noEmit -p packages/api/tsconfig.json` — clean
- `pnpm test -- tests/unit/llm-client.test.ts` — 8/8 pass
- `pnpm test` — 78/79 pass (1 pre-existing failure in `graph-routes.test.ts` unrelated to this change)

## Decisions & Notes

- Followed the nasty-plot pattern (`cli-chat.service.ts`) but simplified: no StreamParser (XML plan/step parsing), no tool-labels (UI tool visibility) — just streams text content
- The chat adapter on the frontend (`chat-adapter.ts`) was not changed — same SSE format (`event: content`, `data: {"content": "..."}`, `event: done`)
- `--max-turns 50` set as a safety limit for the chat agent loop
- `concurrently` removed from devDependencies since it's no longer used
- The `CRAMKIT_MCP_URL` env var can override the default MCP URL (`http://127.0.0.1:3001/mcp`)
