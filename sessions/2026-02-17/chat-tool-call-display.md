# Chat Tool Call Display Fix

**Date:** 2026-02-17
**Duration:** ~15 minutes
**Scope:** Fix raw `<tool_call>` XML rendering in chat UI — parse into proper ToolCallDisplay components

## Summary

The Claude CLI was emitting MCP tool calls as `<tool_call>` XML text content instead of (or alongside) proper `tool_use` content blocks. This caused raw XML to render as visible text in the chat UI. Fixed by parsing the XML into structured `tool-call` content parts that `assistant-ui`'s existing `ToolCallDisplay` component renders.

## Changes

### packages/web/src/lib/chat-adapter.ts
- Added `parseTextToolCalls()` — extracts `<tool_call>` (name + args) and `<tool_result>` data from text, matches results to calls by index order
- `buildContentParts()` now creates `tool-call` content parts from parsed XML, merged with any SSE-based tool calls
- Strips complete and trailing incomplete XML tags from displayed text

### packages/web/src/pages/Chat.tsx
- History loader (`load()` in `useMemo`) now also parses `<tool_call>`/`<tool_result>` XML from stored message text
- Creates `tool-call` content parts for historical messages so old conversations render correctly

### packages/api/src/routes/chat.ts
- Added `stripToolCallXml()` utility
- Applied to `fullAssistantContent` before DB persistence (all 3 save points) so stored text is clean

## Verification

- `pnpm build` passes cleanly (no type errors)
- Not yet tested end-to-end with live chat (needs `pnpm dev` and a conversation with tool calls)

## Decisions & Notes

- **Defensive approach**: Both SSE-based tool calls (proper `tool_use` blocks) and text-based XML tool calls are supported. If the CLI starts emitting proper blocks, the SSE path handles them; the XML parser is a fallback.
- **Streaming partial tags**: Trailing incomplete `<tool_call...` is stripped during streaming to avoid flashing raw XML. Complete tags are parsed into tool-call parts. There may be brief flashes of partial XML during streaming before the closing tag arrives.
- **Result matching by order**: `<tool_result>` tags are matched to `<tool_call>` tags by position (1st result → 1st call). This assumes the model emits them in order, which it does.
- **Root cause not addressed**: The underlying issue (CLI emitting XML text instead of proper `tool_use` blocks) is likely a model/CLI configuration issue. This fix is a robust workaround regardless of which format the CLI uses.
