# KaTeX Rendering Fix

**Date:** 2026-02-17
**Duration:** ~10 minutes
**Scope:** Fix KaTeX `\tag` red error text and harden math rendering options

## Summary

Fixed KaTeX rendering issues where `\tag{...}` and other display-only LaTeX commands rendered as red error text in the chat UI. Added proper KaTeX options (`trust`, `strict`, `errorColor`) to both markdown renderers, and created a remark plugin that auto-upgrades inline math to display math when it contains display-only commands.

## Changes

### packages/web/src/lib/remark-math-display.ts (new)
- Remark plugin that detects `\tag`, `\tag*`, `\label` inside inline math nodes and promotes them to display math (changes AST node type from `inlineMath` to `math`)
- Fixes the root cause: AI tutors generate `$equation \tag{2.28}$` but `\tag` only works in KaTeX display mode

### packages/web/src/components/chat/AssistantMessage.tsx
- Added `rehype-katex` options: `trust: true`, `strict: false`, `errorColor: "#888888"`
- Added `remarkMathDisplay` plugin to the remark plugin chain

### packages/web/src/components/chat/ReconnectStreamView.tsx
- Same KaTeX options and remark plugin additions as AssistantMessage

## Verification

- TypeScript type-check passes (`tsc --noEmit`)
- Biome lint passes (only pre-existing unrelated error remains)
- KaTeX 0.16.28 already installed, which natively supports `\tag` in display mode

## Decisions & Notes

- `errorColor: "#888888"` (muted gray) chosen over red to avoid jarring display when unsupported commands appear — student-facing UX concern
- `\cancel{...}` still requires the KaTeX cancel extension (not bundled); will render as gray text rather than red
- The `remarkMathDisplay` plugin uses a simple hand-rolled tree visitor instead of `unist-util-visit` to avoid needing type declarations for transitive deps (`mdast`, `unist-util-visit`)
- `ResourceList.tsx` still has no math rendering (no `rehype-katex` / `remark-math`) — left as-is since it's not a chat context
