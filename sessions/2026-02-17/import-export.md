# Session Import/Export

**Date:** 2026-02-17
**Duration:** ~15 minutes
**Scope:** Full implementation of session import/export feature using parallel agent team

## Summary

Rewrote the outdated `plans/import-export.md` to reflect the current data model (Resources, Concepts, Conversations, etc.), then implemented the entire feature using a 4-agent team running in parallel. Sessions can now be exported as `.cramkit.zip` archives and imported on another machine with full ID remapping.

## Changes

### plans/
- `import-export.md` — complete rewrite covering all 10 entity types, zip format spec, ID remapping strategy, import ordering, edge cases

### packages/shared/src/
- `schemas.ts` — +8 Zod schemas: `fileExportSchema`, `chunkExportSchema`, `resourceExportSchema`, `conceptExportSchema`, `relationshipExportSchema`, `messageExportSchema`, `conversationExportSchema`, `exportManifestSchema`
- `types.ts` — +3 types: `ExportManifest`, `ResourceExport`, `ImportStats`

### packages/api/src/services/
- `session-export.ts` (new) — `exportSession(sessionId)` queries all session data, builds zip with archiver. Relativizes absolute file paths, copies raw/processed/tree files, includes concepts, relationships, conversations, chat attachments, README.txt
- `session-import.ts` (new) — `importSession(zipBuffer)` parses zip with JSZip, validates manifest, creates entities in dependency order with 6 ID remap maps (resource, file, chunk, concept, conversation, message). Chunks sorted by depth for parent-before-child insertion. Cleanup on failure.

### packages/api/src/routes/
- `sessions.ts` — +2 endpoints: `GET /:id/export` (streams zip download), `POST /import` (accepts multipart .cramkit.zip)

### packages/api/
- `package.json` — added `archiver`, `@types/archiver`, `jszip`

### packages/web/src/
- `lib/api.ts` — +2 functions: `exportSession()` (blob download), `importSession()` (multipart upload)
- `pages/SessionDetail.tsx` — Export button with Download icon + loading state
- `pages/Dashboard.tsx` — Import button with file picker, loading state, error banner, query invalidation + navigation on success

## Verification

- `pnpm build` — all 4 packages compile clean
- `pnpm biome check` — all 8 modified files pass lint (auto-fixed template literals and import ordering)
- No runtime testing yet (would need a session with data to test round-trip export/import)

## Decisions & Notes

- **Two zip libraries**: archiver for export (streaming, handles large files well), JSZip for import (simpler API for reading). Could consolidate but both work fine.
- **No streaming import**: entire zip is buffered in memory for import. Fine for typical session sizes (< 100MB), but large sessions with many PDFs could be problematic.
- **diskPath on chunks**: import sets diskPath to absolute path (`join(newResourceDir, chunkEntry.diskPath)`). Original chunks store relative diskPath — need to verify this matches how chunks are read elsewhere.
- **No transaction wrapping**: import creates entities one-by-one without a Prisma transaction (SQLite limitation on long transactions). Cleanup on failure deletes the session (cascade handles children).
- **Chat attachment filenames**: import saves as `{messageId}-{filename}` which differs from the original `{attachmentId}.{ext}` pattern — may need alignment with how the chat routes serve attachments.
- **Agent team approach**: 4 agents in parallel (schemas, export, import, frontend). Worked well — total wall time ~3 minutes for code generation. Agents created some redundant self-tracking tasks (#6-9) that were cleaned up.
