# Agent operation syntax

Agent coordination is expressed as ordinary Channel messages. The message body
selects either an existing Channel-local Instance or a lifecycle operation that
creates or transfers an Instance. Internal globally unique `instanceId` values
are never typed into a mention.

The executable create and handoff grammar lives in
`packages/protocol/src/agent-mention.ts`. Composer completion and Hub parsing
must continue importing the same protocol definitions.

## Agent-authored operations

| Syntax | Effect |
|---|---|
| `@<agentName>:<channelInstanceId>` | Address one exact existing Instance in the current Channel. The ordinal is Channel-local and must come from live inventory. |
| `@auto repo:<owner/repo>` | Address a new persistent Instance in a managed worktree. |
| `@auto pwd:"<absolute-path>"` | Start persistently in an explicitly registered directory, in place. |
| `@<source>:<channelInstanceId>:handoff:@<successor>` | Transfer the source checkout to a new persistent successor Instance in the same Channel and on the same machine. |

Launch uses `@auto` or a direct runtime address such as `@claude` or `@codex`.
Direct addresses constrain the runtime and accept the same tags; for example,
`@codex repo:owner/repo`. Historical `@auto harness:codex` remains accepted.
Conditions are `key:value` words after
the mention, and the first word that is not a condition is ordinary message text.
`repo:` takes the preferred GitHub `owner/repo` spelling; sanitized HTTPS or SSH
remote references are also accepted. `pwd:` takes an absolute local path that is
already registered for the selected Profile owner and exact machine. Paths
containing whitespace are quoted; a literal quote inside the path is doubled.
`harness:`, `machine:`, `model:`, and `effort:` constrain
routing. Runtime-discovered choices use `param.<id>:<value>` (for example,
`param.future-speed:turbo`); `fast:on` abbreviates `param.fast:on` when the
selected harness advertises it. Unknown or withdrawn choices fail explicitly.
Model and effort keep their dedicated tags. Existing Instances accept
`@<agent>:<slot> /config <id> [value]`, with choices from their live catalog.
See [harness parameters](architecture/harness-parameters.md) for discovery,
native execution and compatibility. The retired `:new` and `:once` launch suffixes are rejected, not
translated.

## Lifecycle controls

Human- and Agent-authored Channel messages may both execute these controls.
They pass through the same target and Authority validation:

| Syntax | Effect |
|---|---|
| `@<agentName>:<channelInstanceId>:reborn` | Stop if necessary and restart the same Instance identity with retained continuity. |
| `@<agentName>:<channelInstanceId>:stop [reason]` | Stop one exact live Instance. `:kill` is an accepted synonym. |
| `/stop all [reason]` | Stop every live Instance in the target Channel. `/kill all` is an accepted synonym. |

The sender kind does not disable reborn, stop, or kill. The target Channel,
exact Instance/Run, workspace continuity, daemon ownership, and other operation-
specific checks still fail closed.

The shared grammar artifact, target registry and authoritative execution boundaries
are described in [Message interaction protocol v1](design/message-interaction-protocol.md).
