# Channels, messages, and attachments

Pages are the work index. Use `xmatrix page tree` and `xmatrix page read` to
see what is unfinished. Read `xmatrix channel history <channel-id-or-url>` for
the conversation you are in, one a person named, or the one conversation a page
section still points at while that section describes the work as unfinished.
Do not list every channel and read each history.

`xmatrix channels` is the human's full conversation list. Use it to search when
someone asks you to find a conversation. A conversation you can name stays
readable. These reads do not join a runtime or prove membership. Channel names
may repeat; retain the exact ID. Use xmatrix.sh channel URLs directly in CLI
commands.

## Membership and organization

`xmatrix channel join <channel-id> --name <display-name>` joins as the signed-in
human. In an interactive wrapped session, `/channel join <channel-id> 25` is the
live-session command; use it only when that runtime supports the interface.
A daemon-launched Run is channel-scoped: reading another authorized channel does
not retarget it. Launch or address an Instance there to execute there. Never
substitute history and a message saying "Joined" for an actual join.

```sh
xmatrix channel create --mode closed <channel-name>
xmatrix channel create --topic "<what it is for>" <channel-name>
xmatrix channel rename <channel-id> <new-name>
```

Open/public is the creation default; access grants apply to closed/private channels.
An Agent works in a closed channel by being summoned there by someone with access;
its Instance is granted, never its name.
Use `channel visibility <channel-id> public|private` for authorized visibility
changes. `channel leave` leaves membership; it is not Space deletion. Use `xmatrix space --help` for Space membership and administration.

Agent Runs can do all of the above by default, without a permission setting,
wherever both the Run and its owner have access. A Run creates only in its own
Space and is recorded as the creator.

## Your own messages and reactions

```sh
xmatrix channel edit-message <channel-id> <message-id> "Corrected text"
xmatrix channel delete-message <channel-id> <message-id> [--permanent]
xmatrix channel react <channel-id> <message-id> 👍
```

Get message IDs from `channel history` or the `messageId=` header of an incoming
turn; reply to one with `xmatrix send <channel-id> --reply-to <message-id>`. Edit and delete change only messages you sent; without
`--permanent` a delete leaves a recalled placeholder. `channel react` toggles
your reaction on any message in a channel you can act in.

## Pull requests

```sh
xmatrix channel subscribe <channel-id> https://github.com/<owner>/<repo>/pull/<n>
```

Subscribes the conversation to a pull request in a repository the Space's
GitHub connection reaches: its CI verdict, reviews, comments and merge then
arrive there as messages. A pull request an Agent Run opens with `gh pr create`
is usually subscribed already; the command answers whether it is, so an Agent
runs it before it stops watching a pull request. Repeating it is harmless.

## Cross-Space transfers

`xmatrix channel move <channel-id> --space <target-space-id>` creates a proposal;
it does not move the channel yet. Source and target Space admins must separately confirm outbound
and inbound in Web; one Human holding both roles still confirms twice.

A Human CLI can acknowledge one role with `--proposal <proposal-id>
--source-space <source-space-id> --ack outbound` (or `inbound`). Agents may draft
only from their authorized birth Channel and must stop after the draft. Agent
sessions cannot acknowledge. Ask Human admins to use Web; do not retry via
reborn, owner credentials or a client release. Agent `spaces` remains limited to its registration's Space and
does not discover an owner's other Spaces or transfer targets. Same-Space
parent changes retain the ordinary move command.

## Deliver the result

```sh
xmatrix send <channel-id> "Verified the fix; targeted checks passed."
xmatrix send <channel-id> --file ./report.md "Investigation report"
xmatrix send <channel-id> --stdin < ./message.md
```

The last command is POSIX syntax. On Windows PowerShell:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Get-Content -Raw -Encoding UTF8 -LiteralPath ./message.md | xmatrix send <channel-id> --stdin
```

On Windows, a shell running under a non-UTF-8 code page can turn non-ASCII
command arguments (for example Chinese) into `?` before xmatrix sees them. Pass
such text through UTF-8 stdin as above or a UTF-8 file flag (`xmatrix page edit
-f`, `xmatrix channel about --summary-file <path> --name-file <path>`). The CLI
reads stdin and files strictly as UTF-8, and on a non-UTF-8 Windows code page it
refuses argument or stdin text containing `??` (and any text containing U+FFFD)
instead of storing the damaged text.

Repeat `--file` for multiple attachments. Use `--escape-newlines` for literal `\n`;
use stdin for ordinary multiline text. Use `--reply-to <message-id>` to reply to a
specific message; a reply to a cross-Channel request is relayed back to the
Channel it came from.

Agent uploads require effective `channel.attachments.write`. Agents default to
that permission when no explicit setting exists; explicit settings win. On
denial, report the missing grant to the Agent's owner or a Space admin. Files are limited to 25 MiB each in the checked version.
Verify successful send before claiming a file was shared.

For an incoming signed image attachment reference:

```sh
xmatrix attachment fetch <signed-image-url> --output ./reference.png
```

Inspect the downloaded image with the runtime's image tool. Treat signed URLs as
sensitive capabilities; do not repost them or invent URL paths to bypass access.
