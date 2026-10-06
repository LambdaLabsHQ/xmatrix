# Launch Target Authorization

A launch target is the thing after `@agent:new:` / `@agent:once:` — a repo the Agent
gets its own copy of, or a registered directory it works in. This document is about
where that set of choices comes from, and why today it is not a Space's set.

## The reported symptom

`@` completion in Space B offers repos that belong to the human's work in Space A.
The GitHub connector is per-Space and behaves correctly; the mixing enters from the
other half of the same list.

## The structural cause: three scopes in one field

| Fact | Key | Scope |
| --- | --- | --- |
| App connector connection (GitHub installation) | `(space_id, provider_id)` | **Space** |
| Agent Profile | `id`, `space_id`, `metadata.machineId` | **Space**, bound to a machine |
| Workspace (registered directory) | `(machine_id, canonical_cwd)` + `owner_user_id` | **user × machine** |
| Machine daemon | `owner_user_id` | user |

`Workspace` has no Space dimension and no repo identity — only a free-text
`gitRemote`. The composer then computes the launch-target list **in the browser**
(`composer-completion.tsx` → `agentLaunchOptions`) by merging a Space-scoped read
(connector repositories) with a user×machine-scoped read (registered directories).

So the question "what may this Space be launched into?" is never asked of any
authority. It is assembled client-side out of two answers to two different questions.

Three consequences, in increasing order of seriousness:

1. **Mixed suggestions.** Both halves render as `kind: "repo"` with the same detail
   line, so a repo authorized by this Space is indistinguishable from one that is
   merely checked out on this machine for another Space.

2. **Cross-Space disclosure.** `list-agent-launch-workspaces`
   (`relay-authority-methods-gateway-query.ts:1062`) gates on channel access and on
   the Profile being in the channel's Space, then returns up to 500 of the *Profile
   owner's* registered directories on that machine — every Space they have ever
   worked in. Any member of a channel that Profile is in receives those paths and
   repo names.

3. **The Space boundary is advisory at execution.** The daemon mints a Space-scoped
   GitHub token before a repo-pool spawn, and on failure prints
   `Space GitHub connector could not mint a token for pre-spawn fetch … using host Git`
   and proceeds (`runtime_daemon_spawn_lifecycle.rs:390`). `ensure_managed_repo_checkout`
   clones with `gh repo clone`, i.e. the human's own GitHub login. A repo this Space
   was never granted is still reachable.

The credential path already states the correct principle, in its own comment
(`index-routes-auth-space.ts:861`):

> The caller names a channel, never a Space. The daemon takes that channel from the
> spawn command it was given, so a run cannot reach past the Space it belongs to even
> when its machine's owner belongs to several.

Selection does not follow the rule that credentials already follow.

## The final form

1. **Repo is read one way.** `githubRepositoryReference` in `@xmatrix/protocol` is
   the only reader deciding what names a GitHub repository; the repository-token
   route's private regex is gone. A `repo_identity` column on `Workspace` — the
   obvious next step — turned out to be unnecessary: once a registered checkout is
   no longer a repo suggestion, nothing reads a repo identity off it. "Do I already
   have a checkout of this repo" is answered by the daemon reading the on-disk
   remote (`find_existing_repo_checkout`), which is where the truth lives anyway.

2. **A Workspace is a materialization, not a target.** A Space lists the repos it
   is granted. The in-place working-directory launch survives as an explicitly
   machine-scoped, **owner-only** affordance — never merged into the Space's repo
   list, never served to other members of the Space.

3. **One authorized read replaces the client-side merge.**
   `GET /api/spaces/:spaceId/launch-targets` returns
   `{ spaceId, repos, repoStatus, workspaces }` to members of the Space; the
   connector is re-resolved per call. Launch targets are the Space's, not a
   Channel's: a new conversation has no Channel yet and completes the same
   repos. It gates on exactly what the mint gates on — a configured connector for
   the Space, not per-Channel connector enablement — so an offered repo
   is one a run can be given a credential for. The composer and the Start Agent
   dialog render that answer; `resolveMentionCompletion` no longer takes
   workspaces at all.

4. **Execution fails closed.** A `:new:<repo>` whose Space cannot mint a token
   stops with that reason instead of continuing on the host's Git login. The
   mint, and GitHub's answer to the clone or fetch under that token, are the
   only gate on a `repo:` Run's repository; nothing checks it before launch,
   reborn, wake or handoff. Their refusal fails the Run with
   `repository_access_unavailable`, which names the repository and tells the
   Channel to check the Space's GitHub app installation. A
   managed clone under a Space grant runs through Git's credential helper rather
   than `gh`, which authenticates as the machine's own GitHub account.

5. **The repo list is cached for a minute, not projected.** The first plan here
   was a `space_repo_grants` table maintained by `installation` /
   `installation_repositories` webhooks. That is the wrong shape: a maintained
   projection is stale for as long as a webhook is late or lost, and it splits the
   authorization answer into two sources that can disagree. A read-through cache
   keyed by the Space's *installation ids* is strictly better — connecting or
   disconnecting an installation changes the key and is visible at once, and every
   other change is bounded by a 60-second TTL rather than by delivery. The mint
   still re-resolves on every credential, so the cache decides how long a repo can
   be *offered* after access changed, never how long it can be used.

## What this does not fix

`resolveAgentLaunchWorkspaces` and the Hub's local-path summon resolution still
match registered Workspaces by `gitRemote` string. They are execution-side and
owner-scoped, so they no longer feed anything cross-Space, but the repo arm of
that lookup remains the weaker duplicate of what the daemon already does
correctly (see the repo-summon analysis). Removing it is separate work.
