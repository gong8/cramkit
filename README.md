# CramKit

A local-first study tool that gives Claude (via MCP) structured, indexed access to your exam materials.

## Stack

- **Monorepo**: pnpm workspaces + Turborepo
- **Frontend**: React 19 + Vite + Tailwind v4 + shadcn/ui
- **API**: Hono (runs via Bun)
- **Database**: SQLite via Prisma
- **MCP**: `@modelcontextprotocol/sdk` (HTTP + stdio transports)
- **PDF conversion**: `markitdown-ts`

## Structure

```
packages/
  web/       — React frontend (port 5173)
  api/       — Hono API server (port 8787)
  mcp/       — MCP server, HTTP (port 3001) + stdio
  shared/    — Prisma client, Zod schemas, types, utils
```

## Setup

```sh
pnpm install
cp .env.example .env        # Configure environment
pnpm db:generate            # Generate Prisma client
pnpm db:push                # Create/push SQLite schema
pnpm dev                    # Start all services (web + api + mcp)
```

## Environment

Copy `.env.example` to `.env`. Variables:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `file:./data/cramkit.db` | SQLite file path |
| `LLM_MODEL` | `claude-opus-4-6` | LLM model ID |
| `CRAMKIT_API_URL` | `http://localhost:8787` | API base URL (used by MCP server and web) |

## Scripts

```sh
pnpm dev                  # Start all services
pnpm build                # Build all packages
pnpm test                 # Run all tests
pnpm test:watch           # Tests in watch mode
pnpm lint                 # Check with Biome
pnpm lint:fix             # Auto-fix with Biome
pnpm typecheck            # TypeScript type checking
pnpm check                # Run lint + typecheck + quality + tests
pnpm kill                 # Kill ports 8787, 5173, 3001
pnpm db:generate          # Regenerate Prisma client
pnpm db:push              # Push schema changes to SQLite
```

## MCP Configuration

The MCP server supports two transports:

- **HTTP** (default) — runs on `http://127.0.0.1:3001/mcp`, used during development and by the frontend chatbot
- **stdio** — for Claude Desktop, which manages the process itself

### Claude Desktop

Build the MCP server first, then add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cramkit": {
      "command": "node",
      "args": ["path/to/cramkit/packages/mcp/dist/index.js", "--stdio"],
      "env": {
        "CRAMKIT_API_URL": "http://localhost:8787"
      }
    }
  }
}
```

Make sure the API server is running (`pnpm dev`) before using Claude Desktop with CramKit.

### Development

The HTTP MCP server starts automatically with `pnpm dev` on port 3001 (override with `CRAMKIT_MCP_PORT`).
