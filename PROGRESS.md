# CramKit — Phase 0 Progress

## Implemented

### Monorepo & Infrastructure
- [x] pnpm workspaces + Turborepo build orchestration
- [x] Biome linting/formatting
- [x] Base TypeScript config (strict, ES2022)
- [x] `.env` / `.env.example` setup
- [x] `data/sessions/` directory structure

### Database (`prisma/schema.prisma`)
- [x] SQLite datasource
- [x] Session, File, Chunk, Relationship models
- [x] FileType enum (LECTURE_NOTES, PAST_PAPER, MARK_SCHEME, etc.)
- [x] Indexes on Relationship

### Shared Package (`packages/shared`)
- [x] Prisma client singleton (`db.ts`)
- [x] Zod schemas for sessions, files, relationships, search (`schemas.ts`)
- [x] TypeScript types (`types.ts`)
- [x] Constants — file type labels, processing statuses (`constants.ts`)

### API Server (`packages/api`)
- [x] Hono app with CORS middleware, runs on port 8787
- [x] **Session CRUD** — POST/GET/PATCH/DELETE `/sessions`
- [x] **File upload** — POST `/sessions/:id/files` (multipart), saves to `data/sessions/{id}/raw/`
- [x] **File CRUD** — GET/PATCH/DELETE `/files/:id`, GET `/files/:id/status`
- [x] **Chunks** — GET `/files/:id/chunks`, GET `/chunks/:id`
- [x] **Relationships** — POST/GET/DELETE
- [x] **Search** — GET `/sessions/:id/search?q=` (case-insensitive substring on chunk title/content/keywords)
- [x] Processing queue via `p-queue` (concurrency: 1)
- [x] Storage service (save/read/delete raw + processed files)
- [x] File processor creates single chunk per file (Phase 0 shortcut)

### MCP Server (`packages/mcp`)
- [x] Streamable HTTP transport at `/mcp` (port 3001)
- [x] Health check at `/health`
- [x] API client abstraction for all backend calls
- [x] **Session tools**: `list_sessions`, `get_session`, `get_exam_scope`
- [x] **Content tools**: `search_notes`, `get_file_content`, `get_chunk`, `get_file_index`
- [x] **Paper tools**: `list_past_papers`, `get_past_paper`, `list_problem_sheets`

### Web Frontend (`packages/web`)
- [x] Vite + React 19 + Tailwind CSS v4
- [x] React Router (/, /new, /session/:id)
- [x] TanStack React Query for server state
- [x] Vite dev proxy (`/api` → `localhost:8787`)
- [x] Layout component with header
- [x] **Dashboard** — session list as cards, "New Session" link
- [x] **New Session** — form (name, module, exam date), creates + redirects
- [x] **Session Detail** — displays session info, file upload zone, file list
- [x] **FileUpload** — drag-and-drop + browse button, uploads files, invalidates cache
- [x] **FileList** — shows file type badge (color-coded), filename/label, Ready/Processing status
- [x] API client (`api.ts`) — `fetchSessions`, `fetchSession`, `fetchSessionFiles`, `createSession`, `uploadFile`

---

## Not Yet Implemented

### 1. PDF → Markdown conversion
- **Where**: `packages/api/src/services/file-processor.ts`
- **Current state**: Reads raw file as UTF-8 text (`readFile(path, 'utf-8')`). PDFs upload as binary garbage.
- **Required**: Install `markitdown-ts`, use it to convert PDF/DOCX to Markdown before saving as processed file.
- **Scope**: Install dep, update `processFile()` to detect file type and run conversion.

### 2. File type selection on upload
- **Where**: `packages/web/src/components/FileUpload.tsx`
- **Current state**: Hardcoded to `"OTHER"` (line 19). No UI for selecting type.
- **Required**: Dropdown/select for file type (Lecture Notes, Past Paper, Mark Scheme, Problem Sheet, Solutions, Specification, Other) shown on upload.

### 3. Editable exam scope + notes
- **Where**: `packages/web/src/pages/SessionDetail.tsx`
- **Current state**: Scope rendered as read-only `<p>` (only if non-null). Notes field not rendered at all.
- **Required**: Two `<textarea>` fields for scope and notes that auto-save via PATCH `/sessions/:id`.
- **Also requires**: `updateSession()` function in `packages/web/src/lib/api.ts` (backend endpoint already exists).

### 4. shadcn/ui initialization
- **Current state**: No `components.json`, no `src/components/ui/` directory. All UI is raw Tailwind classes.
- **Required**: Initialize shadcn/ui (`npx shadcn@latest init`) to get access to Button, Input, Textarea, Select, Card, etc.
- **Note**: Not strictly blocking — everything works with raw Tailwind — but the PRD specifies shadcn/ui as the component library.

### 5. File delete button
- **Where**: `packages/web/src/components/FileList.tsx`
- **Current state**: No delete button per file. No `deleteFile()` in `api.ts`.
- **Required**: Delete button on each file row, calls DELETE `/files/:id`.
- **Note**: Backend endpoint exists and handles filesystem cleanup.

---

## Phase 0 Shortcuts (intentional, per PRD)
- No LLM indexing — entire file stored as a single chunk
- Search is simple case-insensitive substring matching
- No knowledge graph / relationship creation
- No chat UI
- No file linking UI (paper ↔ mark scheme)
