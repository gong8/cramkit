# Chat System Prompt Engineering

**Date:** 2026-02-17
**Duration:** ~15 minutes
**Scope:** Replaced the minimal chatbot system prompt with a comprehensive tutor prompt

## Summary

Replaced the ~200-token "you are a study assistant" system prompt with a ~1,500-token structured prompt that gives the chat agent clear tool strategy, teaching style, formatting rules, and session context including the session ID and resource IDs. Also refined the CLI suffix guardrails.

## Changes

### packages/api/src/routes/chat.ts
- Resource list now includes resource IDs and indexing status (fully indexed / content-indexed / not yet indexed)
- Session ID injected directly into prompt so the agent doesn't need to discover it
- System prompt restructured with XML-tagged sections: `<session>`, `<materials>`, `<tool_strategy>`, `<formatting>`, `<teaching>`
- Added: tool decision tree (which tool when), fallback chain, knowledge graph enrichment via `create_link`, LaTeX/KaTeX formatting instructions, adaptive teaching style

### packages/api/src/services/cli-chat.ts
- Replaced `SYSTEM_PROMPT_SUFFIX` with shorter, focused constraints (tool scope, no fabricated citations, fallback to own knowledge)

## Verification

- `pnpm build` passes with no errors across all 4 packages

## Decisions & Notes

- **Session ID in prompt**: Every MCP tool requires it — eliminates a wasted `list_sessions()` call on every conversation
- **`create_link` directive**: Agent actively enriches the knowledge graph during conversations, complementing the background amortiser which only creates low-confidence `related_to` links
- **CLI session persistence deferred**: Investigated using `--session-id` to avoid resending history, but the Claude API is stateless — full history is always sent regardless. Documented in `plans/cli-session-persistence.md`
- **Token cost**: ~1,300 extra input tokens per message, marginal relative to growing conversation history
