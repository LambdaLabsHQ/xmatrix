# Agent prompts

The text every daemon-launched Agent receives, compiled into the CLI with
`include_str!` in `src/bootstrap.rs`. Edit these files to change what Agents are
told; the change reaches users with the next CLI release.

| File | What it is |
| --- | --- |
| `bootstrap.md` | The launch prompt: identity, commands, operating rules |
| `channel-contract.md` | The channel contract, also sent with every channel turn |
| `goal-command.md` | The `xmatrix goal` line, only for runtimes that drain goals |
| `space-rules.md` | Names the Space's rules page, when the Space has one |
| `working-mode-autonomous.md` | Default working mode: carry work through to release |
| `working-mode-cautious.md` | Working mode that asks before merging or releasing |

`{name}` placeholders are filled once, at launch: `agent_name`, `launcher`,
`hub_url`, `identity_context`, `goal_context`, `channel_collaboration_policy`,
`space_rules` and `working_mode` in `bootstrap.md`, `page_id` in
`space-rules.md`, and `channel_id` in `channel-contract.md`. A placeholder alone on its line disappears with its line
when empty. Other braces, such as the JSON example, are literal.

A Space owner or admin picks each Agent's working mode in its settings
(`workingMode` in the Space Agent configuration). The Hub sends it with the
spawn, the daemon sets `XMATRIX_AGENT_WORKING_MODE` (`autonomous` or
`cautious`) for the Run, and a Run launched without one works autonomously.

The Space's rules page is its governance page (the Share dialog's "Space
rules" toggle). The Hub sends its id with the spawn, the daemon sets
`XMATRIX_SPACE_RULES_PAGE_ID`, and the Agent reads the page itself; the launch
never carries the page's text.
