# Persistent Chat Streaming

**Date:** 2026-02-17
**Duration:** ~20 minutes
**Scope:** Make chat streaming survive client disconnections by decoupling CLI subprocess from HTTP lifecycle

## Summary

Previously, navigating away from the chat page killed the HTTP connection, which aborted the Claude CLI subprocess and lost the in-progress response (along with API credits). Now the CLI runs to completion in a background stream manager regardless of client connection state. The response is persisted to DB and available when the user returns.

## Changes

### packages/api/src/services/stream-manager.ts (new)
- In-memory `ActiveStream` map keyed by conversationId
- `startStream()` — background consumer reads CLI ReadableStream, buffers SSE events, accumulates content/tool calls, persists assistant message to DB on completion, cleans up after 60s timeout
- `getStream()` / `subscribe()` — reconnection support: replays buffered events then delivers live ones

### packages/api/src/routes/chat.ts
- Removed `signal: c.req.raw.signal` from `streamCliChat()` call — CLI no longer dies on HTTP disconnect
- POST /chat/stream now registers with stream manager instead of consuming inline; SSE handler subscribes to stream manager
- Reconnection: if active stream exists for conversationId, skips CLI spawn and subscribes to existing stream
- Added GET /chat/conversations/:id/stream-status endpoint

### packages/web/src/lib/api.ts
- Added `fetchStreamStatus()` function

### packages/web/src/pages/Chat.tsx
- Polls stream-status on conversation mount (1.5s interval)
- Shows "Generating response in background..." indicator during active background streams
- Bumps `threadReloadKey` on stream completion to remount ChatThread and load persisted response

## Verification

1. `pnpm build` — all 4 packages build successfully
2. `biome check` — no new lint errors in authored files
3. TypeScript type check — no new type errors
4. Manual test sequence:
   - Send a chat message, navigate away while streaming
   - Watch server logs for "cli-chat DONE"
   - Navigate back — response should be loaded from DB
   - Send message, navigate away and back while still streaming — should see "Generating..." then response appears
   - Normal flow (stay on page) still works

## Decisions & Notes

- Stream events are buffered in memory (not persisted) — if the server restarts mid-stream, the response is lost. Acceptable for a local-first tool.
- Cleanup delay is 60s after stream completion — keeps the stream available for reconnection briefly.
- Frontend reconnection uses a simple poll + remount approach rather than SSE reconnection through the adapter. This is simpler and works well with assistant-ui's runtime model.
- The chat adapter itself is unchanged — reconnection happens at a higher level (Chat component polls status, remounts ChatThread when done).
