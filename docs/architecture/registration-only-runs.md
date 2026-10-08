# Registration-only Runs

Status: design, approved direction (maintainer, 2026-09-26). Supersedes the
"Transitional exception" in
[agent-registration-composite-key.md](agent-registration-composite-key.md).

## Decision

A Space Agent Registration — the natural key owner × machine × harness in
`data.space_agent_registrations` — is the only identity a Run executes under.
Agent Profile Runs are removed, not deprecated: no entry point creates one, no
admission path accepts one, no address, projection, completion or client view
resolves one, and no legacy mapping or cutover fallback remains. Live Profile
Runs in production are stopped before the schema contract.

The Agent Profile entity itself goes with them: role assignment and avatar move
to the registration, connectors name a registration, and `data.agent_profiles`
with its creation requests is dropped. (The Agent Role was later retired
altogether; see "Agent Role retirement" below.) There are no direct
conversations: an Agent is reached by @-ing it in a conversation.

## Why

Two coexisting Run identities are the source of a family of defects. The
Channel keys a registration Run by its Instance, a Profile Run by its Profile;
every consumer that joined one to the other silently lost the other kind. The
reported symptom was an empty `/` palette: Web completion found live instances
only through Profile ids, and registration Runs have none.

## End state

### Launch

Every Run is created by the registration launch
(`packages/db/src/agent-registration-launch.ts`) or registration reborn
(`registration-reborn.ts`). Entry points that create Profile Runs today move to
it:

| Entry point | Today | End state |
| --- | --- | --- |
| `@Name:new` / `@Name:once` (mention engine `prepareResolvedSummonBatchV2`, `prepareSummonBatch`, summon SQL in `runtime-control.ts`) | Profile summon | Registration dispatch only; a name that is not a registration is refused with a Channel-visible reason |
| `:reborn` | Registration reborn, Profile reborn when the Space answers `legacy` | Registration reborn only |
| `:handoff` | Profile `run_create` + `instance_create` | Registration handoff: a Run of the successor harness on the source's owner and machine, inheriting its directory |
| Direct-conversation wake | Profile summon; participants are Profile ids | Registration launch; participants are registrations |
| Management `agent_dispatch`, `agent_control` reborn, `management agents` ranking | Profile selection | Registration selection through Jev; reborn is registration reborn |
| Durable Object Automation / scheduled-agent paths | Profile `run_create` | Removed; Automations run through the PostgreSQL scheduled port |
| `POST` agent run route (`index-routes-channel-agent.ts`) | Profile `run_create` | Removed |

Already on the registration launch: `@xmatrix` management activation, Focus
review and Channel About (placed by the Space management prompt's summon
tags), and PostgreSQL Automations.

### Admission and authority

`requireRunRegistrationAccess` requires a `data.run_agent_registrations`
binding. The `legacy_before_cutover` and `control.legacy_agent_registration_references`
branches are deleted, together with the per-Space `prepared` mode: every Space
is composite.

### Addressing, presence and clients

- A Channel Agent member is always keyed by its Instance. Presence carries the
  registration facts clients need (owner, machine, harness), so no client joins
  presence to a Profile.
- `@name:N` resolves by registration display name and Channel slot only.
- Web completion, the Channel member panel, message authors, stop/reborn and
  launch completion read Channel members and registrations; the Profile list is
  not an input to any of them.

### Schema contract

After production holds no Profile Run, a contract migration drops
`data.runs.agent_profile_id`, `data.agent_launches.target_profile_id`,
`control.legacy_agent_registration_references` and the Profile-only columns of
message execution, routing and invocation tables, and makes
`run_agent_registrations` mandatory for every Run.

## Sequence

1. Move each entry point in the table to the registration launch (one PR each,
   each deleting its Profile branch).
2. Delete Profile admission, addressing, projection and client paths; clients
   read Channel members and registrations only.
3. Stop the remaining live Profile Runs in production (bounded, audited, by
   exact Run id).
4. Ship the contract migration and update the guardrail profile and the
   composite-key document.

## Verification

Each step carries regression coverage for its entry point and a negative test
that the Profile path is refused. Step 3 records the exact Run ids stopped.

## Decisions made while implementing

- A Run's actor is its Instance everywhere: admission, message authorship,
  Channel access, Automation, Focus, trace grants and diagnostics compare the
  Instance id; no path accepts a Profile id or falls back to one.
- A daemon admits a registered spawn before starting it, and only an admitted
  Run executes; a Run without a `run_agent_registrations` binding is refused.
- A registered launch is prepared against an online Workstation. A mention to
  an offline one is refused on the record (`registration_not_found`), not
  queued behind it.
- Test Hub workers run every authority production serves from PostgreSQL.
- Found and fixed on the way (all PostgreSQL paths production runs):
  mention notifications now carry the attention summary; `policy-decision`
  Machine notices are accepted; startup and stop result notices name the
  registration; stop results post their Channel notice; archiving a Channel
  stops its registered Runs; owners can delete a still-starting registered
  Instance; a recoverable spawn failure re-queues its Launch as a new spawn command (the
  failed one already completed) and wakes the Channel coordinator, so the next
  daemon on the machine is offered it.
- Step 3 is the `profile-run-stop` lifecycle-maintenance operation. Its
  targets are structural: live Runs (or non-offline Instances) with no
  `run_agent_registrations` binding, on every shard. No path creates such a Run
  any more, so the set only shrinks between the dry run and the write. The
  write stops each Run and takes its Instances offline, as a Channel archive
  does. It then issues one durable `machine_stop_agent` per Run, sent to the
  machine recorded in `machine_run_routes`, and the daemon claims it on its next
  control poll. The dry-run and write artifacts record the exact Run ids.
- The Profile routing ranking, its synthetic evaluation, the Profile summon
  cursor park and the Profile-based launch verification and live canary
  harnesses were deleted rather than converted: each existed only to choose,
  start or verify Profile Runs.
- Production held no legacy-mode Space when Profile routing was removed (the
  fleet inventory reported 12 of 12 Spaces composite), so no Space needed a
  cutover.
- The `profile-run-stop` dry run on v0.16.439 (maintenance run 36289668344)
  found no live Run without a registration binding on either shard, so no
  write was needed. The operation, the cutover and audit scripts and the
  maintenance workflow's `operation` input were deleted afterwards; the
  workflow runs lifecycle maintenance only.
- Every Run projection reads its registration: Channel presence keys members
  by Instance, and launches, continuations, diagnostics, kill targets,
  execution reports and message targets take names and harnesses from the Space
  registration. Agent authority checks (content, catalog, Space reads, Channel
  ACL subjects, transfer, invocation sources) accept only a registered
  Instance. An Agent Channel grant names an Instance, so a transferred tree
  never keeps one. App connections are no longer bound to an Agent.
- Found and fixed on the way: execution progress from daemon snapshots and
  exit reports was dropped for registered Runs; "remember for this Instance"
  secret approvals failed for them; scheduled timeouts, owner deletes and reply
  recovery sent a `"null"` or Profile agent id to the daemon; an Agent closing a
  Channel could not grant itself access; registered handoff continuations lost
  their predecessor's exit evidence; an owner posting as their live registered
  Run (the CLI inside an Agent's environment without a Run token) was refused,
  because attribution looked the Instance up as a Profile; deleting a
  starting remote-repo Instance could abandon without its pooled slot, because
  the spawn command completes before the Run records its result, so the Run
  now carries a `spawnResult` marker the delete waits for.
- There is no Agent Profile. A Human adds an Agent with the registration
  `create` command: in one step it declares the harness on the owner's machine,
  offers it to the Space, grants it the owner's Workspaces there and enables
  it. Only the machine's owner may run it, under the Space's Agent creation
  policy. The `create` command kind needs contract migration
  `0102_contract_registration_create_command`, applied before the release
  that records it.
- A Role Package version is assigned to a registration, not summoned as a new
  Agent. A Space owner or admin configures `role {roleId, roleVersion,
  roleDigest}`. The Hub reads that exact published version from the Role
  store, one the admin can read, and stores its snapshot in
  `space_agent_registrations.role_json` (`0101_expand_registration_role`). A
  launch reads the snapshot from the registration row, so no shard reads the
  Role store. The Role's prompt comes before the Space's instructions, and its
  avatar replaces the harness avatar in presence and messages. Superseded by
  the Agent Role retirement below.
- The Profile HTTP routes (list, edit, creation requests, recovery, the
  management agent picker, Role summon and upgrade) are gone, along with the
  web's Profile pages and the desktop's local Profiles. Web mention chips and
  pending-launch rows resolve registration launches by Instance only.
- Found and fixed on the way: `create` wrote the machine declaration before
  the global enrollment it references.
- The CLI has no local Profiles and no Profile commands. `xmatrix agent add`
  issues the registration `create` command for this machine; `agent list`,
  `agent show` and `agent remove` read or revoke a Space's registrations.
  (`role assign` existed until the Agent Role retirement below.)
  `channel create` no longer takes `--access` or `--name`: an Agent reaches a
  closed Channel by being summoned there, and its Instance is granted.
- The daemon refuses a spawn without a registration binding, both in admission
  and before any workspace or process effect. The quota probe resolves `registration:<harness>`
  targets only, and `xmatrix <runtime>` runs only as a daemon-started Run.
- The Durable Object authorities hold no Agent Profile either. Their Profile
  tables, their `runs.agent_profile_id` column and its index are dropped by
  Authority schema v85, and the Agent/App policy target (contract v6) no longer
  holds or copies Profiles. The relay-v2 `agent_profile` projection kind stays
  decodable but is not replicated, like `follow_up`. Where the Authority still
  checks an Agent against a Run (message proof), it compares the Run's
  Instance. Where an Agent would need authority only the PostgreSQL Runtime
  holds, it refuses: Automation Agent commands and trace access requests.
- No wire field names a Profile. Message targets, execution reports,
  continuations, launches and launch diagnostics carry the Instance id they
  already had, without an `agentProfileId`, `targetProfileId` or
  `sourceProfileId` mirror of it. The quota probe names its target `targetId`
  (`registration:<harness>`) under daemon capability `machine_quota_probe_v2`,
  so a daemon that still speaks v1 is simply not probed. The Profile routing
  planner and its candidate rows, which only tests still called, are deleted.
- The schema retires in three steps, because an expand migration may only
  widen: 0104 (this release) stops requiring the execution report's Profile
  column, and the Hub stops reading or writing every Profile column and the
  Profile routing tables. Contract 0105 drops them, backfills the renamed
  `agent_creation_policy` column behind a sync trigger and copies the pause
  approval key to `agentInstanceId`, and the next Hub reads only the new names.
  Contract 0107 then drops the trigger, the old policy column and the old key
  (0106 is page claims, which took the next number after 0105 was applied).
- `xmatrix <runtime>` runs only as a daemon-started Run, which is always
  headless and authenticates only through its daemon's run-scoped broker. The
  wrapper's interactive terminal path (raw-mode PTY, input bar, terminal
  frontends and local slash commands), its Owner- and instance-session token
  refresh and its unregistered passthrough had no caller and are deleted,
  together with the terminal crate's frontend and input modules and the
  dependencies only they used.
  Outside a Run, a word that names no harness in `agent-presets.json` is
  reported as clap's unrecognized subcommand, with its "a similar subcommand
  exists" tip, before any runtime setup; a harness name keeps the
  daemon-started-Run refusal.

## Agent Role retirement

The Agent Role product feature is retired. A Role bundled several things that
now have their own homes: persistent goals are page sections kept true by
Automations, the runtime and model come from the summon's tags, and App
permissions come from the Space's connectors and secrets. Skill distribution
went away with the Role and has no replacement yet.

- Removed: the Role Package HTTP routes (`/api/roles/*` on the Hub,
  `/api/xmatrix/roles/*` on the web), the PostgreSQL and Durable Object Role
  command and query paths, the web Role Hub (Discover) and Role Studio, Role
  assignment on registration editing, the `xmatrix role` CLI commands, and the
  `@xmatrix/protocol` Role and Role Skill types.
- Launch no longer compiles a Role into the Run. The spawn command's
  `roleInitialPrompt` carries only the registration's own instructions; its
  wire name is unchanged because every daemon reads it. `roleReminder`,
  `roleSkills`, `roleAppRequirements` and the Role avatar (`agentAvatarUrl`)
  are no longer sent. A daemon ignores them if an older Hub still sends them,
  and the Durable Object command allowlist still accepts them so a command
  persisted before the retirement replays.
- A stored configuration that still names a `role` reads as unassigned, and
  saving it drops the field. The web Agents view is the `agents` view; the old
  `roles` view name and URL still open it.
- Data is kept: `space_agent_registrations.role_json`, `data.roles` and the
  Durable Object `roles` table are no longer read or written, but nothing is
  dropped or deleted. Dropping `role_json` (and the Role tables) is a separate
  contract migration, after the count of non-empty `role_json` rows is
  confirmed in production. The `role` projection kind stays decodable but is
  not replicated, like `agent_profile`.
