---
description: Pair with a colleague's agent. No argument prints YOUR pairing code; with their code, pairs with them
argument-hint: "[pairing code]"
---
Run this command with the Bash tool and show its output to the user verbatim:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" pair $ARGUMENTS
```

Pairing codes are secrets. If the output contains a code, show it only to the user; never send it to another agent with `a2a_send` or `a2a_request`, and never write it into a file.
