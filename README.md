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

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cramkit": {
      "command": "node",
      "args": ["path/to/cramkit/packages/mcp/dist/index.js"],
      "env": {
        "CRAMKIT_API_URL": "http://localhost:3456"
      }
    }
  }
}
```
