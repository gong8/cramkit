# Capture Agent Stdout for Error Reporting

**Date:** 2026-02-18
**Duration:** ~10 minutes
**Scope:** Fix silent CLI error messages across all agent spawn sites

## Summary

All agent services that spawn the `claude` CLI were only capturing stderr, but the CLI outputs most error messages to stdout. This caused every failed indexing job to log `CLI exited with code 1: ` with no error detail. Added stdout capture to all 7 spawn locations across 5 files so actual error messages are now visible.

## Changes

### packages/api/src/services/

- **extraction-agent.ts** — Added `stdout` capture, error handler uses `(stderr || stdout)`
- **metadata-agent.ts** — Same fix
- **cross-linker.ts** — Same fix
- **cleanup-agent.ts** — Same fix
- **chat-enricher.ts** — Same fix
- **llm-client.ts** — Same fix in both `chatCompletion` (already had stdout capture but error handler only used stderr) and `chatCompletionWithTool` (had neither)

## Verification

- `pnpm lint` passes after `pnpm lint:fix` (3 auto-formatted files)
- Root cause of the batch indexing failures still unknown — this fix surfaces the actual error messages so the next failure will be diagnosable

## Decisions & Notes

- The actual root cause of the batch indexing failures (all Phase 2+ resources failing with exit code 1) is still undiagnosed. The empty stderr was masking the real error. After restarting the dev server, the next indexing run will reveal the actual error message.
- Pattern `(stderr || stdout)` prefers stderr when available since it's the conventional error stream, but falls back to stdout where the claude CLI actually puts its messages.
