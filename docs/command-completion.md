# Composer Command Completion

Composer command completion is schema-driven and segmented. The UI resolves only the
next valid segment for the current cursor position instead of flattening every possible
target, instance, command, action, and argument into one suggestion list.

## Schema ownership

Shared command grammar lives in `packages/protocol/src/index.ts`:

- `MENTION_COMMAND_COMPLETION_SCHEMA` declares the `@` entry point and its dynamic
  target source.
- Data-driven runtime catalogs live in `packages/protocol/src/agent-command-catalogs/*.json`
  (codex/claude/grok/zcode), each pointing at a stable vendor docs `sourceUrl`. Runtimes
  load the matching JSON and advertise `commands[]` on presence. Composer completes from
  that list (passthrough by default, typed when `mode` is set).
- Refresh catalogs with the `refresh-agent-command-catalogs` skill or
  `node scripts/refresh-agent-command-catalogs.mjs --check` (data PR, not generated
  business code). Optional runtime overlays merge additively: Claude
  `system/init.slash_commands`, Grok local skills dirs, ZCode `~/.zcode/commands`.
- `AGENT_INSTANCE_COMMAND_COMPLETION_SCHEMA` is only a fallback when a live instance has
  not advertised a command catalog.
- Connector action definitions live in `APP_CONNECTOR_PROVIDER_MANIFESTS`; their
  completion metadata is part of the same provider action definition used by the
  product.

Each schema node owns its token, label, description, action, next-segment delimiter,
and either static children or a named dynamic source. Consumers must not duplicate
those values in UI-specific completion tables.

## Resolution stages

`resolveMentionCompletion` is the single cursor-aware resolver. Both the main channel
composer and the inline Reply-in-thread draft render the same `ComposerInputCore`
(`apps/web/src/components/dashboard/composer-input.tsx`), which owns completion,
Enter-to-send / Shift+Enter newline, glass input chrome, and the send control. Thread
draft is only a thin density wrapper — not a second input stack. It returns a stage
label and only the candidates valid at that stage:

1. `@` resolves channel-visible humans, one Agent name per Space (routing
   picks the machine), and connectors. Duplicate Agent display names collapse
   to a single shout such as `@codex` or `@grok`. Humans with the same name stay
   distinct. After `@<agent>:` the start actions and repo/CWD launch targets
   remain.
2. `@<agent>:` resolves channel-local instances, explicit reborn targets
   (kill-if-live, then resume-continuous restart in that channel slot),
   same-machine handoff (`@<agent>:<n>:handoff:@<successor>`, existing or
   dead source to a new instance), and the
   current Channel's GitHub-connector repositories plus the agent's registered
   working-dir launch options inline — picking one inserts
   `@<agent>:new:<target>` directly. A bare `@<agent>` mention row appears only
   while the agent is online (an offline profile has no live instance to deliver
   to). A launch target is anything the mention grammar accepts, so the text typed
   after `:new:` is itself a choice once it reads as an `owner/repo` reference, a
   remote URL, or an absolute path — a repository nobody has registered locally is
   selectable, exactly as the Hub reads it. The targets themselves are one
   authorized answer from `GET /api/spaces/:spaceId/launch-targets`: repos
   the Space's connector grants — the same in every conversation of the Space,
   including a new one that has no Channel yet — ordered by GitHub last-push recency
   (`pushed_at`, then `updated_at`), plus registered directories — those only for
   the caller's own Profiles, because a path on a machine is not a fact about the
   Space. The composer does not derive a repo from a registered checkout and does
   not merge the two sources; `resolveMentionCompletion` never sees workspaces.
   See `docs/design/launch-target-authorization.md` for why.
   The grammar itself lives in `packages/protocol/src/agent-mention.ts` and is the
   only definition — the composer completes against exactly what the Hub executes,
   including `:once`, the `!` parallel override, `@<agent>:<n>:handoff:@<successor>`,
   bracketed mentions, repo reference
   normalization, and workspace-argument quoting.
   The prompt-facing syntax and Human/Agent authority matrix are documented in
   [Agent operation syntax](agent-operation-syntax.md).
3. `@<agent>:<instance> /` resolves commands declared by the agent command schema.
4. Instance slash commands resolve from the live instance `commands[]` catalog when
   present (including vendor passthrough commands). Typed `/model ` and `/effort `
   still resolve dynamic arguments from the instance model/effort catalogs; `/goal `
   resolves schema-declared controls while still allowing free-form goal text.
   When `commands[]` is empty, the shared fallback schema is used.
5. `@<connector>:` resolves that connector's manifest actions. Selecting an action
   inserts the delimiter declared by the action. Schema-declared dynamic arguments
   continue one segment at a time before handing remaining arguments to free-form input.
6. GitHub repository arguments resolve the accessible owner/organization first, then
   only repositories belonging to that owner. The Hub reads these values through the
   Space's GitHub App installation. Repository names and `@agent:new|once` `owner/repo` refs are ordered
   by last-push recency; owner/organization names stay alphabetical.

For example, the user sees `GitHub` at `@git`, GitHub actions at `@github:`, owners at
`@github:subscribe:`, and repositories only after choosing an owner. Likewise, model
names are not shown until a concrete channel-local instance and `/model` have been selected.

## Adding commands

Add static syntax once to the appropriate shared schema. Add connector actions once
to the provider manifest. Add a dynamic source only when values are runtime-owned,
and resolve it from the authoritative scoped state (for example channel-local
instances, a live instance's model catalog, or a connector installation). Dynamic
connector endpoints must verify the requesting user's Space membership for that
connection. Extend segmented resolver tests for each new
branch, including its insertion delimiter and free-form boundary.
