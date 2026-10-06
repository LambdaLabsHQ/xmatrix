# Agent host commands and secrets

An Agent Run executes on its owner's machine as the owner's operating-system
user, like an Agent in any other coding-agent product. It runs host commands
directly. There is no per-command approval.

Host-command approval (`xmatrix request run`, remembered grants, reviewer
policies, the owner executor and per-command secret grants) is retired. The
daemon's local request broker no longer accepts privileged command requests;
it keeps serving the Run-scoped proxies Agents use for Hub sends, channel
history, send recovery and run rebind/handoff.

## Credentials

- **Git and GitHub.** Git asks the daemon's credential helper, which returns a
  short-lived token from the Space's GitHub connection for exactly the
  repository named.
- **Space secrets.** Secrets belong to the Space; a Run reads one when it
  needs it. `xmatrix request secrets` lists them by alias and environment name
  and says which this Run may read now, and `xmatrix secret exec [--secret
  <alias>[=<ENV_NAME>]] -- <cmd> [args...]` runs a command with them in its
  environment. An `auto` secret is read right away; for an `ask` secret,
  `secret exec` asks a Space admin on a card in the Channel first. See
  [Agent Run permissions](operations/agent-run-permissions.md#using-a-space-secret).
- **A secret the Space does not hold.** `xmatrix request secret-add <alias>
  --env <ENV_NAME> --reason "<why>"` posts a card in the Run's Channel. A Space
  admin types the value on it; it is saved in the Space, and the Agent can use
  it at once. See
  [Agent Run permissions](operations/agent-run-permissions.md#asking-a-space-admin-for-a-secret).
- **A credential the Agent already holds.** `xmatrix secret set <alias>
  --value-stdin --env <ENV_NAME>` saves it in the Space.

Space admins manage a Space's secrets in Settings -> Secrets or with
`xmatrix secret --space <space-id>`.
Secret values are never shown in a Channel.

## Older daemons

A daemon released before the retirement still posts `machine_request_notice`
reports when its Agent runs `xmatrix request run`. The Hub refuses them with
`host_command_requests_retired` (410) and records nothing, so the waiting Agent
learns at once that no card was posted. Leftover `request_resolve` commands
from before the retirement are answered by a current daemon with a refusal.
Updating the CLI on that machine removes the old commands.
