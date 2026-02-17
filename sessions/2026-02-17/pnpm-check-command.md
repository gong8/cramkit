# `pnpm check` Command

**Date:** 2026-02-17
**Duration:** ~5 min
**Scope:** Add unified quality gate command that runs lint, typecheck, quality, and tests

## Summary

Added `pnpm check` as a single entrypoint that runs all quality checks in sequence: lint, typecheck, banned-pattern grep, and tests. Cheapest checks run first for fast failure. Existing violations were **not** fixed — the quality step will fail until they are.

## Changes

### Root config
- `package.json` — added `typecheck`, `quality`, and `check` scripts
- `turbo.json` — added `typecheck` task with `dependsOn: ["^build"]`

### Package configs
- `packages/{web,api,mcp,shared}/package.json` — added `"typecheck": "tsc --noEmit"`

### New file
- `scripts/quality-check.sh` — greps for banned patterns (`as any`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable`, `biome-ignore`) in `*.ts`/`*.tsx`, excluding `node_modules/dist/.turbo/data`

## Verification

- Not yet run — existing violations (~17 `as any` / `biome-ignore` hits) will cause `pnpm quality` to fail until fixed

## Decisions & Notes

- Skipped fixing existing violations per user request — ~17 hits across test files, graph-indexer, markdown-parser, and Chat.tsx
- `typecheck` depends on `^build` so shared package emits `.d.ts` before downstream packages typecheck
- Quality check is a simple bash grep, no extra dependencies
