# MCP Stdio Transport for Claude Desktop

**Date:** 2026-02-16
**Duration:** ~10 minutes
**Scope:** Add stdio transport to MCP server for Claude Desktop compatibility

## Summary

Added `--stdio` flag support to the MCP server so it can run in both HTTP mode (default, for dev/frontend chatbot) and stdio mode (for Claude Desktop). Fixed the shared logger to write all levels to stderr, preventing stdout corruption in stdio mode.

## Changes

### packages/mcp
- **src/index.ts** — Added `StdioServerTransport` import and `--stdio` CLI flag. When present, server uses stdin/stdout transport instead of HTTP.

### packages/shared
- **src/logger.ts** — Changed `info` level from `console.log` (stdout) to `console.error` (stderr). All log levels now use stderr to avoid breaking the stdio MCP protocol.

### Root
- **README.md** — Updated MCP Configuration section to document both transports, Claude Desktop config with `--stdio` flag, and HTTP dev server usage.

## Verification

- `pnpm --filter @cramkit/mcp build` passes cleanly

## Decisions & Notes

- Chose `--stdio` CLI flag (vs env var) — it's the common convention for MCP servers
- Logger change affects all packages using `createLogger`, not just MCP. This is fine since `console.error` is the correct choice for application logs anyway (`console.log` should be reserved for program output).
- User's GitHub PAT was exposed in the conversation — advised immediate revocation
