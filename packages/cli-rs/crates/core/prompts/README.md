# Agent prompts

These repository Markdown documents are the single source of official Agent
instructions. The Hub bundles them as Text modules and attaches
`bootstrapPrompts` (schema version 1) when delivering each `machine_spawn_agent`
command. Editing them reaches the next new Run after a Hub deployment, without
a CLI release once the daemon supports this field.

| File | Content |
| --- | --- |
| `bootstrap.md` | Identity, discovery through CLI help, principles and operating rules |
| `channel-contract.md` | Complete Channel reporting contract, delivered at launch |
| `channel-turn.md` | Compact native Codex developer reminder retained for every turn |
| `goal-command.md` | Goal discovery, only for runtimes that drain goals |
| `space-rules.md` | Space governance Page id; never copies its body |
| `connected-apps.md` | Connected app names and `xmatrix connector list` discovery |
| `working-mode-autonomous.md` | Default: finish through release |
| `working-mode-cautious.md` | Cautious mode, selected by a Space owner/admin |

The daemon validates the version, required nonempty text, NUL exclusion and
32 KiB serialized envelope limit before starting the child. The wrapper renders
known `{slot}` placeholders once; inserted data is never recursively expanded.
Unknown placeholders remain literal. Standalone CLI and old-Hub launches use a
compiled copy of these same files. Unsupported or malformed supplied bundles
fail launch; they never silently fall back. Legacy daemons ignore the additive
field and keep their compiled prompts until upgraded. Already-running sessions
retain their launch text; ordinary Channel messages no longer repeat the full
contract. No separate prompt version service or Page-based publisher exists.

The daemon passes the validated bundle as `XMATRIX_HUB_BOOTSTRAP_PROMPTS`,
clearing inherited bundle/custom/disable overrides. Other launch slots remain:
`agent_name`, `launcher`, `hub_url`, `identity_context`, `goal_context`,
`channel_collaboration_policy`, `space_rules`, `connected_apps`, `working_mode`;
`page_id`, `apps` and `channel_id` fill their corresponding documents.
Working mode, governance Page id and connected apps remain separate Hub fields
(`workingMode`, `spaceRulesPageId`, `connectedApps`).

Task text, Channel history, attachments and display names stay in user input.
Registration instructions use native trusted paths: Claude
`--append-system-prompt`, Codex developer instructions, Grok ACP `_meta.rules`.
Codex installs registration instructions and the compact reminder through
`thread/start` and `thread/resume` developer instructions; `turn/start` and
`turn/steer` carry user input and never accept trusted instructions.
Grok receives only registration instructions and the official Channel contract
as trusted rules, never the composed bootstrap/history. Generic ACP, ZCode and
PTY retain their existing refusal when registration instructions require a
trusted channel they cannot provide. Official bootstrap text stays in the
initial user input on those adapters; a transport change grants no permissions.

Hub tests load these Text modules through their platform preload hook. CI treats
changes in this prompt directory as both Hub and Rust CLI changes; Wrangler
bundles the same documents in production and test configurations.
