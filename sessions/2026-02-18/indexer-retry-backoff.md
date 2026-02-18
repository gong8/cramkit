# Indexer Retry Backoff & Circuit Breaker

**Date:** 2026-02-18
**Duration:** ~10 minutes
**Scope:** Add exponential backoff and circuit breaker to extraction agent retries

## Summary

When the Anthropic API returns 500 errors, the indexer was burning through all 3 retry attempts per resource in ~3 seconds with no delay, then moving to the next resource and doing the same. Added exponential backoff to retry loops and a batch-level circuit breaker that pauses when consecutive API failures are detected.

## Changes

### packages/api/src/services/errors.ts
- Added `isApiServerError()` — regex detects API 5xx errors from CLI output
- Added `sleep()` — AbortSignal-aware delay utility

### packages/api/src/services/graph-indexer.ts
- `extractWithRetries` now sleeps between retries: 10s/20s for normal errors, 30s/60s for API 500s

### packages/api/src/services/metadata-indexer.ts
- Same backoff pattern applied to metadata extraction retries

### packages/api/src/lib/queue.ts
- Added circuit breaker: tracks consecutive API failures per batch
- After 2 consecutive API failures, pauses 60s before the next job starts
- Resets on success; cleaned up when batch finishes

## Verification

- `pnpm build` passes cleanly

## Decisions & Notes

- Backoff multiplier is linear (baseDelay * attempt) rather than true exponential — keeps max wait reasonable at 60s for API errors with only 3 attempts
- Circuit breaker threshold of 2 consecutive failures and 60s pause is conservative — could be tuned
- Circuit breaker only applies at the batch/job level, not within the per-resource retry loop (which has its own backoff)
- The `sleep` helper rejects with `CancellationError` on abort, which is already handled by the retry loops
