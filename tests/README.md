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
| `tests/budget.test.ts` | `electron/budget.ts` | Hourly carry-over model: settle-on-read math (user's H1→H2→H3 worked example, multi-hour offline gap collapsed via closed-form SQL), per-call precheck (all 5 decision branches), per-key isolation, base/effective hour cap, idempotent settlement within a single hour, negative effective caps preserved, exemption fires even when cap is negative, reset zeroes adjustment without deleting usage_events, force-resume one-shot, sessionHasCallInCurrentHour |
| `tests/pricing.test.ts` | `electron/pricing.ts` | Per-model price lookup, suffix/date-tag stripping, family fallback (opus/sonnet/haiku), cache-write multipliers (5m=1.25×, 1h=2.0×), cache-read=0.10×, cost computation rounding |
| `tests/format.test.ts` | `src/lib/format.ts` | USD formatting at every magnitude, token compaction, relative time, absolute time labels, dateGroupLabel, sessionDisplayTitle fallback chain |
| `tests/compaction.test.ts` | `electron/compaction.ts` | `estimateTokens` for string/blocks/tool_use/tool_result content, ceil-rounding |
| `tests/ephemeralize.test.ts` | `electron/ephemeralize.ts` | Tier 1 verbatim (latest per tool, recent), Tier 2 synopsis, Tier 3 drop-too-large, deterministic synopsis hashes, error tagging |
| `tests/memory.test.ts` | `electron/memory.ts` | `claudeSlugForCwd` (Windows + POSIX), `recallFromBundle` substring search with header preservation and result cap |
| `tests/store.test.ts` | `src/lib/store.ts` | TodoWrite → currentTodos: first plan, wholesale replacement, empty-array clears, malformed leaves alone, drops invalid items, non-TodoWrite tools don't touch the plan |
| `tests/CurrentPlanPanel.test.tsx` | `src/components/CurrentPlanPanel.tsx` | Renders nothing when empty / null, item list rendering per status, N/M progress count, collapse toggle, plan replacement reflected |
| `tests/subagent.test.ts` | `electron/subagent.ts` | Role tool subset enforcement (no Task/Plan/Execute/Review recursion, no TodoWrite, no WaitForUser), end_turn → final text, tool_use round-trip, refusal of disallowed tool names, abort propagation, budget pre-flight blocking, MAX_SUBAGENT_ROUNDS cap, role-specific system prompt, server-side context_management config, plan/general roles get WebFetch + web_search while execute/review do not |
| `tests/toolSummarizer.test.ts` | `electron/toolSummarizer.ts` | Pass-through (small outputs, errors, NEVER_SUMMARIZE list including skill/Plan/TodoWrite/Task/Execute/Review), per-tool summary shapes (Bash head+tail+marker counts, Read line counts, Grep top-files breakdown, Glob bucketing, WebFetch title preservation), archive sidecar JSON metadata, input preview truncation, archive path embedded in summary, cleanup sweep deletes >30d files, removes empty session dirs, preserves fresh files |
| `tests/webFetch.test.ts` | `electron/webFetch.ts` | Input validation (empty / non-http URLs reject without fetching), HTTP error → `error: HTTP nnn` strings (not throws), AbortError → timeout classification, Readability extraction emits canonical `Title:` / `URL:` headers, fallback to body.textContent for login-shaped pages, plain text / JSON pass-through with metadata header, 5 MB body cap enforced via streaming reader (cancels mid-stream) |
| `tests/skills.test.ts` | `electron/skills.ts` | Discovery walks all four roots (`~/.guycode/skills`, `<cwd>/.guycode/skills`, `<cwd>/.claude/skills`, `~/.claude/skills`) plus legacy `~/.claude/commands`, name-collision policy (first hit wins, loser shadowed), frontmatter parsing (quoted values, missing fields, no frontmatter), both layouts (`SKILL.md` in dir + flat `*.md`), slash-command parser strict on path-y forms (`/usr/bin`, `//comment`, `/foo/bar`) and lenient on whitespace/multi-line context, system-prompt block sorted by name with description truncation |
| `tests/planManager.test.ts` | `electron/planManager.ts` | TodoWrite auto-creates active plan when none exists, updates in place when one exists (preserves plan id), preserves status by step id (in_progress survives a routine pending update), allows in_progress → completed transitions, drops empty-content todos and assigns missing ids; PlanState refuses complete/abandon without active plan or outcome_summary, completes/abandons set state + summary, start_new with active plan rotates atomically (one row goes to completed/abandoned, new row goes to active, unique-active-per-session invariant holds), start_new without active just creates, start_new requires next_title + non-empty next_steps + previous_outcome (when active), multi-session isolation; formatActivePlanBlock emits ACTIVE PLAN header + per-step lines + tool reminder, includes inline notes, handles zero-step plan |

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
