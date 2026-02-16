# MCP Transport: stdio → Streamable HTTP

**Date:** 2026-02-16
**Duration:** ~10 minutes
**Scope:** Switched MCP server transport from stdio to streamable-http

## Summary

Replaced the stdio-based MCP transport with streamable HTTP. The MCP server now runs as an HTTP server on `127.0.0.1:3001/mcp` instead of communicating over stdin/stdout. Updated the PRD to reflect the new transport and client configuration.

## Changes

### packages/mcp/src/index.ts
- Replaced `StdioServerTransport` with `StreamableHTTPServerTransport` (stateless mode)
- Added `node:http` server with routing: `/mcp` for MCP traffic, `/health` for health checks
- Port configurable via `CRAMKIT_MCP_PORT` env var (default: 3001)
- No new dependencies — uses built-in `node:http` and existing SDK

### PRD.md
- Renamed "Claude Desktop MCP Configuration" → "MCP Client Configuration"
- Changed config from `command`/`args` (stdio) to `url`-based (`http://127.0.0.1:3001/mcp`)
- Updated "Notes for Claude Code" to reference `streamable-http` transport

## Verification

- `pnpm --filter @cramkit/mcp build` succeeds cleanly

## Decisions & Notes

- Used **stateless mode** (`sessionIdGenerator: undefined`) since the MCP server is already stateless — it fetches everything from the API per request
- No extra dependencies needed; SDK v1.26.0 has `StreamableHTTPServerTransport` built-in with Node.js HTTP compatibility
- Bound to `127.0.0.1` (not `0.0.0.0`) for localhost-only access
