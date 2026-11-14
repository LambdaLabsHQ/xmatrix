# Agent access

A harness asks before it writes outside its workspace or runs a command, and a
headless Run has nobody at a terminal to answer. xMatrix therefore starts each
harness with whatever makes it stop asking. That is a decision about the
machine owner's files, so it is declared as data, shown to the owner word for
word, and applied from that same data.

## The grant

`packages/protocol/src/agent-presets.json` declares, per harness, what xMatrix
adds in `full` access under `access.full`:

| Field | Applied as | Example |
| --- | --- | --- |
| `args` | joined to the launcher's argv (the ACP argv for the generic ACP backend) | Claude Code `--dangerously-skip-permissions`, Grok `--always-approve` |
| `env` | set on the harness process | DeepSeek `DSH_PERMISSION_MODE=danger-full-access` |
| `session` | sent when the native session starts | Codex `thread/start` `sandbox=danger-full-access`, `approvalPolicy=never` |

The two ACP bridges also answer every `session/request_permission` with allow
in `full`. That is not a preset field: it holds for every harness on the `acp`
and `grok-acp` backends, including one whose preset adds nothing.

`agentAccessGrant(preset, mode)` resolves these into one `AgentAccessGrant`
(`mode`, `args`, `env`, `session`, `approvesRequests`). In `ask` the grant is
empty: the harness runs on its vendor defaults.

## Where it travels

The registration's launch (`AgentRegistrationLaunch.access`, in the machine
owner's physical environment) holds the mode its owner confirmed. A
registration added before the confirmation existed has none and launches as
`full`, which is what every launch was. One exception keeps that true: such a
launch that declares its own arguments always started with exactly those, so
its grant reports the full-access args they carry and adds none.
`agentLaunchAccess(launch, preset)` is the one resolution of a launch's grant
and argv; the spawn and the catalog both read it.

On a launch the Hub resolves the grant and sends it as
`machine_spawn_agent.access`. It also joins the grant's `args` to the argv it
sends, because a daemon released before the
grant reads them only there; that daemon adds Grok's flag itself, so Grok's
stay in the grant alone. The daemon joins the args without repeating one, sets
`env` on the wrapper it starts, and passes the grant on as
`XMATRIX_AGENT_ACCESS`; the wrapper reads `session` and `approvesRequests`
from it. The daemon and the wrapper hold no access default of their own beyond
the preset's full grant for a Hub that sends none.

The registration catalog reports the same grant as
`AgentRegistrationSummary.access`, with `confirmed` false while the
registration still runs on its unasked `full`.
