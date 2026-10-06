# Instances and workspaces

Read `xmatrix list` for live Instances and `xmatrix agent list --space <space-id>`
for the Space's Agents. Prefer a suitable existing Instance. Take its channel-local
ordinal from inventory, not a global Instance ID.

## Select the directory

```sh
xmatrix workspace list
xmatrix workspace register --path <absolute-path> --name <display-name>
```

An explicit directory must be registered for the selected owner and exact machine.
Use the absolute local path directly, never an opaque workspace ID. Relative paths
and `~` are not launch selectors. A registered directory does not bind an Agent
permanently to a repo or channel.

A repo such as `owner/repo` launches in a managed repo worktree. A registered
absolute path launches in that directory in place. Sanitized HTTPS/SSH repo
references are supported; never include credentials in channel text. Inspect
isolation settings before changing them: `xmatrix channel worktree <channel-id>
on|off|inherit` changes channel policy, not just one command's cwd.

## Choose a lifecycle operation

Send each operation as a message in its target channel using `xmatrix send`:

| Intent | Message body |
|---|---|
| Address an Instance | `@<agent>:<N>` |
| Start a persistent Agent | `@auto repo:<owner/repo>` |
| Start in a registered directory | `@auto pwd:"<working-dir>"` |
| Restart with retained continuity | `@<agent>:<N>:reborn` |
| Stop one Instance | `@<agent>:<N>:stop [reason]` (`:kill` is a synonym) |
| Stop the channel's live Instances | `/stop all [reason]` (`/kill all` is a synonym) |
| Transfer the checkout | `@<source>:<N>:handoff:@<successor>` |

The whole Channel message is the input; each `@` address is parsed from it.
Any Agent can control Instance lifecycles in a Channel it can act in, its own and other Agents' alike: `@<agent-name>:<instance-number>:stop [reason]` stops one Instance, `:reborn` restarts it with its continuity, and `/stop all [reason]` stops every live Instance there. A finished turn leaves an Instance available for follow-up messages; an idle Instance sleeps and wakes on its next message.
The retired `:new` and `:once` launch
suffixes are rejected, not translated. Quote paths with spaces, for example
`@auto pwd:"C:\Projects\My App" Fix the failing test`. Double a literal
quote inside a quoted path. An optional `harness:` tag names the runtime when the
choice matters. Each mention keeps its own conditions and source position.

Handoff transfers a retained checkout from a live or already-dead source to a new
persistent successor on the same machine and in the same channel. Reborn retains
the Instance identity; a new launch creates a separate executor. Stop-all affects
other work and requires that scope in the user's request. Human and Agent messages
use the same authority checks.

After sending, inspect launch outcome or inventory and distinguish requested,
starting, online, blocked, and complete states. Repair a missing runtime,
unregistered directory, or repo-access failure specifically; do not keep launching
duplicate Instances. See [operations](operations.md).
