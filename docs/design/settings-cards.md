# Settings cards

An Agent often stops on a setting only a person can make: signing in to App
Store Connect, a connector credential, a Space secret, letting Agents read a
secret without asking, a harness signed in on a Machine. A settings card puts
that setting into the conversation as a control. The person makes it there, the
card shows the setting's real state, and the Agent that asked is woken once
every setting on the card is in.

The design discussion and decisions are on the Page "对话内设置卡：把任意配置插进对话"
(page:84661dda-87fb-4de8-b8ae-a0d6e6fd86d6).

## Model

A setting is named by an **address** (`packages/protocol/src/settings.ts`):

| Address | Domain | Lives in |
| --- | --- | --- |
| `connector:<app>/<field>` | connector | the connection's credential store; the field comes from the App's manifest |
| `connector:<app>/connect` | connector | the connection itself (OAuth or install) |
| `secret:<alias>` | secret | the Space's secrets (`data.space_secrets`) |
| `secret-access:<alias>` | secret-access | the secret's `access` (`auto` or `ask`) |
| `harness:<machine>/<harness>/sign-in` | harness | the Machine daemon's harness inventory (`login`) |

The address's domain projects it into one `SettingDescriptor` from the domain's
own authoritative data. The descriptor has dimensions that do not depend on
each other:

- **control**: how a client asks for it: `text`, `secret`, `sign-in`, `connect`,
  `grant`, `harness-sign-in`. The client owns each control. A card cannot
  define fields, labels or targets, so it cannot draw a lookalike "paste your
  key here" box.
- **sensitivity**: `secret` is written once and never read back. `plain` is
  read back to its writers, and an Agent may suggest a value for it.
- **writer**: who may make it, `space-admin` or `machine-owner`. The domain's
  own store checks it again where the value is written.
- **state**: what the domain observes now: `missing`, `set`, `verified`,
  `invalid`.
- **satisfied**: the Hub's verdict that the setting is in as asked since the
  card was posted. A click is not enough: a connector field needs a passing
  provider check after the card; a secret must be saved after it; a harness
  must be observed signed in after it.

## Hub

- `settings-registry.ts` parses addresses, routes each to its domain, keeps
  their order, and writes through a domain. Nothing else knows which domains
  exist.
- One resolver per domain: `settings-domain-connector.ts`,
  `settings-domain-secret.ts` (secret and secret-access) and
  `settings-domain-harness.ts`, wired in `settings-domains.ts`. A resolver
  reads and writes through the same functions the Apps page, Settings ›
  Secrets and the harness actions use (`connectors/credential-policy.ts`,
  `PostgresSpaceSecretRepository`, the Machine daemon list).
- `index-routes-settings-requests.ts`:
  - `POST /api/settings-requests` (Agent Run): posts the card. Its metadata
    `xmatrixSettingsRequest` holds `{ agentName, reason?, requestId?, settings:
    [{ address, proposed? }], askedBy: { userId, runId, channelId,
    instanceId } }`. Connector entries also keep the older
    `xmatrixConnectorFixes`.
  - `GET /api/settings-requests/status` (Agent Run): descriptors without
    values.
  - `GET /api/channels/:channelId/settings-cards/:messageId?sequence=` (person):
    the card's descriptors as that viewer sees them.
  - `PUT /api/channels/:channelId/settings-cards/:messageId` (person):
    `{ sequence, address, value }` makes one of the card's settings through its
    domain.

  The card routes read the card itself from Channel history as the viewer, and
  accept it only when the Hub wrote it (`xmatrixProvenance: system_fact`, a key
  no caller can set). Who asked, and since when, therefore come only from the
  Hub's own card.
- **Wake.** When every setting on an Agent's card is in, the card routes post
  xMatrix's answer once (`settings-ready:<card id>`, kind
  `xmatrix.system.settings-ready`, `xmatrixRequesterInstanceId`). That system
  message is work for the Instance that asked and context for every other
  Instance (`connector-message-delivery.ts`). A stopped connector command's
  receipt needs no answer: its read runs again, and the new receipt wakes its
  caller.
- `cli-commands-settings.ts` defines `xmatrix settings ask|status`, so every
  CLI that passes unknown words to the Hub has it without a release.
- Cards the Hub writes (settings, secret, secret access, harness sign-in,
  cross-Space read) are appended with `appendHubCard`, which delivers them
  live. Before this they were stored but seen only after a reload. To Agents
  they are context.

## Clients

A client draws a card from its descriptors and one widget per control. A
client without the card reads its body: one English sentence that links each
setting to where it is made.

## Not yet

- Cards wait on the Run's owner. They should wait on everyone who can make
  the setting, which needs the Space's admins.
- A setting made outside the card (on the Apps page, say) settles the card
  the next time the card is read. It does not wake the Agent before that.
- The older secret-add, secret-access and harness sign-in cards still have
  their own producers. They move to settings addresses once a stable Web draws
  the settings card. The launch prompt keeps pointing Agents to them until
  then.
- A `file` control (a service-account JSON) and `/settings <connector>` for a
  person.
