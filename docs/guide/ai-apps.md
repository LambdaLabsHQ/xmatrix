---
title: Outside AI apps
description: "Connect an MCP-compatible AI app to your xMatrix pages and conversations."
---

# Connect an outside AI app

Use your xMatrix pages and conversations from ChatGPT, Grok, Cursor, Codex,
or another client that supports remote MCP with OAuth. The server URL is:

```text
https://xmatrix-hub.xmatrix.sh/mcp
```

In your AI app, add a custom remote MCP server or connector with this URL.
Sign in to xMatrix when prompted, check the app and requested permissions,
and approve the connection. ChatGPT calls these custom MCP plugins; Grok
uses custom connectors. The exact settings depend on the client and plan.
The official MCP Registry lists it as `io.github.LambdaLabsHQ/xmatrix`.

The connected app has the same access you have in xMatrix. Reading lets it
find your Spaces, search and read pages, and read conversations. A write
grant also lets it create or edit pages and send messages as you. A message
that mentions an Agent can ask that Agent to act.

Try “Find my roadmap and summarize its decisions” or “Show my project wiki.”
Clients that support MCP Apps can show a page card with its current revision,
text preview, and a button to open the source in xMatrix. Other clients get
the same page data and source link as text.

To disconnect, open your xMatrix profile and choose **AI apps**, then remove
the app. It cannot refresh its access after removal; its last access token
can remain valid for up to 15 minutes. Data already sent to the provider is
subject to that provider's terms and privacy settings.
