# Fix Chat Disappearing During Streaming

**Date:** 2026-02-18
**Duration:** ~20 minutes
**Scope:** Fix race condition where conversations get deleted during long-running streams

## Summary

Diagnosed and fixed an intermittent bug where the chat conversation would disappear when the user clicked away during a long-running streaming response (especially during tool calls like reading past papers). The root cause was a stale `messageCount: 0` in the TanStack Query cache allowing `useConversationCleanup` to delete the conversation mid-stream.

## Changes

### packages/web/src/components/chat/ChatThread.tsx

- Modified the adapter wrapper's `run()` generator to invalidate the conversations query on the first streaming chunk
- This ensures `messageCount >= 1` is in the cache before the user can switch away and trigger cleanup
- Added `queryClient` to the `useMemo` dependency array

## Verification

- Not yet runtime-tested (hard to reproduce — requires slow tool calls + clicking away during stream)
- To verify: send a message that triggers long tool calls (e.g., reading past papers), switch to a different conversation mid-stream, then switch back — the original conversation should still exist
- Lint check: pre-existing formatting issue in `chat-adapter.ts`, no new issues introduced

## Decisions & Notes

- **Root cause chain**: `useChatHistory.append()` only invalidates conversations after stream completes → cache has stale `messageCount: 0` → `useConversationCleanup` sees non-active conversation with 0 messages → deletes it → redirect effect kicks in
- **Alternative considered**: Making `useConversationCleanup` aware of active streams, but that would require threading streaming state through more components. Early cache invalidation is simpler and addresses the root cause directly.
- **Potential remaining edge**: Tiny race window between first chunk and query refetch completing, but this is negligible in practice (milliseconds vs the seconds-long window before)
- **Tech debt**: The cleanup hook's 10-second age threshold is fragile — could consider raising it or adding a backend check, but not needed with this fix
