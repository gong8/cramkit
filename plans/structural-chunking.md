# Structural Chunking & Document Tree

## Summary

Replace the current "Phase 0" single-chunk-per-file approach with structure-aware chunking that parses documents into a tree of meaningful sections. Each node in the tree is stored both as a file on disk (directory tree) and as a record in the DB (with parent references). This makes the knowledge graph indexing simpler and gives precise location awareness for every concept.

## Current State

- `file-processor.ts` converts files to markdown via MarkItDown, then stores the **entire content as a single chunk** (line 37: "Phase 0 shortcut")
- The Chunk model has `startPage`/`endPage`/`keywords` fields that are unused
- Graph indexing receives one massive blob of text per file, has to discover all structure itself via LLM
- No way to point to "where" in a file a concept lives

## Goals

1. User can choose at upload time whether a file should be **split into sections** or **kept as a single document**
2. Markdown is parsed by heading structure into a tree of nodes
3. Each node is stored as its own `.md` file on disk in a directory hierarchy
4. The DB maintains a tree of Chunk records with parent references
5. Graph indexing becomes lighter — structure is already known, it just needs to label/link concepts

## Design

### Upload Flow Change

Add a `splitMode` option to file upload:
- `"auto"` (default) — split if the document has headings, otherwise keep as single
- `"split"` — always parse into tree
- `"single"` — keep as one chunk (current behaviour)

This should be a field on the `File` model and passed during upload. The frontend file upload UI needs a toggle/dropdown for this.

### Markdown Parsing & Tree Construction

After MarkItDown conversion, parse the markdown into a tree based on headings:

```
# Chapter 1: Vector Spaces        → depth 0 node
## 1.1 Definitions                 → depth 1 node
Some content here...               → content of the depth 1 node
### Definition: Vector Space       → depth 2 node
A vector space is...               → content of the depth 2 node
## 1.2 Examples                    → depth 1 node
```

Algorithm:
1. Split markdown by heading regex (`/^(#{1,6})\s+(.+)$/m`)
2. Build a tree where each heading creates a node, and content between headings is that node's body
3. Nesting is determined by heading level (h1 > h2 > h3 etc.)
4. Content before the first heading becomes the root node's body
5. Leaf nodes that are very short (< 50 chars) can be merged into their parent

Each node gets:
- `title` — the heading text (or filename for root)
- `content` — the body text under that heading (NOT including children's content)
- `depth` — heading level (0 for root)
- `order` — position among siblings (0-indexed)
- `nodeType` — inferred from title/content patterns (see below)

### Node Type Inference

Parse the heading text to classify nodes. Use simple heuristic matching on the title:

| Pattern in title | nodeType |
|---|---|
| `Definition:` or `Def.` | `definition` |
| `Theorem:` or `Thm.` | `theorem` |
| `Proof` | `proof` |
| `Example` or `Ex.` | `example` |
| `Lemma:` | `lemma` |
| `Corollary:` | `corollary` |
| `Exercise` or `Question` or `Q1`, `Q2`... | `question` |
| `Chapter` or single `#` heading | `chapter` |
| `Section` or `##` heading | `section` |
| Fallback | `section` |

This is heuristic and doesn't need to be perfect — the graph indexer can refine it later.

### Disk Storage

Store each node as a file in a directory tree under the session's processed directory:

```
data/processed/<sessionId>/<file-slug>/
├── _index.md                          (root node — full file overview or preamble)
├── 01-vector-spaces/
│   ├── _index.md                      (section content)
│   ├── 01-definition-vector-space.md
│   └── 02-example-rn.md
└── 02-linear-maps/
    ├── _index.md
    ├── 01-definition-linear-map.md
    └── 02-theorem-rank-nullity.md
```

Naming convention:
- Directories for nodes that have children, files for leaf nodes
- Prefix with zero-padded order index (`01-`, `02-`) to maintain document order
- Slugify the title for the filename
- `_index.md` holds the content of a non-leaf node itself

Each `.md` file should have a small YAML frontmatter header for metadata:
```yaml
---
title: "Definition: Vector Space"
nodeType: definition
depth: 2
order: 0
startPage: 3
endPage: 3
---
```

### Schema Changes

Update the `Chunk` model:

```prisma
model Chunk {
  id       String  @id @default(cuid())
  fileId   String
  file     File    @relation(fields: [fileId], references: [id], onDelete: Cascade)

  parentId String?
  parent   Chunk?  @relation("ChunkTree", fields: [parentId], references: [id], onDelete: Cascade)
  children Chunk[] @relation("ChunkTree")

  index    Int           // order among siblings
  depth    Int    @default(0)
  title    String?
  content  String
  nodeType String @default("section")   // chapter, section, definition, theorem, proof, example, question, etc.
  slug     String?                       // path segment on disk (e.g. "01-vector-spaces")
  diskPath String?                       // relative path from session root to this node's file

  startPage Int?
  endPage   Int?
  keywords  String?

  createdAt DateTime @default(now())

  @@index([fileId])
  @@index([parentId])
}
```

Add to `File` model:
```prisma
splitMode  String  @default("auto")   // "auto", "split", "single"
```

### Implementation Steps

#### Step 1: Schema migration
- Add `parentId`, `depth`, `nodeType`, `slug`, `diskPath` to Chunk
- Add self-relation for tree
- Add `splitMode` to File
- Run `prisma migrate dev`

#### Step 2: Markdown tree parser
- Create `packages/api/src/services/markdown-parser.ts`
- Export a function `parseMarkdownTree(markdown: string): TreeNode[]` that takes raw markdown and returns a tree of nodes
- Each `TreeNode`: `{ title, content, depth, order, nodeType, children: TreeNode[], startPage?, endPage? }`
- Handle edge cases: no headings (single root node), deeply nested headings, empty sections

#### Step 3: Disk writer
- Create `packages/api/src/services/tree-writer.ts`
- Export a function `writeTreeToDisk(sessionId: string, fileSlug: string, tree: TreeNode[]): Promise<DiskMapping[]>`
- Writes the directory structure and `.md` files with frontmatter
- Returns a mapping of tree paths to disk paths

#### Step 4: Update file-processor.ts
- After MarkItDown conversion, check `splitMode`
- If splitting: call `parseMarkdownTree()`, then `writeTreeToDisk()`, then create Chunk records with parent references
- If single: current behaviour (one chunk, no parent)
- The root chunk's `diskPath` points to the `_index.md` of the top-level directory

#### Step 5: Update upload API + frontend
- Add `splitMode` to the file upload request schema (in shared package)
- Add a toggle in the frontend upload UI (default to "auto")
- Pass it through to `File` creation

#### Step 6: Update graph indexer
- Instead of concatenating all chunks, walk the tree
- The LLM now receives structured context: it knows the hierarchy and node types
- Its job simplifies to: confirm/refine node types, extract concept names per node, and identify cross-file links
- File-concept relationships now point to specific chunks (with `diskPath` for location)

#### Step 7: API endpoints for tree browsing
- `GET /files/:fileId/tree` — returns the chunk tree for a file
- Useful for the frontend to render a table-of-contents / tree view of a document

### What NOT to change

- The `Concept` and `Relationship` models stay the same
- The queue system stays the same
- The session-level graph endpoints stay the same
- MarkItDown conversion stays the same (it already produces markdown)

### Edge Cases

- **No headings in markdown**: treat entire content as a single root node (same as `single` mode)
- **Very large sections**: don't split further — the tree follows document structure, not size limits
- **Duplicate heading titles**: the slug includes the order prefix, so `01-introduction` and `02-introduction` are distinct
- **Page number tracking**: MarkItDown may include page break markers — parse these to populate `startPage`/`endPage` if available
- **Re-processing a file**: delete existing chunks and disk files for that file before re-creating (same pattern as current graph re-indexing cleanup)

### Dependencies

- No new packages needed — markdown parsing is simple regex/string splitting
- MarkItDown already handles the heavy conversion (PDF → md, docx → md, etc.)
- File system operations use Node's `fs/promises`
