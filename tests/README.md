# Tests

## Running

```pwsh
# Run all tests once
npm test

# Watch mode (re-runs on file change)
npm run test:watch

# Coverage report (opens in ./coverage/index.html)
npm run test:coverage

# Vitest UI (interactive browser inspector)
npm run test:ui
```

## What's covered

| File | Module under test | What we pin down |
|---|---|---|
| `tests/budget.test.ts` | `electron/budget.ts` | Hourly-bucket precheck (all 5 decision branches), per-key isolation, in-flight reservation, cap math (`daily / 24`), legacy setting fallback, force-resume one-shot, sessionHasTurnInCurrentHour |
| `tests/pricing.test.ts` | `electron/pricing.ts` | Per-model price lookup, suffix/date-tag stripping, family fallback (opus/sonnet/haiku), cache-write multipliers (5m=1.25×, 1h=2.0×), cache-read=0.10×, cost computation rounding |
| `tests/format.test.ts` | `src/lib/format.ts` | USD formatting at every magnitude, token compaction, relative time, absolute time labels, dateGroupLabel, sessionDisplayTitle fallback chain |
| `tests/compaction.test.ts` | `electron/compaction.ts` | `estimateTokens` for string/blocks/tool_use/tool_result content, ceil-rounding |
| `tests/ephemeralize.test.ts` | `electron/ephemeralize.ts` | Tier 1 verbatim (latest per tool, recent), Tier 2 synopsis, Tier 3 drop-too-large, deterministic synopsis hashes, error tagging |
| `tests/memory.test.ts` | `electron/memory.ts` | `claudeSlugForCwd` (Windows + POSIX), `recallFromBundle` substring search with header preservation and result cap |
| `tests/store.test.ts` | `src/lib/store.ts` | TodoWrite → currentTodos: first plan, wholesale replacement, empty-array clears, malformed leaves alone, drops invalid items, non-TodoWrite tools don't touch the plan |
| `tests/CurrentPlanPanel.test.tsx` | `src/components/CurrentPlanPanel.tsx` | Renders nothing when empty / null, item list rendering per status, N/M progress count, collapse toggle, plan replacement reflected |
| `tests/subagent.test.ts` | `electron/subagent.ts` | Role tool subset enforcement (no Task/Plan/Execute/Review recursion, no TodoWrite, no WaitForUser), end_turn → final text, tool_use round-trip, refusal of disallowed tool names, abort propagation, budget pre-flight blocking, MAX_SUBAGENT_ROUNDS cap, role-specific system prompt, server-side context_management config |

## Test discipline

- **Tests own the spec.** When the budget logic is rewritten (it has been three times), the test file is the source of truth for what behavior should be preserved. Add a test for any bug fix BEFORE you ship the fix.
- **No tests are deleted to make the build pass.** If a test fails after a refactor, either the test is wrong (rare, fix it) or the refactor broke a behavior we promised to keep (common, fix the code).
- **Mocking strategy.** SQLite (`./db`) is mocked in budget tests so we don't need a real database. `electron-log` is stubbed globally in `tests/setup.ts`. `window.api` is stubbed per-test for renderer tests.
- **Component tests use happy-dom + RTL.** Auto-cleanup is wired in `tests/setup.ts` so DOM doesn't bleed between tests.

## Gaps (intentional, for now)

- **Agent loop end-to-end.** Mocking the Anthropic SDK + tool dispatch + JSONL append + IPC broadcast for a full turn would be a big effort. Smaller pieces are tested via budget/store/ephemeralize.
- **MCP integration.** Requires either real subprocesses (slow + flaky) or a custom transport mock; deferred.
- **Auto-scroll behavior in MessageList.** Virtuoso's measurement loop is hard to test in happy-dom (no actual layout); manual UAT is the current verification.
- **Database migrations.** Schema changes get verified by manual smoke tests on a real `~/.guycode/guycode.db`. A migration test using an in-memory SQLite is a good follow-up.

When adding a test, name it after the module: `tests/<module>.test.ts(x)`. The vitest config picks them up automatically.
