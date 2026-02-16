# Phase 0 Gap Completion

**Date:** 2026-02-16
**Duration:** ~10 minutes
**Scope:** Implement 4 remaining Phase 0 gaps: PDF conversion, file type select, editable scope/notes, file delete

## Summary

Closed all functional gaps in Phase 0. The API now converts PDF/DOCX/etc. to markdown via markitdown-ts. The web UI gained a file type dropdown on upload, editable scope/notes textareas with debounced auto-save, and per-file delete buttons. All 4 packages build cleanly.

## Changes

### packages/api
- **`package.json`** — Added `markitdown-ts` dependency
- **`src/services/file-processor.ts`** — Route `.txt`/`.md` to direct UTF-8 read; all other extensions go through `MarkItDown.convert()` with UTF-8 fallback

### packages/web/src/lib
- **`api.ts`** — Added `updateSession(id, data)` (PATCH) and `deleteFile(fileId)` (DELETE)

### packages/web/src/components
- **`FileUpload.tsx`** — Added `fileType` state + `<select>` dropdown with all 7 FileType options; passes selected type to `uploadFile()`
- **`FileList.tsx`** — Added `sessionId` prop, `handleDelete` with cache invalidation, Trash2 icon button per row with destructive hover style

### packages/web/src/pages
- **`SessionDetail.tsx`** — Replaced read-only scope `<p>` with two `<textarea>` fields (scope + notes), 800ms debounced auto-save via `useEffect`, ref guard to prevent sync loops; passes `sessionId` to `<FileList>`

## Verification

- `pnpm build` — all 4 packages compile with zero errors
- Manual testing checklist from plan: upload PDF, select file types, edit scope/notes (refresh to verify persistence), delete files

## Decisions & Notes

- Gap 4 (shadcn/ui init) intentionally skipped per plan — raw Tailwind is consistent, shadcn deferred to Phase 1
- `markitdown-ts` emits a deprecation warning for `url.parse()` from a transitive dep (`whatwg-encoding`) — harmless, tracked upstream
- FileList delete has no confirmation dialog — acceptable for Phase 0, consider adding in Phase 1
- Auto-save fires on every scope/notes keystroke (debounced 800ms) with no error handling — sufficient for local dev, add toast feedback in Phase 1
