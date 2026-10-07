# Agent prompts

The text every daemon-launched Agent receives, compiled into the CLI with
`include_str!` in `src/bootstrap.rs`. Edit these files to change what Agents are
told; the change reaches users with the next CLI release.

| File | What it is |
| --- | --- |
| `bootstrap.md` | The launch prompt: identity, commands, operating rules |
| `channel-contract.md` | The channel contract, also sent with every channel turn |
| `goal-command.md` | The `xmatrix goal` line, only for runtimes that drain goals |
| `working-mode-autonomous.md` | Default working mode: carry work through to release |
| `working-mode-cautious.md` | Working mode that asks before merging or releasing |

`{name}` placeholders are filled once, at launch: `agent_name`, `launcher`,
`hub_url`, `identity_context`, `goal_context`, `channel_collaboration_policy`
and `working_mode` in `bootstrap.md`, and `channel_id` in
`channel-contract.md`. A placeholder alone on its line disappears with its line
when empty. Other braces, such as the JSON example, are literal.

`XMATRIX_AGENT_WORKING_MODE` (`autonomous` or `cautious`) selects the working
mode; a Run launched without it works autonomously.
