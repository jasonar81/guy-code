---
description: A2A status - daemon, endpoint, delivery mode (channel or hook), session label. "label <text>" names this session for peers
argument-hint: "[label <text>]"
---
If the arguments below start with "label", run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" label <the rest of the arguments>` with the Bash tool. Otherwise run:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" status
```

Show the output to the user verbatim. If the delivery mode says hook mode, add one line: messages from other agents arrive on the user's next prompt; for push delivery start Claude Code with `--dangerously-load-development-channels plugin:a2a-peer@ocient-agents` (or `--channels plugin:a2a-peer@ocient-agents` once an org Owner has allowlisted it).

Arguments: $ARGUMENTS
