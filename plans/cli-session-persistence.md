# CLI Session Persistence

## Status: Deferred

The chat system spawns a fresh Claude CLI process per message (`--print`, `--no-session-persistence`), rebuilding the full conversation history and system prompt each time. The system prompt is ~1,500 tokens.

## Optimisation: Use `--session-id`

The CLI supports `--session-id <id>` which persists conversation state across invocations. This would avoid resending the full history and system prompt on every message.

### How it would work

1. Remove `--no-session-persistence`
2. Add `--session-id <conversationId>` to tie CLI sessions to conversations
3. On first message: pass system prompt + user message
4. On subsequent messages: only pass the new user message

### Trade-offs

- **Dynamic system prompt**: Resource list and indexing status can change between messages (uploads, indexing completion). Currently always fresh. Would need a mechanism to update mid-conversation.
- **Dual state**: CLI maintains its own history alongside the DB — two sources of truth that can drift.
- **System prompt duplication**: `--append-system-prompt-file` is per-invocation, so need to avoid re-appending on subsequent calls.
- **Session cleanup**: CLI session files accumulate on disk and need garbage collection.

### Why it's deferred

The ~1,300 extra tokens from the system prompt are small relative to conversation history, which grows much faster. By message 10, history dwarfs the prompt. The current stateless approach is simpler and keeps the DB as the single source of truth. Revisit if cost or latency becomes a real issue.
