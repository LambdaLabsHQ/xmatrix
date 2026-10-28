# Provider capability data audit

Reviewed on 2026-10-27 at the maintainer's request after Claude Ultracode
remained absent despite a change to a static fallback list. Policy is P1 #7
in [the ten guardrails](../guardrails/project-guardrails.md); this document
records implementation evidence, not additional rules.

## Scope and findings

The audit searched production code, configuration, documentation and scripts
across the repository for model/effort literals, capability inventories,
defaults, fallbacks and static catalog consumers. Inspection covered all
eight documents under `docs/guardrails`, every runtime backend family, the
shared protocol, Hub validation/routing, Web completion and native shells.
Fixtures and marketing/demo samples were distinguished from runtime claims.

| Boundary | Authoritative source and result |
| --- | --- |
| Claude models and reasoning levels | Native `initialize.models` and each model's `supportedEffortLevels`. Removed the obsolete hardcoded alias and effort functions and their two inventory-copying tests. Both session and streaming presentation now use native facts only. |
| Claude workflow modes | The built-in effort command's native finite `name [on\|off]` argument branches. The parser reads mode names generically; model rows without reasoning support remain without effort controls. `auto`, `on` and `off` are not added as reasoning levels. |
| Codex and ZCode models/efforts | `model/list` response parsing in `runtime_codex_app_session.rs`; defaults come from native reports or the user's configuration. No product-side fixed model/effort inventory was found. ZCode's absent catalogs stay absent. |
| Grok, Kimi and all generic ACP harnesses | Native model metadata and `configOptions`, observed by `agent_presentation.rs` and applied by `runtime_acp_session.rs`. Effort and parameter options come from the native schema, including future values. |
| Native command inventories | Claude's complete slash overlay and ACP's `availableCommands`/`available_commands`. The shared session/presence merge suppresses unreported documentation passthrough entries before initial discovery and after an empty native replacement. |
| Documentation command catalogs | The five JSON catalogs under `packages/protocol/src/agent-command-catalogs` retain source URL, source kind, revision and the existing refresh script. They describe metadata and reviewed control bindings; their passthrough inventory cannot override a native inventory. For transports without native enumeration, these remain the explicit source-backed catalog. |
| Parameter controls | Codex native JSON schemas/service tiers, ACP typed config options and Claude native initialize facts. Boolean domains and known wire field mappings are protocol bindings; selectable enum values are provider data. |
| Hub and Web | Hub sanitizes and persists reported catalogs; routing and control validation consume them. Web model/effort/parameter completion consumes those observations. No independent fixed provider model/effort list was found. Native shells delegate these surfaces to the Web. |
| Harness identity and installation | `agent-presets.json` owns xMatrix's supported launcher/protocol/install integrations. This is deliberate product configuration, separate from claims about models or options an installed provider exposes. |
| Observed status | Transcript and native event decoders report current values. Named event/field bindings, such as Claude's Ultracode enter/exit attachments, decode observed state; they do not authorize selectable capabilities. |

The old claim that Claude cannot enumerate models was removed from current
code. Historical review evidence remains historical and is explicitly
superseded by this review. The repository entrypoint still points to exactly
ten canonical guardrails, and the descriptive profiles add no separate policy.
Protocol constants, security boundaries, deliberate product policy, release
configuration and test/demo sample values were not reclassified as live
provider capabilities.

## Validation and compatibility

The native discovery probe on Claude Code 2.1.312 returns reasoning levels
without Ultracode and an effort hint that declares it. Starting the native
process with `--effort ultracode` also accepts initialization. These probes
submit no model task and discard account fields.

The session regression exercises discovery, visible options, live selection
and process recovery. It failed on the previous implementation. Native parser
cases cover an unseen workflow name, absent/custom/unrelated command hints,
unchanged model-specific levels, unsupported models and duplicate options.
Session and shared presentation regressions cover commands before first
discovery, native replacement and removal for Claude, Grok, Kimi and generic
ACP. The pre-discovery cases failed on the earlier implementation; command
construction now has one shared owner rather than a separate session helper.

Only locally installed Claude was directly probed; the other provider families
were inspected and exercised through their existing wire fixtures. This audit
does not claim live verification of every separately installed harness.

Release the CLI/daemon through Production Release Intent, then restart or
reborn existing Instances to load the runtime change. Discovery is bounded
and occurs before initial controls are published. If a legacy harness cannot
enumerate capabilities, ordinary tasks can still run, but model/effort
controls remain unavailable instead of advertising guessed choices. Explicit
parameter requests still fail when discovery fails. No Hub/Web deployment,
database migration or change to user provider settings is needed. Recovery
uses a CI-validated CLI beta reverting the change.

Exact test, CI, release and live verification evidence belongs in the
implementation pull request and work conversation.
