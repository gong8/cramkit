# Fix Chat Stream 404

**Date:** 2026-02-17
**Duration:** ~25 minutes
**Scope:** Fix 404 error when sending chat messages in new conversations

## Summary

Sending a message in a new (empty) conversation always returned a 404 from `POST /api/chat/stream`. The root cause was the rewind/retry detection in `chat-adapter.ts` — it mistakenly sent auto-generated assistant-ui message IDs (e.g. `"wzwfYD5"`) as `rewindToMessageId`, causing the API to look for a non-existent message and return 404.

## Changes

### packages/web/src/lib/chat-adapter.ts

- Fixed rewind detection: changed ID check from `!msgId.startsWith("__")` to `/^c[a-z0-9]{20,}$/.test(msgId)` (Prisma cuid format)
- The old heuristic assumed auto-generated IDs start with `"__"`, but assistant-ui generates short alphanumeric IDs that passed the check

## Verification

- Reproduced the bug in browser: create new conversation, type message, send -> 404
- Applied fix, reloaded page, created new conversation, sent message -> 200, assistant streams response
- Confirmed via intercepted fetch that `rewindToMessageId` is no longer sent for new messages
- Direct API calls via curl confirmed the API itself was always fine — the bug was purely client-side request payload

## Decisions & Notes

- The cuid regex `/^c[a-z0-9]{20,}$/` is tightly coupled to Prisma's default ID generation. If the ID strategy changes, this will break. An alternative would be to track which message IDs came from the DB history load, but the regex is simpler and sufficient for now.
- The user also had uncommitted changes in `Chat.tsx` improving cleanup effect race conditions (cleanupRanRef, conversationsFetching guard). Those changes are unrelated to this bug but are good improvements.
