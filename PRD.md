# CramKit — PRD

> A local-first study tool that gives Claude (via MCP) structured, indexed access to your exam materials.
> Designed to be implemented by Claude Code.

---

## Problem

AI-assisted studying is only as good as the context you feed it. Right now, cramming with Claude means manually pasting notes, re-uploading PDFs, and losing context across sessions. CramKit solves this by:

1. Providing a structured upload + indexing pipeline for exam materials
2. Exposing those materials via MCP tools so Claude Desktop (or any MCP client) can intelligently search, retrieve, and cross-reference them
3. Optionally embedding a chat UI (assistant-ui) for direct interaction

---

## Architecture

```
cramkit/
├── packages/
│   ├── web/          # Vite + React frontend (upload, session management)
│   ├── mcp/          # MCP server (tools for Claude Desktop)
│   ├── api/          # Hono API server (file processing, indexing, CRUD)
│   └── shared/       # Shared types, db client, utils
├── data/             # Local file storage (gitignored)
│   └── sessions/
│       └── {id}/
│           ├── raw/          # Original uploaded files
│           └── processed/    # Converted .md, chunks, indices
├── prisma/
│   └── schema.prisma
├── package.json      # pnpm workspace root
├── pnpm-workspace.yaml
└── turbo.json        # Optional: turborepo for build orchestration
```

**Monorepo**: pnpm workspaces
**Database**: SQLite via Prisma (single file, no setup, portable)
**File storage**: Local filesystem under `data/`
**PDF → MD**: `markitdown-ts` (Microsoft's MarkItDown, TS port) for initial conversion
**LLM indexing**: Claude API (via existing proxy from nasty-plot) for chunking + TOC generation
**Chat UI** (Phase 1+): `assistant-ui` (React, shadcn-style composable primitives, Anthropic provider support)
**MCP SDK**: `@modelcontextprotocol/sdk`

---

## Data Model (Prisma + SQLite)

```prisma
datasource db {
  provider = "sqlite"
  url      = "file:../data/cramkit.db"
}

generator client {
  provider = "prisma-client-js"
}

model Session {
  id          String   @id @default(cuid())
  name        String                          // e.g. "PDEs Midterm"
  module      String?                         // e.g. "M2AA1 - Partial Differential Equations"
  examDate    DateTime?
  scope       String?                         // Free text: what's examinable
  notes       String?                         // Extra notes about the exam
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  files       File[]
  relationships Relationship[]
}

model File {
  id            String   @id @default(cuid())
  sessionId     String
  session       Session  @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  filename      String                        // Original filename
  type          FileType                      // LECTURE_NOTES, PAST_PAPER, MARK_SCHEME, PROBLEM_SHEET, PROBLEM_SHEET_SOLUTIONS, SPECIFICATION, OTHER
  label         String?                       // User-provided label, e.g. "2023 Paper Q1-5"

  rawPath       String                        // Path to original file in data/sessions/{id}/raw/
  processedPath String?                       // Path to processed .md file
  indexPath     String?                       // Path to index/TOC file (for large docs)

  pageCount     Int?
  isIndexed     Boolean  @default(false)      // Whether LLM indexing has been done
  chunks        Chunk[]

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}

enum FileType {
  LECTURE_NOTES
  PAST_PAPER
  MARK_SCHEME
  PROBLEM_SHEET
  PROBLEM_SHEET_SOLUTIONS
  SPECIFICATION
  OTHER
}

model Chunk {
  id        String @id @default(cuid())
  fileId    String
  file      File   @relation(fields: [fileId], references: [id], onDelete: Cascade)

  index     Int                              // Order within the file
  title     String?                          // Section heading / topic
  content   String                           // The actual markdown content
  startPage Int?                             // Approximate page reference
  endPage   Int?
  keywords  String?                          // Comma-separated keywords for search

  createdAt DateTime @default(now())
}

// Lightweight knowledge graph edges
model Relationship {
  id             String @id @default(cuid())
  sessionId      String
  session        Session @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  sourceType     String                      // "chunk", "file", "exam_question", "problem_sheet_question"
  sourceId       String
  sourceLabel    String?                     // Human-readable, e.g. "2023 Paper Q3a"

  targetType     String
  targetId       String
  targetLabel    String?                     // e.g. "Theorem 4.2 - Method of Characteristics"

  relationship   String                      // e.g. "tests", "related_to", "solution_of", "prerequisite"
  confidence     Float   @default(1.0)       // 0-1, how confident the link is
  createdBy      String  @default("system")  // "system", "user", "claude"

  createdAt      DateTime @default(now())

  @@index([sessionId])
  @@index([sourceType, sourceId])
  @@index([targetType, targetId])
}
```

---

## File Processing Pipeline

### On Upload (API server handles this)

```
1. Save raw file to data/sessions/{id}/raw/{filename}
2. Convert PDF → Markdown using markitdown-ts
3. Save to data/sessions/{id}/processed/{filename}.md
4. Check size:
   - If < ~10 pages (< 5000 words): store as single chunk, mark indexed
   - If >= ~10 pages: trigger LLM indexing (async)
5. Create File record in DB
```

### LLM Indexing (for large documents)

Use Claude API (via proxy) to:

```
1. Split the markdown into logical sections (by heading, page break, or topic shift)
2. For each section, generate:
   - title (concise heading)
   - keywords (for search)
   - startPage / endPage (approximate)
3. Generate a TOC (table of contents) mapping section titles → chunk IDs
4. Save each section as a Chunk record
5. Save TOC as the index file at data/sessions/{id}/processed/{filename}.index.md
6. Mark file as indexed
```

**Prompt template for chunking** (sent to Claude via proxy):

```
You are indexing lecture notes for a student's exam preparation tool.
Given the following markdown content from a PDF, split it into logical sections.
For each section, provide:
- title: A concise heading
- keywords: 5-10 searchable keywords, comma-separated
- content: The full markdown content of that section

Return as JSON array: [{ title, keywords, content }]

Keep sections at a reasonable granularity - roughly 1-3 pages worth of content each.
Preserve all mathematical notation. Do not summarize - keep the full content.
```

---

## MCP Server — Tool Definitions

The MCP server exposes the following tools to Claude Desktop:

### Session Management

#### `list_sessions`
- **Description**: List all cram sessions
- **Params**: none
- **Returns**: Array of `{ id, name, module, examDate, fileCount, scope }`

#### `get_session`
- **Description**: Get full details of a cram session including exam scope and notes
- **Params**: `{ sessionId: string }`
- **Returns**: Session with all metadata, file list (with types), scope, notes

### Content Retrieval

#### `search_notes`
- **Description**: Search across all indexed materials in a session. Searches chunk titles, keywords, and content. Returns the most relevant chunks.
- **Params**: `{ sessionId: string, query: string, fileTypes?: FileType[], limit?: number }`
- **Returns**: Array of `{ chunkId, fileId, fileName, fileType, title, content, relevanceScore }`
- **Implementation**: Keyword matching on chunk titles, keywords, and content. Simple TF-IDF or even substring matching is fine for Phase 0. Can upgrade to embeddings later.

#### `get_file_content`
- **Description**: Get the full processed content of a specific file. Use for smaller files (past papers, problem sheets).
- **Params**: `{ fileId: string }`
- **Returns**: `{ filename, type, content: string (full markdown) }`

#### `get_chunk`
- **Description**: Get a specific chunk by ID. Use after search_notes to get full context of a result.
- **Params**: `{ chunkId: string }`
- **Returns**: `{ title, content, keywords, file: { name, type }, adjacentChunkIds }`

#### `get_file_index`
- **Description**: Get the table of contents / index of a large file. Use this first to understand the structure before diving into specific sections.
- **Params**: `{ fileId: string }`
- **Returns**: `{ filename, toc: Array<{ chunkId, title, keywords, pageRange }> }`

#### `get_exam_scope`
- **Description**: Get the exam scope and any extra notes for a session.
- **Params**: `{ sessionId: string }`
- **Returns**: `{ scope, notes, examDate }`

### Past Papers & Problem Sheets

#### `list_past_papers`
- **Description**: List all past papers and their associated mark schemes for a session.
- **Params**: `{ sessionId: string }`
- **Returns**: Array of `{ paperId, label, hasMarkScheme, markSchemeId }`

#### `get_past_paper`
- **Description**: Get a specific past paper's content.
- **Params**: `{ fileId: string }`
- **Returns**: Full markdown content of the paper

#### `list_problem_sheets`
- **Description**: List all problem sheets and their solutions for a session.
- **Params**: `{ sessionId: string }`
- **Returns**: Array of `{ sheetId, label, hasSolutions, solutionsId }`

### Knowledge Graph

#### `get_related`
- **Description**: Find related content for a given item (chunk, file, question). Uses the relationship graph.
- **Params**: `{ type: string, id: string, relationshipType?: string }`
- **Returns**: Array of related items with relationship descriptions

#### `create_link`
- **Description**: Create a relationship between two items. Call this when you identify connections between exam questions, problem sheet questions, and lecture content.
- **Params**: `{ sourceType, sourceId, sourceLabel?, targetType, targetId, targetLabel?, relationship, confidence? }`
- **Returns**: Created relationship

### Utility

#### `quiz_me`
- **Description**: Generate a practice question based on a specific topic from the session materials. Uses the indexed content to create relevant questions.
- **Params**: `{ sessionId: string, topic?: string, difficulty?: "easy" | "medium" | "hard" }`
- **Returns**: `{ question, hints: string[], relatedChunks: string[] }`
- **Note**: Phase 1 — this requires an LLM call from the MCP server itself. For Phase 0, skip or implement as a prompt template that Claude can use directly.

---

## Web Frontend (packages/web)

**Stack**: Vite + React + Tailwind + shadcn/ui

### Pages

#### Dashboard (`/`)
- List of all cram sessions as cards
- "New Session" button
- Each card shows: name, module, exam date, file count, progress indicator

#### Session Detail (`/session/:id`)
- **Header**: Session name, module, exam date (editable)
- **Exam Scope** (textarea, auto-saves)
- **Extra Notes** (textarea, auto-saves)
- **Files Section** (tabbed by type):
  - Lecture Notes
  - Past Papers (+ mark schemes)
  - Problem Sheets (+ solutions)
  - Other
- Each tab has:
  - Upload dropzone (drag & drop, multi-file)
  - List of uploaded files with:
    - Filename, label (editable), processing status (uploading / converting / indexing / ready)
    - For past papers: option to link a mark scheme
    - For problem sheets: option to link solutions
    - Delete button
- **Relationships** (collapsible): Shows discovered links between materials. Phase 1+: visualise as graph.

#### New Session (`/new`)
- Simple form: name, module (optional), exam date (optional)
- Redirects to session detail page on creation

### File Upload Flow

1. User drops PDF(s) into upload zone
2. UI shows upload progress
3. On upload complete, API starts processing (PDF → MD → indexing)
4. UI polls for processing status, shows progress indicator
5. When ready, file appears in list with "Ready" badge

### File Type Selection

On upload, user selects file type from dropdown:
- Lecture Notes
- Past Paper
- Mark Scheme (auto-links to most recent unlinked past paper, or manual link)
- Problem Sheet
- Problem Sheet Solutions (auto-links to most recent unlinked sheet)
- Specification
- Other

---

## API Server (packages/api)

**Stack**: Hono (lightweight, TS-native)

### Endpoints

```
POST   /sessions                         Create session
GET    /sessions                         List sessions
GET    /sessions/:id                     Get session detail
PATCH  /sessions/:id                     Update session (scope, notes, etc.)
DELETE /sessions/:id                     Delete session + all files

POST   /sessions/:id/files              Upload file (multipart)
GET    /sessions/:id/files              List files for session
GET    /files/:id                       Get file detail + content
DELETE /files/:id                       Delete file
PATCH  /files/:id                       Update file metadata (label, type)

POST   /files/:id/link                  Link two files (e.g. paper + mark scheme)

GET    /files/:id/status                Get processing status
GET    /files/:id/chunks                Get all chunks for a file
GET    /chunks/:id                      Get single chunk

POST   /sessions/:id/relationships      Create relationship
GET    /sessions/:id/relationships       List relationships
DELETE /relationships/:id               Delete relationship

GET    /sessions/:id/search?q=...       Search across session materials
```

### Processing Queue

- Use a simple in-memory queue (or `p-queue`) for file processing jobs
- Each job: convert PDF → MD → (optional) LLM index
- Expose status via `GET /files/:id/status` → `{ status: "uploading" | "converting" | "indexing" | "ready" | "error", progress?: number }`

---

## Phased Implementation

### Phase 0 — MVP (Target: functional in 1 day)

**Goal**: Upload files, convert to MD, expose via MCP tools. Minimum viable cram tool.

- [ ] Monorepo setup (pnpm, turborepo optional)
- [ ] Prisma schema + SQLite setup in `packages/shared`
- [ ] API server (Hono):
  - Session CRUD
  - File upload + storage to local filesystem
  - PDF → MD conversion using `markitdown-ts`
  - Basic file serving
- [ ] MCP server:
  - `list_sessions`, `get_session`, `get_exam_scope`
  - `get_file_content` (returns full MD for a file)
  - `search_notes` (basic keyword/substring search across file content)
  - `list_past_papers`, `get_past_paper`
  - `list_problem_sheets`
- [ ] Web frontend:
  - Dashboard with session list
  - New session form
  - Session detail with file upload (drag & drop)
  - File type selection
  - Display uploaded files list with status
  - Exam scope + notes text fields

**Phase 0 Shortcuts**:
- No LLM indexing — just store the full MD as a single "chunk"
- Search = simple case-insensitive substring/keyword match
- No knowledge graph edges yet
- No chat UI
- File linking (paper ↔ mark scheme) is manual metadata only

### Phase 1 — Smart Indexing + Chat

- [ ] LLM-powered chunking pipeline (call Claude via proxy to split large docs)
- [ ] TOC generation for indexed files
- [ ] `get_file_index`, `get_chunk` MCP tools
- [ ] Improved search (keyword extraction from chunks, ranked results)
- [ ] `assistant-ui` chat integration in web frontend
  - Wire up to Claude API via existing proxy
  - System prompt includes session context + MCP tool descriptions
- [ ] File linking UI (drag to associate paper ↔ mark scheme, sheet ↔ solutions)
- [ ] Processing status polling in frontend

### Phase 2 — Knowledge Graph + Intelligence

- [ ] `create_link`, `get_related` MCP tools
- [ ] Auto-link discovery: when Claude processes a past paper, it tags which lecture topics are tested
- [ ] Relationship visualisation in frontend (simple graph or matrix view)
- [ ] `quiz_me` tool (MCP server calls Claude to generate questions)
- [ ] Topic coverage heatmap: which topics appear most in past papers?
- [ ] Gap analysis: which topics haven't been practiced yet?

### Phase 3 — Polish + Extensibility

- [ ] Embeddings-based semantic search (local model via `@xenova/transformers` or similar)
- [ ] Auto-fetch resources (e.g. scrape module page for past papers)
- [ ] Export study plan as markdown
- [ ] Spaced repetition tracking for practiced topics
- [ ] Multi-format support: images, handwritten notes (OCR)
- [ ] Collaborative sessions (share session with study group)

---

## Key Dependencies

| Package | Purpose | Install |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server SDK | `pnpm add` in packages/mcp |
| `markitdown-ts` | PDF/DOCX → Markdown | `pnpm add` in packages/api |
| `hono` | API server | `pnpm add` in packages/api |
| `@prisma/client` + `prisma` | Database ORM | `pnpm add` in packages/shared |
| `@assistant-ui/react` | Chat UI components (Phase 1) | `pnpm add` in packages/web |
| `p-queue` | Processing queue | `pnpm add` in packages/api |
| `react`, `react-dom` | Frontend | `pnpm add` in packages/web |
| `tailwindcss`, `@shadcn/ui` | Styling | `pnpm add` in packages/web |
| `zod` | Schema validation | `pnpm add` in packages/shared |
| `vite` | Build tool | `pnpm add` in packages/web |

---

## MCP Client Configuration

The MCP server uses the **Streamable HTTP** transport, exposing an HTTP endpoint at `http://127.0.0.1:3001/mcp`.

Add to your MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cramkit": {
      "url": "http://127.0.0.1:3001/mcp"
    }
  }
}
```

The port is configurable via the `CRAMKIT_MCP_PORT` environment variable (default: `3001`).

The MCP server communicates with the API server over HTTP to fetch data. This keeps the MCP server thin (just tool definitions + API calls) and all business logic in the API.

---

## Design Principles

1. **MCP-first**: The MCP tools are the primary interface. The web UI is for data management, not for studying. Studying happens in Claude Desktop (or the embedded chat).

2. **Modular packages**: Each package has a single responsibility. Easy to swap, extend, or replace. The API server is the single source of truth; MCP and web are both clients.

3. **Local-first**: Everything runs on localhost. No cloud dependencies (except Claude API for indexing). SQLite + filesystem = zero infrastructure.

4. **Progressive enhancement**: Phase 0 works with just substring search and raw markdown. Each phase adds intelligence without breaking what exists.

5. **Claude Code-friendly**: This PRD is structured so Claude Code can implement it top-down. Start with the data model, then API, then MCP, then web. Each section has enough detail to code against.

---

## Notes for Claude Code

- Reference `nasty-plot` project for the Claude proxy setup (API key, endpoint config)
- Use `tsx` for running TypeScript directly during development
- For the MCP server, use `streamable-http` transport (exposes an HTTP endpoint at `/mcp`)
- The MCP server should be stateless — it fetches everything from the API server per request
- Prisma generate needs to run in the shared package; other packages import from there
- Use `zod` schemas in shared package, derive Prisma types from them or vice versa
- Keep API routes thin — extract business logic into service files
- For file upload, use Hono's built-in multipart parsing
- Test MCP tools using `npx @modelcontextprotocol/inspector`
