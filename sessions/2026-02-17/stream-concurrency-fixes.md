# Stream Concurrency Fixes

**Date:** 2026-02-17
**Duration:** ~30 min
**Scope:** Fix duplicated output and race conditions when multiple chat streams run concurrently

## Summary

Fixed a critical race condition where concurrent chat streams shared temp files (system prompt, MCP config), causing Claude CLI processes to read the wrong session context. Also fixed subscriber leaks in the stream manager and added a double-start guard.

## Changes

### packages/api/src/services/cli-chat.ts
- **Root cause fix**: Changed from a single shared `TEMP_DIR` with fixed filenames to per-invocation directories (`cramkit-cli/<uuid>/`). Each `streamCliChat()` call now gets isolated temp files.
- Added `rmSync` cleanup of the invocation directory when the CLI process exits (close/error handlers).
- Changed `writeTempFile`, `writeMcpConfig`, `writeSystemPrompt` to accept a directory parameter instead of using the module-level constant.

### packages/api/src/services/stream-manager.ts
- **Queue-based subscriber delivery**: Replaced synchronous subscriber callbacks with per-subscriber async queues. Events (replay + live) are delivered in order even when the callback is async (e.g., `sseStream.writeSSE`).
- **`SubscribeHandle` return type**: `subscribe()` now returns `{ unsubscribe, delivered }` instead of just an unsubscribe function. The `delivered` promise resolves when all events (replay + live) have been written.
- **Double-start guard**: `startStream()` now returns the existing stream if one is already active for the same conversationId, instead of creating a second (which would orphan the first).

### packages/api/src/routes/chat.ts
- All three `streamSSE` handlers now `await handle.delivered` instead of `await existingStream.done`, ensuring the SSE connection stays open until all queued events are written (not just until the background stream finishes).
- Added `try/finally` blocks to call `handle.unsubscribe()` on all SSE handlers, preventing dead subscribers from lingering in `stream.subscribers` after client disconnect.

## Verification

- `pnpm build` — all 4 packages build successfully
- `npx biome check` — no lint issues on changed files

## Decisions & Notes

- The per-invocation temp dir approach is simple and robust. The UUID slug prevents collisions. Cleanup is best-effort (`rmSync` in a try/catch).
- The subscriber queue uses JS single-threaded semantics to avoid races — no explicit locks needed. The `drain()` loop's `while` condition re-checks the queue after each `await`, catching events added during the yield.
- Frontend `Chat.tsx` wasn't changed — the reconnect useEffect can still race with the adapter if the user sends a message to a conversation with an active stream. This is an edge case that could be addressed later by disabling the composer during reconnect.
