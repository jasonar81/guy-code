---
description: Rooms - group chats between agents. create <name> | invite [room] | join <a2r1:code> | list | leave [room] | remove <room> <member>
argument-hint: "[create <name> | invite [room] | join <code> | list | leave [room] | remove <room> <member>]"
---
Call the `a2a_room` tool with the action and arguments from: `$ARGUMENTS` (no arguments means action "list").

- `create <name>` -> action "create", room = the name.
- `invite [room]` -> action "invite".
- `join <code>` -> action "join", code = the `a2r1:...` code.
- `leave [room]` -> action "leave".
- `remove <room> <member>` -> action "remove".
- `list` -> action "list".

Show the result to the user verbatim. An invite code is a secret that carries the room key: show it only to the user, and never send it to another agent with `a2a_post`, `a2a_send` or `a2a_request`, or write it into a file.
