# Clear Knowledge Graph Index

**Date:** 2026-02-17
**Duration:** ~10 minutes
**Scope:** Add destructive action to clear a session's knowledge graph with confirmation modal

## Summary

Added a "Clear Graph" feature to the session detail page that deletes all concepts and relationships for a session while leaving chunks, files, and resource content untouched. Includes a confirmation modal since the action is destructive and irreversible.

## Changes

### packages/api/src/routes/sessions.ts
- Added `DELETE /sessions/:id/graph` endpoint — deletes concepts + relationships in a transaction, resets `isGraphIndexed` and `graphIndexDurationMs` on resources

### packages/web/src/lib/api.ts
- Added `clearSessionGraph(sessionId)` client function

### packages/web/src/pages/SessionDetail.tsx
- Added "Clear Graph" button (visible when indexed resources exist) in the action bar next to Knowledge Graph and Chat links
- Added confirmation modal with warning text, cancel/confirm buttons, and loading state

## Verification

- Both `packages/web` and `packages/api` pass `tsc --noEmit` type checks

## Decisions & Notes

- Initially scoped as "clear all index data" (chunks + graph + processed files), but narrowed to graph-only (concepts + relationships) per user clarification
- No existing dialog/modal component in the codebase — built inline with a portal-less overlay pattern (fixed positioning + backdrop). If more modals are needed later, extracting a reusable `ConfirmModal` component would make sense.
- The `/:id/graph` route is registered before `/:id` to avoid Hono matching the wildcard first
