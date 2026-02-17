# Raw File Viewer

**Date:** 2026-02-17
**Duration:** ~5 minutes
**Scope:** Make uploaded files (PDFs) viewable by clicking filenames in the session detail page

## Summary

Added the ability to click on filenames in the resource list to open the raw uploaded file (e.g. PDF) in a new browser tab. This required a new API endpoint to serve files from disk and a small UI change to make filenames clickable links.

## Changes

### packages/api/src/routes/resources.ts
- Added `node:fs/promises` and `node:path` imports
- Added `GET /:id/files/:fileId/raw` endpoint that looks up the file record, reads from `rawPath` on disk, and returns with correct `Content-Type` and `Content-Disposition: inline`
- Added MIME type map for PDF, PNG, JPG, TXT

### packages/web/src/components/ResourceList.tsx
- Changed file filename from plain `<span>` to `<a>` tag linking to `/api/resources/{resourceId}/files/{fileId}/raw`
- Opens in new tab (`target="_blank"`)
- Subtle hover style (underline + darker text)

## Verification

- Not yet tested live — restart dev server and click a filename to confirm PDF opens in new tab

## Decisions & Notes

- Used `Content-Disposition: inline` so PDFs render in-browser rather than downloading
- MIME type map is minimal (PDF, PNG, JPG, TXT) with `application/octet-stream` fallback — sufficient for current use case
- No new `api.ts` helper needed on frontend since it's a plain `<a href>` GET request
