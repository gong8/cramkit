Run `pnpm check` to find all failures, then fix them all with parallel agents.

Use `mode: bypassPermissions` for all agents.

---

## Phase 1: DISCOVERY (you do this yourself)

Run `pnpm check` to collect all failures. Since `pnpm check` is `pnpm lint && pnpm typecheck && pnpm quality && pnpm test` and stops at the first failure due to `&&`, run each sub-command independently to collect ALL errors:

1. Run `pnpm lint 2>&1` — capture Biome lint/format errors
2. Run `pnpm typecheck 2>&1` — capture TypeScript type errors
3. Run `pnpm quality 2>&1` — capture quality check errors
4. Run `pnpm test 2>&1` — capture test failures

Run all 4 in parallel since they're independent.

After all 4 complete, parse the output and group failures by file. For each command:

- **Lint errors**: Biome reports file paths and specific rule violations. Group by file.
- **Type errors**: TypeScript reports `file(line,col): error TS...`. Group by file.
- **Quality errors**: Script reports violations. Group by file.
- **Test failures**: Vitest reports which test files failed and the error messages. Group by test file and the source file it tests.

If there are zero total failures across all 4, report "All checks pass!" and stop.

---

## Phase 2: FIXING (parallel agents)

Group related failures together — if a single file has both lint and type errors, combine them into one agent task. If multiple files are tightly coupled (e.g., a source file and its test), assign them to the same agent. Aim to minimize the number of agents while keeping each agent's scope focused.

Launch one `general-purpose` agent per group, all in parallel in a single message. Each agent gets `mode: bypassPermissions`.

### Agent prompt template

For each agent, use this prompt template (fill in the specifics):

```
Fix the following errors in the CramKit codebase.

## CramKit Code Style
- Formatter/Linter: Biome (not ESLint/Prettier)
- Indent: Tabs
- Quotes: Double quotes
- Semicolons: Always
- Line width: 100
- Imports: Use `.js` extensions in relative imports (ESM)
- TypeScript: Strict mode

## Files to fix
{list of files}

## Errors to fix
{paste the exact error output for these files}

## Rules
- ONLY fix the reported errors — do not refactor, clean up, or "improve" surrounding code
- Do NOT add comments, docstrings, or type annotations beyond what's needed to fix errors
- Do NOT change functionality
- Do NOT modify files outside your assigned scope
- If a lint error is about formatting, fix the formatting
- If a type error requires changing a type, make the minimal change needed
- If a test failure is due to a source code bug, fix the source code
- If a test failure is due to a broken test expectation, fix the test
- After making fixes, run the relevant check command to verify your fixes work:
  - For lint errors: `pnpm lint`
  - For type errors: `pnpm typecheck`
  - For quality errors: `pnpm quality`
  - For test failures: `pnpm test`
```

---

## Phase 3: VERIFICATION (you do this yourself)

After ALL fix agents complete:

1. Run `pnpm lint:fix` — auto-fix any remaining Biome issues
2. Run `pnpm check` — the full check suite

If anything still fails:
- Read the remaining errors
- If there are only a few, fix them yourself directly
- If there are many, launch another round of parallel fix agents (repeat Phase 2)
- Keep iterating until `pnpm check` passes cleanly

---

## Final Report

When `pnpm check` passes, report:
- Total errors found in Phase 1
- How many agents were launched
- How many rounds of fixing were needed
- Any errors you had to fix manually in Phase 3
