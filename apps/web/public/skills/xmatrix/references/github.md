# GitHub channel actions

xMatrix's GitHub App delivers repository activity and executes configured writes.
This is the xMatrix Space connection, not a local coding-agent plugin. Connection
setup and repository approval happen in Space Apps and GitHub's installation flow.
Do not ask for a PAT in chat.

Verify the connection is available for the target channel and repo. Use full
`owner/repo` unless a default repo is known. Send only the operation authorized by
the user as a channel message:

| Intent | Message body |
|---|---|
| Subscribe to an issue or PR | `@github:subscribe:OWNER/REPO:#42` |
| Subscribe to repo events | `@github:subscribe:OWNER/REPO all` |
| Remove selected features | `@github:unsubscribe:OWNER/REPO reviews` |
| Import into a work channel | `@github:issue_to_channel:OWNER/REPO:#42` |
| Import into a thread | `@github:issue_to_thread:OWNER/REPO:#42` |
| Post a comment | `@github:comment:OWNER/REPO:#42 <body>` |
| Create an issue | `@github:create_issue:OWNER/REPO <title>` with body on following lines |
| Close or reopen | `@github:close_issue:OWNER/REPO:#42` / `@github:reopen_issue:OWNER/REPO:#42` |

Repo subscriptions support `issues`, `pulls`, `comments`, `reviews`, `commits`,
`checks`, `status`, and `releases`; `all` selects all eight. Omitting features uses
the `issues comments` default. Repo subscriptions deliver future events without
backfilling old items; individual imports bring source context and comments.
Subscribe only to needed features.

Writes require an enabled action/channel and the GitHub installation capability.
A successful subscription does not authorize comments or issue changes. Inspect
the App execution result and source URL before reporting success. On failure,
report the needed connection setting or GitHub access upgrade; do not retry with
unrelated credentials. Inspect current App completion for additional actions such
as reviews rather than guessing arguments.
