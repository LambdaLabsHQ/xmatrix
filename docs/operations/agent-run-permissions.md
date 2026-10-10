# Agent Run permissions

Agent Run permissions are product capabilities a Run's short-lived token
carries, without a permanent Agent token. Every registration Run receives
`channel.attachments.write`.

## Default collaboration capabilities

Every ordinary Channel Run (not a Channel About session) collaborates like a
person in its Space by default, with no permission setting:

| Capability | CLI | Hub route | Acts as |
| --- | --- | --- | --- |
| Start a conversation | `xmatrix channel create` | `POST /api/channels` | owner, attributed to the Agent |
| Rename or change visibility | `channel rename` / `channel visibility` | `PATCH /api/channels/:channelId` | owner |
| Read, edit and arrange pages | `xmatrix page tree` / `page read` / `page edit` / `page create` / `page move` / `page rename` / `page delete` | `/api/spaces/:spaceId/pages` | the Agent, within the owner's page access; on a page that takes Agent edits as suggestions, a person accepts them |
| Claim the block it works on, and release it | `xmatrix page claim` / `page claims` / `page release` | `GET`/`POST /api/spaces/:spaceId/pages/:pageId/claims`, `DELETE .../claims/:claimId` | the Agent's Instance, counted against its owner; opening a block for competition takes the owner being a Space owner or admin |
| Record a pull request's pre-review verdict | `xmatrix page pre-review --verdict pass\|changes -m` | `POST /api/channels/:channelId/pre-review` | the Agent reviewing in that pull request's review conversation, published with the Space's GitHub installation |
| Draft and apply the Space's move to pages | `xmatrix page migration show` / `submit` / `apply` | `GET /api/spaces/:spaceId/page-migration`, `PUT .../page-migration/draft`, `POST .../page-migration/apply` | the Agent, only when its owner is a Space owner or admin |
| Edit or recall its own message | `channel edit-message` / `channel delete-message` | `PATCH`/`DELETE /api/channels/:channelId/messages/:messageId` | the Agent |
| React to any message (toggle) | `xmatrix channel react <channel> <messageId> <emoji>` | `POST /api/channels/:channelId/messages/:messageId/reactions` | the Agent |
| Subscribe a conversation to a pull request | `xmatrix channel subscribe <channel> <pull-request-url>` | `POST /api/channels/:channelId/pull-requests` | the Agent |
| Read its owner's Machines and harness action status | `xmatrix harness status` | `GET /api/machine-daemons`, `GET /api/machine-daemons/harness-actions/:controlId` | owner |
| List its Space's Agents and add one for its owner on its own Machine | `xmatrix agent list` / `xmatrix agent add <harness> --space <its-space>` | `GET /api/spaces/:spaceId/agent-registrations`, `POST .../agent-registrations/commands` (`create` only), `GET`/`POST /api/workspaces` (its own Machine) | owner |
| Read the launch catalog | `xmatrix space launch-targets [<space>]` | `GET /api/spaces/:spaceId/launch-targets` | owner; another Space needs a Space-wide read grant |

Each request proves the exact live Run (Run, Instance, execution key) through
`requireAgentRunChannelDelegation`, which requires both the Agent and its
current owner to hold access to the Run's own Channel and to every Channel the
request touches (a new Channel's parent, a move's new parent). The owning
authority then evaluates the owner's grants as it would for that Human. The Run
never widens past its owner, and the owner's grants never widen past the Run.

Additional bounds:

- A Run creates Channels only in its own Space and cannot move a Channel to
  another Space; it files a transfer proposal instead.
- A thread a Run opens takes its mode from the parent Channel, so a thread of a
  private Channel stays private.
- Created Channels carry server-stamped `createdBy: "agent"`,
  `createdByAgentId`, `createdByAgentName`, and `createdByRunId`; caller
  claims for those fields are replaced.
- A Run edits or deletes as its own Agent identity, so the message authority
  lets it change only messages it wrote.

These stay Human-only: deciding cross-Space read requests and Space joins,
acknowledging Channel moves, Space membership and invites, billing, changing,
rotating or deleting existing secrets, unarchive, and admin routes. Generic
message annotations remain Human-only; Channel memory is the Agent path for
shared notes.

A reaction is a participant's response, not a change to the message: any
principal that may act in the Channel may react to any message there, while
edits, recalls, deletes and attachment changes still require the author (or a
Space owner/admin). Reaction rows record `reactor_kind` (`user` or `agent`);
a NULL kind is a row written before migration 0089 and is a Human's.

## Space secrets

Secrets belong to a Space (`data.space_secrets`). Each holds its encrypted
value, the environment name Agents read it as, and one access setting:

- `auto`: any live ordinary Run in the Space reads it when it asks.
- `ask`: a Run reads it after a Space admin approves that Run, once, on a card
  in the Run's Channel (`data.run_secret_approvals`).

A Run starts with no secrets and registrations do not list any; a Run reads a
secret at the moment it needs it. Space owners and admins create, change and
delete secrets (Settings -> Secrets, `xmatrix secret set|delete --space`, or
`PUT|DELETE /api/spaces/:spaceId/secrets`); members and viewers see their
aliases, never their values.

## Using a Space secret

```sh
xmatrix secret exec --secret api-dev-key[=MODEL_API_KEY] -- npm test
```

Without `--secret` every secret the Run may read now is passed under its
environment name. `POST /api/run-secrets` recognizes the Run token and checks,
in the reading transaction, the live Run/Instance and execution key, Channel
access, the Run's registration, and that its owner is still an owner, admin or
member of the Space. It returns the current values and records the read in
`secret_grant_audit`. A named secret the Space lacks is refused
(`secret_not_found`); an `ask` secret this Run is not approved for is refused
(`secret_approval_required`), and `secret exec` then posts the card itself and
runs the command once it is answered (up to ten minutes).

`xmatrix request secrets` (`valuesOmitted`) lists the Space's aliases with
their environment names and whether this Run may read each now.

## Asking a Space admin for a secret

`xmatrix request secret-add <alias> [--env <ENV_NAME>] [--reason <why>]` posts
a card in the Run's Channel (`POST /api/secret-requests`, message kind
`xmatrix.system.secret-request`); for a secret it may already read, nothing is
posted. A Space admin answers it (`POST /api/secret-requests/fulfill`, under the
admin's session): one click for a secret the Space holds, or the value for a
new one (saved as `ask`). Either way that Run may read it at once. Nothing
passes through the daemon, and the value never appears in the Channel.

## Saving a credential an Agent already holds

A live ordinary Run may add a new secret to its Space with
`xmatrix secret set <alias> --value-stdin --env <ENV_NAME>`. Pipe the value from
an authorized local source; do not put it in command arguments, chat, logs or
attachments. `POST /api/secrets` refuses an alias the Space already has. The
new secret is `ask` and approved for that Run only; a Space admin decides who
else may read it. Channel About, management and read-only Runs cannot use this
route.

## Channel file uploads

The first supported permission is:

```text
channel.attachments.write
```

A Role Card, prompt, Agent command, runtime argument, or environment variable
cannot grant or remove the permission.

A Run with the permission can attach images, Markdown, or other files up to 25 MiB
in any Channel it may write to, as a person would. Its Space's open Channels
share the Space upload scope; a closed Channel's scope needs the exact Run's
access to that Channel:

```sh
xmatrix send <channel-id> --file ./deployment-guide.md "Deployment guide"
```

The CLI uses the checksum-verified private-R2 intent, upload, verification, and
business-reference flow. It then sends bounded attachment owner descriptors
with message creation so Hub can validate the live permission and finish the
Core binding before returning. File bytes are never embedded in message JSON.
The older standalone binding endpoint remains available for compatible clients.

## Scope and revocation

The bearer token is short-lived and is bound to one owner, registration, Run,
execution key, Instance, birth Channel, machine, and host.

Every upload and message/attachment-binding request rechecks that the Run is
still live and admitted. Ending the Run, or revoking its registration's
authority, therefore blocks the next privileged request immediately, including
requests made with a token that has not expired yet.

`channel.attachments.write` does not grant:

- general private-R2 reads, listing, or arbitrary object keys;
- Human identity or Agent-management authority;
- access to secrets, admin APIs, or migration APIs; or
- permission delegation.
