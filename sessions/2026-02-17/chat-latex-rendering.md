# Add LaTeX Rendering to Chat Agent

**Date:** 2026-02-17
**Duration:** ~5 minutes
**Scope:** Enable LaTeX math rendering in the chat assistant's markdown output

## Summary

Added KaTeX-based LaTeX rendering to the chat agent so mathematical expressions (inline `$...$` and display `$$...$$`) are properly rendered. This involved installing remark-math + rehype-katex and wiring them into the existing `MarkdownTextPrimitive` component.

## Changes

### packages/web
- **`src/pages/Chat.tsx`** — Imported `remark-math`, `rehype-katex`, and KaTeX CSS. Passed `remarkPlugins` and `rehypePlugins` props to `MarkdownTextPrimitive`.
- **`package.json`** — Added `remark-math`, `rehype-katex`, `katex` as dependencies; `@types/katex` as devDependency.

## Verification

- TypeScript build (`tsc --noEmit`) passes with no errors.
- No runtime verification done yet — needs manual testing in the browser with a math-heavy chat response.

## Decisions & Notes

- Used KaTeX over MathJax for lighter bundle size and faster rendering.
- The backend system prompt may need updating to instruct the LLM to use `$...$` / `$$...$$` delimiters consistently for math expressions.
- KaTeX CSS is imported globally via the Chat page; if LaTeX is needed elsewhere later, the import could move to a higher-level entry point.
