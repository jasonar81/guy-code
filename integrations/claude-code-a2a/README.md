# a2a-peer: Claude Code plugin for A2A coordination

Lets a Claude Code user pair with colleagues' agents (Guy Code or Claude Code) and run the
docs/a2a/DESIGN.md flows ("tell Dylan's agent...", "have Dylan's agent tell us when...").
It speaks exactly the same protocol as Guy Code: the daemon is built on Guy Code's own
`electron/a2a` modules (see `plugins/a2a-peer/src/shared/protocol.ts`).

## Build (from the guy-code repo root)
```
npm install
node integrations/claude-code-a2a/plugins/a2a-peer/build.mjs
```
This writes `plugins/a2a-peer/dist/` (daemon.js, mcp.js, hook.js, cli.js, sql-wasm.wasm). The
installed plugin needs only `node` >= 20 on PATH, with no `npm install`. `dist/` is gitignored, so
build it before you publish or commit it to the marketplace branch.

## Install
1. `claude plugin validate ./integrations/claude-code-a2a/plugins/a2a-peer`
2. `/plugin marketplace add <path or git url of integrations/claude-code-a2a>`, then
   `/plugin install a2a-peer@ocient-agents`. Set "Your name as shown to peers" when prompted.
3. **Push mode (channels):** `claude --dangerously-load-development-channels plugin:a2a-peer@ocient-agents`.
   Once an org Owner sets `channelsEnabled: true` and allowlists `{plugin:"a2a-peer", marketplace:"ocient-agents"}`,
   use `claude --channels plugin:a2a-peer@ocient-agents` instead.
4. **Without channels** everything still works: messages arrive at the next prompt
   (UserPromptSubmit hook) and at session start. `/a2a-peer:status` says which mode you are in.

## Commands
`/a2a-peer:peers`, `/a2a-peer:inbox`, `/a2a-peer:tasks`, `/a2a-peer:pair [code]`,
`/a2a-peer:trust <peer> <level> [for 8h]`, `/a2a-peer:log [n]`, `/a2a-peer:status [label <text>]`.

## Where state lives
`${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/a2a-peer-ocient-agents/`): `a2a.db`, `secrets.json` (0600),
`daemon.json` (0600), `audit.jsonl`, and optionally `config.json` (`displayName`, `port`, `bind`,
`allowCidrs`, `advertiseHost`). The daemon keeps running after Claude Code exits so peers can still
reach you and watches keep running; stop it with the pid in `daemon.json`.

## Firewall
The daemon listens on port 7427 on your VPN address. On a managed Windows machine, an inbound
firewall policy may block it (you will see a "Windows Defender Firewall has blocked some features
of Node.js" prompt). Then peers cannot reach you until IT allows inbound TCP 7427 for node.exe from
the VPN range. Outbound (your sends) is unaffected.
