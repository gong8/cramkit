# LLM Chat Title Auto-Generation

**Date:** 2026-02-18
**Duration:** ~10 minutes
**Scope:** Replace truncated-message chat titles with LLM-generated titles

## Summary

Added LLM-powered title generation for conversations. After the first exchange completes, haiku generates a concise 2-6 word title from both the user message and assistant response. The existing `userRenamed` flag prevents overriding user-given nicknames. Truncated-message title remains as an instant fallback.

## Changes

### packages/api/src/services/title-generator.ts (new)
- `generateConversationTitle(db, conversationId)` — queries first exchange, calls haiku to generate a title, saves to DB
- Guards: `userRenamed` check, message count === 2 (first exchange only), try/catch for LLM failures

### packages/api/src/services/stream-manager.ts
- Import `generateConversationTitle`
- In `finalizeStream`: after persisting assistant message, generates title and emits `title` SSE event before `done`

### packages/web/src/components/chat/ChatThread.tsx
- Added `queryClient.invalidateQueries` for conversations in the adapter's `finally` block so sidebar picks up new title on stream completion

## Verification

- `pnpm --filter api exec tsc --noEmit` — clean
- `pnpm --filter web exec tsc --noEmit` — clean
- Pre-existing lint errors in unrelated file (session detail page spans), not introduced by this change

## Decisions & Notes

- Title generation runs synchronously before `done` event, which adds ~1-2s delay to stream "completion" indicator. Content is already fully displayed so UX impact is minimal.
- Kept `autoTitleConversation` (truncated title) as immediate fallback — user sees a title instantly, then it upgrades to the LLM title after the stream finishes.
- Used haiku with `maxTokens: 30` for speed/cost. Passes first 500 chars of each message to avoid large prompts.
- `generateConversationTitle` is called on every stream finalization but short-circuits quickly (2 DB queries) for non-first-exchange conversations.
