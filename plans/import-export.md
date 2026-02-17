# Session Import/Export

Share sessions with friends who have the same exam. A session is a self-contained unit — exporting one produces a portable archive containing everything needed to recreate it on another machine.

## What Gets Exported

A session export includes **all data** scoped to that session:

- **Session metadata** — name, module, examDate, scope, notes
- **Resources** — name, type (LECTURE_NOTES, PAST_PAPER, etc.), label, splitMode, indexing state
- **Files** — per-resource: filename, role (PRIMARY, MARK_SCHEME, SOLUTIONS, SUPPLEMENT), pageCount, fileSize + raw binaries (PDFs, docs) + processed markdown
- **Chunks** — full hierarchical tree per resource: index, depth, nodeType, slug, diskPath, title, content, startPage, endPage, keywords, parent-child relationships
- **Tree files** — the on-disk markdown tree (`tree/{slug}/...`) with frontmatter, used for MCP access
- **Concepts** — knowledge graph nodes: name, description, aliases, createdBy
- **Relationships** — graph edges: sourceType, sourceId, targetType, targetId, relationship, confidence, createdBy
- **Conversations** — chat history: title, messages (role, content, toolCalls), per-conversation
- **Chat attachments** — images attached to messages: filename, contentType, binary data

## What Does NOT Get Exported

- CUIDs — regenerated on import
- Absolute file paths — relativized on export, resolved on import
- Timestamps — createdAt/updatedAt regenerated on import
- Graph indexing duration — `graphIndexDurationMs` is machine-specific

## Export Format

```
{session-name}.cramkit.zip
├── manifest.json
├── resources/
│   ├── {old-resource-id}/
│   │   ├── resource.json           # resource metadata + files metadata + chunks (flat + parent refs)
│   │   ├── raw/
│   │   │   ├── lecture-notes.pdf    # original uploaded files
│   │   │   └── solutions.pdf
│   │   ├── processed/
│   │   │   ├── lecture-notes.pdf.md # converted markdown
│   │   │   └── solutions.pdf.md
│   │   └── tree/
│   │       └── {resource-slug}/    # full tree directory structure
│   │           ├── _index.md
│   │           ├── 01-section/
│   │           │   ├── _index.md
│   │           │   └── 01-subsection.md
│   │           └── 02-section.md
│   └── {old-resource-id}/
│       └── ...
├── concepts.json                   # all concepts for this session
├── relationships.json              # all relationships (using old IDs as ref keys)
├── conversations/
│   ├── {old-conversation-id}.json  # conversation metadata + messages
│   └── {old-conversation-id}.json
├── attachments/
│   ├── {old-attachment-id}.jpg     # chat attachment binaries
│   └── {old-attachment-id}.png
└── README.txt                      # human-readable session description
```

### manifest.json

```json
{
  "version": 1,
  "exportedAt": "2026-02-17T12:00:00Z",
  "session": {
    "name": "Algorithms & Data Structures",
    "module": "CS201",
    "examDate": "2026-06-15T00:00:00Z",
    "scope": "Chapters 1-12",
    "notes": "Focus on graph algorithms"
  },
  "resourceIds": ["old-resource-id-1", "old-resource-id-2"],
  "conversationIds": ["old-conv-id-1"],
  "stats": {
    "resourceCount": 2,
    "fileCount": 5,
    "chunkCount": 120,
    "conceptCount": 45,
    "relationshipCount": 200,
    "conversationCount": 1,
    "messageCount": 30
  }
}
```

### resource.json (per resource)

```json
{
  "id": "old-resource-id",
  "name": "Lecture Notes Ch.1-6",
  "type": "LECTURE_NOTES",
  "label": "Core material",
  "splitMode": "auto",
  "isIndexed": true,
  "isGraphIndexed": true,
  "files": [
    {
      "id": "old-file-id",
      "filename": "lecture-notes.pdf",
      "role": "PRIMARY",
      "rawPath": "raw/lecture-notes.pdf",
      "processedPath": "processed/lecture-notes.pdf.md",
      "pageCount": 42,
      "fileSize": 2048000
    }
  ],
  "chunks": [
    {
      "id": "old-chunk-id",
      "sourceFileId": "old-file-id",
      "parentId": null,
      "index": 0,
      "depth": 0,
      "nodeType": "section",
      "slug": "introduction",
      "diskPath": "tree/lecture-notes/01-introduction.md",
      "title": "Introduction",
      "content": "...",
      "startPage": 1,
      "endPage": 3,
      "keywords": "algorithms, complexity"
    }
  ]
}
```

### relationships.json

```json
[
  {
    "id": "old-rel-id",
    "sourceType": "chunk",
    "sourceId": "old-chunk-id",
    "sourceLabel": "Binary Search Trees",
    "targetType": "concept",
    "targetId": "old-concept-id",
    "targetLabel": "BST",
    "relationship": "covers",
    "confidence": 0.95,
    "createdBy": "system"
  }
]
```

## ID Remapping Strategy

On import, every entity gets a fresh CUID. A mapping table tracks `oldId → newId` for:

| Entity       | Referenced by                                                     |
| ------------ | ----------------------------------------------------------------- |
| Resource     | File.resourceId, Chunk.resourceId                                 |
| File         | Chunk.sourceFileId                                                |
| Chunk        | Chunk.parentId, Relationship.sourceId/targetId (when type=chunk)  |
| Concept      | Relationship.sourceId/targetId (when type=concept)                |
| Conversation | Message.conversationId                                            |
| Message      | ChatAttachment.messageId                                          |

The remap must handle relationship sourceId/targetId conditionally based on sourceType/targetType:
- `"resource"` → remap against resource ID map
- `"chunk"` → remap against chunk ID map
- `"concept"` → remap against concept ID map

## Key Challenges

- **ID remapping** — all CUIDs regenerated; relationships reference entity IDs that need old→new mapping across 6 entity types
- **Absolute file paths** — rawPath/processedPath are absolute on disk; export relativizes them, import resolves to new session directory
- **Chunk tree hierarchy** — chunks have parent-child self-references (parentId); import must create in topological order (parents before children) or defer FK assignment
- **Binary bundling** — raw files (PDFs) and chat attachment images must be included in the zip
- **Export size** — sessions with many PDFs can be large (50-100MB+); stream the zip rather than buffering
- **Disk tree consistency** — tree/ directory structure must match chunk diskPath values after import
- **Relationship integrity** — relationships reference entities by type+id; if a referenced entity is missing (e.g., a resource was deleted but relationship lingers), skip gracefully
- **Schema versioning** — manifest version field for forward compatibility; importer should reject unknown versions
- **Conversation portability** — toolCalls in messages contain serialized JSON with entity IDs; these are historical and don't need remapping (they're display-only), but worth noting

## Implementation

### API Endpoints

**Export** — `GET /sessions/:id/export`
- Query all session data (resources, files, chunks, concepts, relationships, conversations, messages, attachments)
- Build manifest.json from session metadata + stats
- Stream a zip response:
  - Write manifest.json
  - For each resource: write resource.json, copy raw/ files, copy processed/ files, copy tree/ directory
  - Write concepts.json, relationships.json
  - For each conversation: write conversation JSON with messages
  - Copy chat attachment binaries
- Content-Disposition: `attachment; filename="{session-name}.cramkit.zip"`
- Content-Type: `application/zip`

**Import** — `POST /sessions/import`
- Accept multipart upload of `.cramkit.zip`
- Parse and validate manifest.json (check version, required fields)
- Create new Session with metadata from manifest
- For each resource directory:
  - Parse resource.json
  - Create Resource record (new ID)
  - Copy raw/ files to new session storage directory, create File records with resolved absolute paths
  - Copy processed/ files
  - Copy tree/ directory
  - Create Chunk records in index order, remapping parentId and sourceFileId
  - Update diskPath to point to new tree location
- Create Concept records, building ID map
- Create Relationship records, remapping sourceId/targetId by type
- For each conversation:
  - Create Conversation record
  - Create Message records in order
  - Copy attachment binaries, create ChatAttachment records with remapped messageId
- Return new session ID + summary

### Service Layer

New file: `packages/api/src/services/import-export.ts`

```
exportSession(sessionId): ReadableStream (zip)
importSession(zipFile: File): { sessionId: string, stats: ImportStats }
```

Internally uses `storage.ts` helpers for path resolution and file operations.

### Shared Types/Schemas

In `packages/shared/src/schemas.ts`, add:

- `exportManifestSchema` — Zod schema for manifest.json validation
- `resourceExportSchema` — Zod schema for resource.json
- `ImportStats` type — counts of imported entities

### Web UI

**Dashboard.tsx** (session list):
- Add "Import Session" button that opens a file picker for `.cramkit.zip`
- Show import progress (uploading → processing → done)
- On success, navigate to new session or refresh list

**SessionDetail.tsx** (session detail):
- Add "Export" button in session header/actions area
- Triggers download of `.cramkit.zip`
- Show brief loading state while zip is generated

### Route Files

- `packages/api/src/routes/sessions.ts` — add `GET /:id/export` and `POST /import` endpoints
- Wire to import-export service

## Import Order

Entities must be created in dependency order:

1. Session
2. Resources (depend on session)
3. Files (depend on resource) + copy raw/processed files to disk
4. Chunks (depend on resource, file, parent chunk) — insert depth-first or by index with deferred parentId
5. Copy tree/ directories
6. Concepts (depend on session)
7. Relationships (depend on session, reference resource/chunk/concept IDs)
8. Conversations (depend on session)
9. Messages (depend on conversation)
10. ChatAttachments (depend on message) + copy attachment files

## Edge Cases

- **Duplicate session name** — append " (imported)" or let Prisma handle (no unique constraint on name)
- **Missing raw files** — if a raw file referenced in resource.json is missing from the zip, skip that file and log a warning (partial import)
- **Corrupt zip** — validate structure before starting DB writes; if manifest is missing or invalid, reject immediately
- **Version mismatch** — if manifest version > supported, reject with clear error message
- **Large sessions** — stream zip on export (don't buffer entire archive in memory); for import, extract to temp directory then process
- **Chat attachment orphans** — attachments with null messageId (uploaded but never sent) can be skipped on export
- **Re-import** — no deduplication; importing the same zip twice creates two independent sessions

## Estimated Scope

~800-1200 lines across 5-7 files:
- `packages/api/src/services/import-export.ts` — core logic (~400-500 lines)
- `packages/api/src/routes/sessions.ts` — 2 new endpoints (~50 lines)
- `packages/shared/src/schemas.ts` — manifest/export schemas (~50 lines)
- `packages/web/src/lib/api.ts` — export/import API calls (~30 lines)
- `packages/web/src/pages/Dashboard.tsx` — import button + UI (~80 lines)
- `packages/web/src/pages/SessionDetail.tsx` — export button (~30 lines)
- Tests (~200-300 lines)
