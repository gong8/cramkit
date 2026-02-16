# Session Import/Export

Share sessions with friends who have the same exam.

## What Gets Exported

- **Session metadata** — name, module, examDate, scope, notes
- **Files** — metadata (filename, type, label, pageCount) + raw binary files (PDFs, docs) + processed markdown + index files
- **Chunks** — all chunk data per file (index, title, content, pages, keywords)
- **Relationships** — knowledge graph edges with source/target refs

## Export Format

```
session-export-{name}.cramkit.zip
├── manifest.json              # version, session metadata, file list
├── files/
│   ├── file-001.json          # file metadata + chunks
│   ├── file-001.raw.pdf       # original uploaded file
│   └── file-001.processed.md  # processed markdown
├── relationships.json         # all relationships (using local ref IDs)
└── README.txt                 # human-readable description
```

## Key Challenges

- **ID remapping** — all CUIDs regenerate on import; relationships reference file/chunk IDs that need old-ID -> new-ID mapping
- **Absolute file paths** — rawPath/processedPath are absolute; need to relativize on export and resolve on import
- **Binary bundling** — raw files must be included in the zip, not just JSON
- **Export size** — sessions with many PDFs can be large (50-100MB+)
- **Re-processing vs. exporting processed data** — exporting chunks/processed markdown is more portable; re-processing is lighter but slower on import
- **Schema versioning** — manifest needs a version field so older exports can be handled gracefully

## Implementation Surface

- **Export endpoint** (`GET /sessions/:id/export`) — query all session data, zip files + JSON, stream response
- **Import endpoint** (`POST /sessions/import`) — accept zip, parse manifest, create session + files + chunks with ID remapping, copy raw files, remap relationships
- **UI** — export button on session page, import dropzone/button on session list
- **Shared** — Zod schema for manifest format, types

## Estimated Scope

~500-800 lines across 4-6 files. Medium difficulty — the clean Session -> File -> Chunk hierarchy keeps things self-contained.
