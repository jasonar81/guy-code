# Guy Code — Design (locked v1)

> Working name. French rename TBD. Electron + React + TS desktop app that
> coexists with Claude Code, reads its data read-only, and drives sessions
> directly against the Anthropic Messages API.

## Pillars

1. **Maximum autonomy.** Default mode is `bypassPermissions`. Zero mid-stream
   approval modals, ever. The model breaks autonomy only via the explicit
   `WaitForUser(question)` tool. Hard guards exist for catastrophic actions but
   are silenceable per-category.
2. **Make parallel work scannable.** Sidebar separates "Needs You" from
   "Running on its own" so the user can sweep the queue, click the most
   urgent item, respond, move on.
3. **Sub-50ms project switching.** All open project panes pre-mounted; switch
   is a CSS visibility toggle. No unmount, no refetch, no PTY restart.
4. **Cost transparency per project.** Persistent cost pills (all-time + rolling
   24h) on every project row. Backfilled from existing `~/.claude/projects/**/*.jsonl`.
5. **Rolling-hour budget governor.** One number (`$/hr`); projects sleep and
   resume automatically to respect it.
6. **Session continuity across restart.** Projects in `running` /
   `waiting-on-system` resume on launch. Only `waiting-on-user` blocks.
7. **Inherit Claude Code's memory.** Read MEMORY.md + `feedback_*` /
   `project_*` / `user_*` / `reference_*` leaves; write back so insight is
   shared with Claude Code.

## Stack

| Layer | Choice |
|---|---|
| Shell | Electron 33+ |
| Build | Vite + `vite-plugin-electron` |
| UI | React 18 + TypeScript + TailwindCSS + Lucide icons |
| State | Zustand |
| Local DB | better-sqlite3 |
| Terminal | xterm.js + node-pty (Phase 5) |
| Editor / diff | Monaco (Phase 5) |
| LLM | `@anthropic-ai/sdk`, key in Windows Credential Manager (`keytar`) |
| MCP | `@modelcontextprotocol/sdk` (Phase 5) |

Default model: **`claude-opus-4-7[1m]`** for everything. No model routing.

## Data on disk

- `~/.claude/` — read-only mirror, never written.
- `%USERPROFILE%\.guycode\` — our own data:
  - `guycode.db` — SQLite (projects, usage, watchers, audit, settings)
  - `state/<project>/current.json` — runtime state per project
  - `state/<project>/watchers/<id>.json` — persisted watchers
  - `state/<project>/blobs/` — large tool results (referenced from DB)
  - `logs/` — electron-log output

## State machine

```
idle ─(user message)→ running
running ─(WaitForUser)→ waiting-on-user
running ─(WaitFor{File,Process,Time,Http})→ waiting-on-system
running ─(error after retries)→ error
running ─(stop_reason: end_turn, completion)→ waiting-on-user (review)
running ─(budget exceeded)→ sleeping-budget
sleeping-budget ─(budget freed)→ running
waiting-on-system ─(watcher fires)→ running
waiting-on-user ─(user replies)→ running
error ─(user retries)→ running
* ─(user pauses)→ idle
```

Sidebar groups:
- **NEEDS YOU**: `waiting-on-user`, `error` — sorted oldest-first
- **RUNNING**: `running`, `waiting-on-system`, `sleeping-budget`
- **IDLE**: `idle`

## Cost model

Per-turn costs computed from `message.usage`:

```
cost = (input_tokens          * price.input)
     + (cache_read_input_tokens * price.cache_read)
     + (cache_creation_5m       * price.cache_write_5m)
     + (cache_creation_1h       * price.cache_write_1h)
     + (output_tokens           * price.output)
```

Prices live in `electron/pricing.ts` keyed by model id. Stored in DB as
integer micros (`cost_usd_micros`).

### Rolling 1h budget governor
Sliding 60-min total spend across all projects. Before each turn, project
its post-turn spend; if it would exceed the cap, transition the project to
`sleeping-budget`. Wake sleepers FIFO as old spend ages out of the window.

## Cache architecture

Four cache breakpoints per request, in fixed order, never reshuffled:
1. Tool definitions (deterministic JSON)
2. System prompt skeleton
3. Project static context (CLAUDE.md hierarchy, frozen at session start)
4. Conversation history (only this breakpoint advances)

All four marked `cache_control: ephemeral`. Tool list changes only at session
boundary. Skill auto-injection appends, never inserts.

## Tool output ephemeralization

Three tiers:
- **Tier 1** (verbatim): most recent result of each tool
- **Tier 2** (synopsis): older results replaced by deterministic 1-liner
  `[Bash#3 exit=1, 8.2KB stderr, ref:tr_abc123]`
- **Tier 3** (dropped from context): older or larger than threshold; stays
  on disk (blobs dir), addressable by `ref:` id, viewable in UI

Synopses are deterministic so they don't bust cache.

## Compaction

Continuous: ephemeralization (above) is always on.
Threshold: at 200k input tokens, fire compaction agent → `state_summary.md`,
fresh context, original JSONL preserved as `<sid>.pre-compact-<n>.jsonl`.
Visible "Compacted at turn N — view original" pill in timeline.

## Memory

Loaded automatically on session start:
- `<repo>/CLAUDE.md` (walk cwd → repo root)
- `<repo>/.claude/CLAUDE.md` if present
- `~/.claude/CLAUDE.md` if present
- `~/.claude/projects/<slug>/memory/MEMORY.md` (full)

On-demand via synthetic `recall_memory(query)` tool: simple substring + small
embedding match over MEMORY.md leaf descriptions. Loaded leaves displayed in
right pane so it's observable.

## Audit trail

Every tool call logged to `audit_events` table with full input + output ref.
Hard-guard auto-allows show 🔇 icon. Filterable, searchable.

## Bulk-edit staging (default)

`Edit`/`Write`/`MultiEdit` stage in a per-turn diff stack. Right pane shows
aggregate PR-style diff. Auto-applies on turn complete unless user clicks
"Rewind turn". Configurable to streaming or never-auto.

## Imports on first launch

From `~/.claude/projects/`: every JSONL → projects table + usage_events
backfill (track imported file path+mtime to avoid re-import).

From `~/.claude.json`: `mcpServers` block → our settings (read-only mirror;
we maintain our own override file).

From `%APPDATA%\Claude\claude_desktop_config.json` if present: same.

We never write to `~/.claude/`.

## Phase plan

- **P1** (current): scaffold, sidebar, project import, cost pills, fast switch
- **P2**: Anthropic API client, streaming, minimal tool loop (Read, Write,
  Edit, Bash, Grep, Glob, TodoWrite, WaitForUser), cache_control on prefix
- **P3**: full state machine + WaitFor{File,Process,Time,Http} + watchers +
  restart resume + rolling-hour budget governor
- **P4**: memory loader + recall_memory + audit trail UI + skills
- **P5**: bulk-edit stage UX + Monaco diff + MCP host + xterm/PTY +
  computer-use (Playwright)

## Open settings (all configurable)

- `model` (default `claude-opus-4-7[1m]`)
- `defaultMode` (default `bypassPermissions`)
- `compaction.continuousEphemeralization` (default `on`)
- `compaction.stateSummaryThresholdTokens` (default `200000`)
- `bulkEdit.mode` (default `stage-and-auto-apply`)
- `budget.rollingHourCapUsd` (default `null` = no governor)
- `safety.hardGuards.silenced` (per-category list)
- `notifications.style` (default `in-app-only`)
