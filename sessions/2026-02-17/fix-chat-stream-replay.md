# Fix Chat Stream Replay Bug

**Date:** 2026-02-17
**Duration:** ~20 minutes
**Scope:** Fix bug where second chat message replays first response and disappears

## Summary

Fixed a bug in the chat streaming route where sending a second message within 60 seconds of the first response would instantly replay the previous response and silently drop the new user message. The root cause was the stream reconnection check not distinguishing completed streams from actively streaming ones.

## Changes

### packages/api/src/routes/chat.ts

- Changed the active stream check from `if (getStream(conversationId))` to `if (existingStream && existingStream.status === "streaming")` so that completed streams lingering in the cleanup window are not treated as reconnection targets.

## Verification

- Not yet tested manually. To verify: send a message in chat, wait for response to complete, then send a follow-up message within 60 seconds. The follow-up should stream a fresh response (not replay the first one) and both messages should persist in DB.

## Decisions & Notes

- The stream manager keeps completed streams in memory for 60s (`CLEANUP_DELAY_MS`) to support the reconnect-on-tab-switch feature. This is correct behavior — the bug was only in the `/stream` route treating completed streams as "active."
- Initially misdiagnosed as a `buildPrompt` issue (prompt structure causing model to repeat). Reverted that change after the user clarified the real symptoms: instant response, no streaming, message disappearing.
- The `buildPrompt` function could still benefit from clearer conversation structure for multi-turn `--print` mode, but that's a separate concern.
