# Linear connector

The Space's Linear connection supplies task and project workflows through Channel
commands and MCP. Connect the company OAuth application in Apps (`read write`),
select the intended Linear workspace, then verify the effective scope with
`@linear:workspace:*` and `@linear:list_teams:*`. A successful Check proves the
credential works; it does not prove access to a particular team's issues.
An inaccessible object can return `Entity not found`, even when a separate
personal Linear connection can read it. Check the workspace and team grant
before reconnecting; xMatrix never tries another Space's credentials.

## Discovery and reads

Every invocation is `@linear:<action>:<target> <optional JSON>`. Run
`xmatrix connector list` for current commands. Lists make one provider request,
return at most 50 rows (25 by default), and expose `pageInfo.hasNextPage` and
`pageInfo.endCursor`. Supply `{"after":"<endCursor>","limit":25}` for the next
page. `includeArchived` is explicit. Text output is bounded at 12,000 characters;
use a smaller page when large entries are omitted. Retrieved content is fenced,
untrusted data. Links are never fetched as instructions or credentials.

| Actions | Target | Contents |
| --- | --- | --- |
| `workspace` | `*` | Connected workspace ID/name/key and current user ID/name |
| `list_teams`, `list_users`, `list_project_statuses` | `*` | IDs for team, assignee and project-status selection; member reads omit email, avatars and full profiles |
| `read_team` | Team key or UUID | Team identity and whether cycles are enabled |
| `list_states`, `list_labels`, `list_cycles`, `list_projects` | Team key/UUID or `*` | Workflow state IDs, labels (including workspace labels), cycles and projects |
| `list_issues`, `search_issues` | Team key/UUID or `*` | Task metadata, state, priority, assignee, project, cycle, parent and milestone |
| `read_issue` | Issue key or UUID | Description, state and the first 20 comments; omissions are marked |
| `list_comments`, `list_relations`, `list_subissues`, `list_attachments` | Issue key or UUID | Explicit cursor pages with resource IDs |
| `read_project`, `read_cycle`, `read_comment`, `read_document` | Resource UUID | Selected resource content and metadata |
| `list_milestones`, `list_project_updates` | Project UUID | Project milestone/status and health-update pages |
| `list_documents` | `*` | Document IDs, titles and addresses |

Search accepts only the documented filters, not arbitrary GraphQL:

Text search uses Linear's current `searchIssues(term:)` API; ordinary filtered
lists use `issues(filter:)`. The retired `issueSearch` field is never called.

```text
@linear:search_issues:ENG {"query":"login","priority":2,"limit":10}
@linear:list_issues:ENG {"assigneeId":"<UUID>","stateId":"<UUID>","projectId":"<UUID>","cycleId":"<UUID>","labelId":"<UUID>"}
```

## Task and project writes

Existing `comment` and title/newline/description `create_issue` commands remain
compatible. Issue reads and comments also accept UUIDs. JSON writes reject
unknown fields, invalid IDs, oversized text and incompatible label operations
before any provider call. Names are never fuzzy-matched to write destinations.
Discover IDs first. Nullable fields use JSON `null` to clear a value.

```text
@linear:create_issue:ENG {"title":"Fix login","description":"Reproduce and repair","priority":2,"assigneeId":"<UUID>"}
@linear:update_issue:ENG-42 {"stateId":"<UUID>","priority":1,"assigneeId":"<UUID>","projectId":"<UUID>","cycleId":"<UUID>","dueDate":"2026-12-01","estimate":3}
@linear:update_issue:ENG-42 {"assigneeId":null,"projectId":null,"cycleId":null,"parentId":null,"projectMilestoneId":null,"dueDate":null,"estimate":null}
@linear:update_issue:ENG-42 {"addedLabelIds":["<UUID>"],"removedLabelIds":["<UUID>"]}
@linear:comment:ENG-42 Implementation ready; review needed.
@linear:create_relation:ENG-42 {"relatedIssueId":"ENG-43","type":"blocks"}
```

`update_issue` also accepts `title`, `description`, `teamId`, `parentId`,
`projectMilestoneId`, and replacement `labelIds`. Creation accepts the same task
fields except `teamId`, `addedLabelIds`, and `removedLabelIds`; its target owns
the team. Create subtasks with `parentId`. Relation types are `blocks`,
`duplicate`, `related`, and `similar`. `update_comment:<UUID> {"body":"…"}`
edits an existing comment.

| Writes | Input |
| --- | --- |
| `create_project:<team>` / `update_project:<UUID>` | `name`, `description`, `content`, `statusId`, `priority`, `leadId`, `memberIds`, `startDate`, `targetDate`, `color`; update also accepts nonempty `teamIds` |
| `update_cycle:<UUID>` | `name`, `description`, `startsAt`, `endsAt`, `completedAt`; explicit date pairs must be ordered ISO timestamps |
| `create_label:<team or *>` / `update_label:<UUID>` | `name`, `description`, `color` (`#rrggbb`), `parentId`, `isGroup`; `*` creates a workspace label |
| `create_document:*` / `update_document:<UUID>` | `title`, `content`, `projectId`, `issueId`, `cycleId`, `teamId`, `parentDocumentId` |
| `create_milestone:<project UUID>` / `update_milestone:<UUID>` | `name`, `description`, `targetDate` |
| `create_project_update:<project UUID>` / `update_project_update:<UUID>` | `body`, `health` (`onTrack`, `atRisk`, `offTrack`) |
| `create_attachment:<issue>` / `update_attachment:<UUID>` | HTTPS `url`, `title`, optional `subtitle`; update edits title/subtitle; this links a resource and does not upload bytes |

All writes pass the existing Channel policy and execution machinery. For an
approval request, issue identifiers and team keys are resolved to stable IDs
before asking; the approved destination remains frozen. Execution rechecks
write authorization after destination lookup and immediately before mutation.
Only an explicit provider `success: true` and expected resource identity can
produce success. GraphQL partial errors, missing confirmation, rate limits and
transport errors fail visibly; uncertain mutations are never automatically
repeated.

### Archive, restore and removal

`archive_issue`, `unarchive_issue`, `unarchive_project`,
`archive_cycle` and `archive_project_update` affect one explicit object.
`delete_issue` uses Linear's default trash operation and never requests permanent
deletion. `delete_project` calls the current `projectDelete` API; the retired
`projectArchive` mutation is not exposed. `delete_comment`, `delete_relation`, `delete_label`, `delete_document`,
`delete_milestone` and `delete_attachment` remove the named object. These lifecycle
actions default to per-request approval; existing task/project writes keep the
platform's normal default. Only a human Space admin changes Channel policies.

## Cycle creation

Linear has retired its `cycleCreate` mutation with the explicit deprecation
reason "Cycle creation is not supported." The connector therefore does not
advertise or call it. Enable and schedule cycles in Linear Team Settings;
Linear automatically creates them. Use `list_cycles`, `read_cycle`,
`update_cycle`, and task `cycleId` assignment with those existing cycles. A team
with cycles disabled returns an empty list; this is not a failed connection.
See [Linear cycles](https://linear.app/docs/use-cycles).

## Events and acceptance

Subscribe with `@linear:subscribe:eng issue comment`, or `*` for project,
project-update and cycle events. OAuth app webhooks are signature-verified,
freshness-checked and deduplicated. Each Space receives an event only if its own
current grant can read the event's subject; reconnect races cannot reuse an old
grant's visibility proof. Existing subscriptions and their features remain
compatible. New actions require no extra OAuth scopes beyond `read write`.

A deployment is not native acceptance. Verify these through an isolated fixture
in our workspace, never a customer's tasks:

1. Read the connected workspace, teams, states, members and project statuses.
2. Create a uniquely marked project, label, document and task; read/search them.
3. Change task state, priority, assignment, project, cycle, labels, parent and
   dates; verify the actual returned object and a fresh read/search.
4. Write/edit a comment, dependency, milestone, project update and linked resource.
5. Observe signed issue/comment events in the subscribed Channel; replay must
   not duplicate effects. Check disallow/ask boundaries without changing policy
   as an Agent, and retain explicit approval receipts for lifecycle tests.
6. Record revocation/reconnection and removal tests separately; unperformed
   checks remain open. Code tests use fixed provider responses to exercise
   false/partial confirmations, destination mismatch and authorization races.

The API is Linear's documented [GraphQL API](https://linear.app/developers/graphql),
with fixed selections checked against the
[official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql).
Account membership, billing, OAuth grant administration, arbitrary GraphQL and
file-byte uploads are outside these collaboration actions.
