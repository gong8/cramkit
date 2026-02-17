# Graph Indexer Retry Logic

**Date:** 2026-02-17
**Duration:** ~10 minutes
**Scope:** Add retry + response logging to graph indexer LLM extraction

## Summary

ProblemSheet_2 failed to graph-index because the LLM returned a conversational response ("I...") instead of JSON. The JSON parse error silently skipped the resource with no way to diagnose. Added retry logic (up to 3 attempts) and logging of the raw LLM response on parse failure.

## Changes

### packages/api/src/services/graph-indexer.ts

- Wrapped LLM call + JSON parse in a retry loop (3 attempts max)
- Captured `rawResponse` outside try block so it's available in catch
- On `SyntaxError`: logs first 300 chars of the actual LLM response
- On other errors: logs the error object with attempt count
- Logs retry attempts and final give-up message

## Verification

- Code review only; the failure is non-deterministic (LLM non-compliance)
- Next time a parse failure occurs, logs will show what the LLM actually returned
- Retry should handle transient LLM misbehavior automatically

## Decisions & Notes

- Confirmed that chatbot usage during indexing cannot cause collisions — each `chatCompletion` spawns an independent `claude --print --no-session-persistence` process in its own temp dir
- The linter also applied some other changes to the file (dedup logic, question matching improvements) that were unrelated to this work
