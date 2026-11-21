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
The daemon listens on port 7427 on your VPN address, so Windows shows the "Windows Defender
Firewall has blocked some features of Node.js" prompt the first time it starts. Declining is safe:
outbound still works, so you can send and ask, but peers cannot reach you, which means their
replies, pushes and watch results arrive only when you next contact them.

**You can usually fix this yourself - you do not necessarily need IT.** On Windows you need to be
a local administrator, and your organisation must not push a firewall policy that discards local
rules. Check both:

```powershell
# Local administrator?
(New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent())
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# Does a group policy override local rules?  AllowLocalPolicyMerge = 0 means your
# own rules are ignored no matter how they look in the UI. No key at all = fine.
Get-ChildItem HKLM:\SOFTWARE\Policies\Microsoft\WindowsFirewall -ErrorAction SilentlyContinue
```

Then, from an **elevated** PowerShell, add a rule scoped as tightly as you can. Check which profile
your VPN adapter is on first (`Get-NetConnectionProfile`) - a corporate VPN is usually `Private` or
`Domain`, and a rule on the wrong profile does nothing:

```powershell
New-NetFirewallRule -DisplayName "A2A peer (inbound 7427)" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 7427 `
  -Profile Private -RemoteAddress 10.0.0.0/8 `
  -Program "C:\Program Files\nodejs\node.exe"
```

`-Profile Private` keeps the port shut on public Wi-Fi, `-RemoteAddress` matches the default
`allowCidrs`, and `-Program` limits it to the one executable. Point `-Program` at the binary that
actually listens: `node.exe` for this plugin's daemon, or `Guy Code.exe` in
`%LOCALAPPDATA%\Programs\Guy Code\` for Guy Code's own endpoint.

If you declined the prompt, Windows will have added Block rules that shadow any Allow you add on
the same profile. Remove them first:

```powershell
Get-NetFirewallRule -DisplayName "Node.js JavaScript Runtime" | Remove-NetFirewallRule
```

Ask IT only if you are not an administrator, or if `AllowLocalPolicyMerge` is 0.
