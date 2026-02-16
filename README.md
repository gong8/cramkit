# CramKit

A local-first study tool that gives Claude (via MCP) structured, indexed access to your exam materials.

## Stack

- **Monorepo**: pnpm workspaces
- **Frontend**: Vite + React + Tailwind + shadcn/ui
- **API**: Hono
- **Database**: SQLite via Prisma
- **MCP**: `@modelcontextprotocol/sdk`
- **PDF conversion**: `markitdown-ts`

## Structure

```
packages/
  web/       — React frontend (upload, session management)
  api/       — Hono API server (file processing, indexing, CRUD)
  mcp/       — MCP server (tools for Claude Desktop)
  shared/    — Shared types, db client, utils
```

## Setup

```sh
pnpm install
pnpm prisma generate --filter shared
pnpm dev
```

## MCP Configuration

The MCP server supports two transports:

- **HTTP** (default) — runs on `http://127.0.0.1:3001/mcp`, used during development and by the frontend chatbot
- **stdio** — for Claude Desktop, which manages the process itself

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cramkit": {
      "command": "node",
      "args": ["path/to/cramkit/packages/mcp/dist/index.js", "--stdio"],
      "env": {
        "CRAMKIT_API_URL": "http://localhost:3456"
      }
    }
  }
}
```

### Development

The HTTP server starts automatically with `pnpm dev` on port 3001 (override with `CRAMKIT_MCP_PORT`).
