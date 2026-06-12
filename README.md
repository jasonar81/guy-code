# Guy Code

Cross-platform Claude Code-compatible desktop app. Coexists with Claude Code;
reads `~/.claude/` data read-only. Designed for autonomous parallel work
across many projects with sub-50ms project switching, per-project cost
tracking, and a rolling-hour budget governor.

See [`DESIGN.md`](./DESIGN.md) for the locked spec.

## Quick start

```powershell
npm install
npm run dev
```

The first launch will scan `~/.claude/projects/` and backfill cost data into
`%USERPROFILE%\.guycode\guycode.db`. Subsequent launches incrementally update.

## Phase status

- **Phase 1** (in progress): scaffold + project import + cost pills + fast switch
- **Phase 2**: Anthropic API + tool loop
- **Phase 3**: state machine + watchers + budget governor
- **Phase 4**: memory + audit trail
- **Phase 5**: Monaco + xterm + MCP + computer-use

## Layout

```
guy-code/
├── DESIGN.md              # Locked design spec
├── electron/              # Main process (Node)
│   ├── main.ts            # App lifecycle, BrowserWindow
│   ├── preload.ts         # contextBridge
│   ├── ipc.ts             # Renderer IPC handlers
│   ├── db.ts              # SQLite schema + queries
│   ├── claudeImport.ts    # Read ~/.claude/ JSONL → DB
│   └── pricing.ts         # Model → cost table
└── src/                   # Renderer (React)
    ├── main.tsx
    ├── App.tsx
    ├── components/
    └── lib/
```
