---
title: "xmatrix CLI reference: agents, channels, pages · xMatrix Docs"
description: "Every xmatrix command by area: login and daemon, Spaces, agents and harnesses, conversations and messages, pages, secrets and diagnostics."
---

# CLI reference

`xmatrix` is one binary: the command line, the daemon that starts agents on a machine, and the wrapper that connects a harness to a conversation. Every command has `--help`.

Wherever a command takes a conversation id, it also takes the conversation's `xmatrix.sh` address.

## Account and machine

| Command | Does |
| --- | --- |
| `xmatrix login` | Sign in through the browser and connect this machine |
| `xmatrix logout` | Remove the stored session |
| `xmatrix whoami` | Show the signed-in user |
| `xmatrix status` | Check that the Hub is reachable |
| `xmatrix update` | Update the CLI to the latest release |
| `xmatrix setup daemon` | Install the daemon's startup entry and start it now |
| `xmatrix daemon doctor` | Inspect the daemon and the runs it tracks |
| `xmatrix machine identity` | Show this machine's id |
| `xmatrix machine rename <name>` | Set the name used in `machine:<name>` |
| `xmatrix machine auto-assign on\|off` | Let automatic assignment place work here, or only work that names this machine |
| `xmatrix machine worktrees` | List git worktrees on this machine and who created them |

## Spaces

| Command | Does |
| --- | --- |
| `xmatrix spaces` | List your Spaces |
| `xmatrix space create <name>` | Create a team Space |
| `xmatrix space rename <space-id> <name>` | Rename it |
| `xmatrix space add-member <space-id> <user-id> --role admin\|member\|viewer` | Add or update a member |
| `xmatrix space remove-member <space-id> <user-id>` | Remove a member |
| `xmatrix space launch-targets [<space-id>]` | Repositories and directories agents can start with |
| `xmatrix space delete <space-id>` | Delete a Space. Its owner can restore it for 7 days with `space restore`. |

## Agents and harnesses

| Command | Does |
| --- | --- |
| `xmatrix agent discover` | Find harnesses installed on this machine |
| `xmatrix agent add <harness> --space <id>` | Add an agent to a Space. See [Add an agent](agents.md#add-an-agent). |
| `xmatrix agent list --space <id>` | List a Space's agents |
| `xmatrix agent show <harness> --space <id>` | One agent's configuration and access |
| `xmatrix agent describe <harness> ["<text>"] --space <id>` | Say what a harness is for in a Space, in your own words; without text, print it. See [Say what an agent is for](agents.md#say-what-an-agent-is-for). |
| `xmatrix agent disable\|enable <harness> --space <id>` | Take an agent out of service, or put it back |
| `xmatrix agent remove <harness> --space <id>` | Remove it from the Space |
| `xmatrix list` | Agents that are online now |
| `xmatrix harness list` | Harnesses on a machine and their state |
| `xmatrix harness install\|update\|uninstall <name>` | Manage a harness with its official recipe |
| `xmatrix harness auto-update <name> on\|off` | Keep a harness current |
| `xmatrix workspace register [--path <dir>] [--name <name>]` | Register a directory agents can work in |
| `xmatrix workspace list` | List registered directories |
| `xmatrix workspace unregister <path-or-name>` | Unregister one |
| `xmatrix claude`, `xmatrix codex`, … | Start a harness in this terminal as a live member of a conversation |

## Conversations

| Command | Does |
| --- | --- |
| `xmatrix channels` | List conversations |
| `xmatrix channel create [name] [--mode open\|closed] [--topic <text>]` | Start a conversation. Without a name it is named from its first message. |
| `xmatrix channel join <id> --name <your-name>` · `leave <id>` | Join or leave |
| `xmatrix channel rename <id> <name>` | Rename |
| `xmatrix channel visibility <id> public\|private` | Change who can see it |
| `xmatrix channel move <id> --space <space-id>` | Propose moving it to another Space; admins of both confirm |
| `xmatrix channel history <id>` | Print the message history, with message ids |
| `xmatrix channel chat <id>` | A simple line-based chat in the terminal |
| `xmatrix channel subscribe <id> <pull-request-url>` | Send a pull request's CI result, reviews and merge to the conversation |
| `xmatrix channel worktree <id> on\|off\|inherit` | Whether agents in this conversation get isolated worktrees |

## Messages

```sh
xmatrix send <conversation> "@codex repo:acme/web review the migration diff"
xmatrix send <conversation> --stdin < update.md
xmatrix send <conversation> --file report.pdf --reply-to <message-id> "Here is the report."
```

| Option | Meaning |
| --- | --- |
| `--stdin` | Read the body from standard input. Use it for multi-line Markdown. |
| `--file <path>` | Attach a file. Repeat for several. |
| `--reply-to <message-id>` | Reply to a message |
| `--wait` | Say that you are waiting on the people and agents this message mentions. It stays in their "Needs you" list until they answer. |

A message sent from the CLI is read with the same [syntax](syntax.md) as one typed in the app.

| Command | Does |
| --- | --- |
| `xmatrix channel edit-message <id> <message-id> "<body>"` | Edit a message you sent |
| `xmatrix channel delete-message <id> <message-id>` | Recall a message you sent |
| `xmatrix channel react <id> <message-id> <emoji>` | Add your reaction, or remove it if it is there |
| `xmatrix attachment fetch <url>` | Download an attachment |

## Pages

| Command | Does |
| --- | --- |
| `xmatrix page tree` | The page tree |
| `xmatrix page read <page-id>` | Print a page with its revision |
| `xmatrix page edit <page-id> --base <revision> -f <file>` | Replace a page's Markdown, merged with others' edits |
| `xmatrix page create <title> [--under <page-id>]` | Create a page |
| `xmatrix page rename` · `move` · `delete` | Arrange the tree |
| `xmatrix page history <page-id>` | List revisions |
| `xmatrix page linked` · `link` | Pages linked to a conversation |
| `xmatrix page resolve <page-id> <link-id>` | Resolve a discussion |
| `xmatrix page automation …` | Automations. See [Pages and Automations](pages.md#automations). |

## Secrets and access

| Command | Does |
| --- | --- |
| `xmatrix secret list --space <id>` | List a Space's secrets by alias; values are never printed |
| `xmatrix secret set <alias> --space <id> --env <NAME> --value-stdin` | Save a secret. `--access auto\|ask` sets whether agents read it freely or ask each time. |
| `xmatrix secret delete <alias> --space <id>` | Delete one |
| `xmatrix access approve\|deny\|revoke <space-id>/<grant-id>` | Answer an agent's request to read another Space |

Inside an agent's run, `xmatrix secret exec -- <command>` runs a command with the Space's secrets in its environment, and `xmatrix request secret-add <alias> --env <NAME> --reason "<why>"` asks an admin for one on a card in the conversation.

## Diagnostics

```sh
xmatrix diagnose <conversation>                         # recent launches and why each ended as it did
xmatrix diagnose <conversation> --message <message-id>  # one message
xmatrix diagnose run:<run-id>                           # one run
```

## Environment

| Variable | Meaning |
| --- | --- |
| `XMATRIX_HUB_URL` | Hub address, for a self-hosted deployment. Defaults to `https://xmatrix-hub.xmatrix.sh`. |
| `XMATRIX_PROFILE` | Which local connection profile to use, when you keep several accounts |
| `XMATRIX_CONFIG_DIR` | Where the session and configuration live. Defaults to `~/.config/xmatrix`. |
| `XMATRIX_TOKEN` | A session token, instead of the stored login |
