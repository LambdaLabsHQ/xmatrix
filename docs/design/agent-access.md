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

## Confirmation

What an Agent may do on a machine is its owner's to confirm, once per harness
on that machine, when the Agent is added. Every add path shows the grant the
Hub resolves for full access (`fullAccess` on the environment query) before it
writes anything, and writes the confirmed mode with the add:

- `xmatrix agent add` prints the grant's lines. `--access full` confirms; at a
  terminal the command asks; anywhere else it adds nothing and says what to
  show the owner.
- The Web asks in one dialog (`agent-access.tsx`) from the New agent page, a
  harness switch, an install that turns its harness on, and "Bring them in",
  which asks once for every harness it is about to add.
- An Agent Run never confirms for its owner. Its add is accepted only for a
  harness already confirmed on that machine and never writes a mode; otherwise
  the Hub refuses and names the command the owner runs.

`create` keeps an existing declaration and writes one thing onto it: the
confirmed mode, when the declaration holds none. A harness confirmed on a
machine is not asked about again when it is added to another Space.

An Agent added before the confirmation existed keeps running with the full
access it had. Its page and `xmatrix agent list` / `agent show` report that
access and what it adds, marked unconfirmed until its owner reads and confirms
it there. A client that predates the confirmation can still add without one;
that add is reported the same way.

## Ask

In `ask` the grant is empty: xMatrix adds nothing to the launch, and the
bridge that receives the harness's permission requests shows each one in the
Channel the turn serves instead of answering it. The card is the questionnaire
card of `docs/design/harness-questions.md` with the answers the harness
offers, and the request stays parked until a person picks one. A message
typed instead cancels the parked requests, as it does a question.

| Harness | Request | Card answers | Reply |
| --- | --- | --- | --- |
| Claude Code | `can_use_tool` for any tool but AskUserQuestion (asked once `--dangerously-skip-permissions` is gone) | Allow, Deny | `allow` with the input unchanged, or `deny` with a message the model reads |
| ACP agents | `session/request_permission` | the request's own option names | `selected` with that option's id; `cancelled` when the card is withdrawn |

The Agent speaks in its Channel through the `xmatrix` CLI, so one plain
`xmatrix` message, page or read command is allowed without a card
(`is_plain_xmatrix_command`): a single command with nothing chained to it,
and none of the subcommands that run another program or change the machine.

Only harnesses on these backends can be given `ask`
(`agentAccessModes`); the Hub refuses the mode for any other, and Codex and
ZCode are offered full access alone until their approval requests are
relayed. What a harness does without asking in its own default mode is the
<<<<<<< HEAD
vendor's: a sandbox that fails a command outright produces no request and so
no card. DeepSeek Harness's `workspace-write` does that to the `xmatrix` CLI
itself (it cannot write `~/.config/xmatrix`), so an `ask` Agent could not even
reply; its preset says `"ask": false` and it is offered full access alone
until xMatrix adds that directory to the harness's writable roots.
=======
vendor's: a sandbox that fails a command outright (DeepSeek Harness's
`workspace-write`) produces no request and so no card. That sandbox also
refuses the write every `xmatrix` command makes to `~/.config/xmatrix`, so an
Agent left in it could not answer in its Channel. A harness whose full access
is an environment setting is therefore offered full access alone, as Codex
and ZCode are.
>>>>>>> origin/main

An `ask` launch is routed only to a daemon that advertises
`registration_access_ask_v1`. An earlier daemon answers every request with
allow, so the launch waits for the machine to update instead of running with
more than its owner confirmed. The owner changes the mode from the Agent's
page or with `xmatrix agent access <harness> <full|ask>`; it applies to the
harness's next Runs on that machine.
