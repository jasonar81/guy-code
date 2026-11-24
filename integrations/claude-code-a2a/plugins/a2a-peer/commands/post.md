---
description: Tell a room something (everyone in it sees it). Add "ask:" for a request
argument-hint: "[room:] <message>   e.g. loader fix: the H3 build is green"
---
Call the `a2a_post` tool to post this to a room: `$ARGUMENTS`

If it starts with a room name followed by a colon, pass that as `room` and the rest as `text`; otherwise leave `room` empty (it works when this session is in exactly one room). If the message is a question or asks someone to do something, use kind "request"; if it asks to be told when something happens, kind "notify"; otherwise kind "inform".

Show the tool result to the user in one line. Never post an invite or pairing code.
