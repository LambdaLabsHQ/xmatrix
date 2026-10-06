# Pages and Conversations — migration surface and plan

Status: done (2026-09-27). Phases 0–5 shipped: every Space runs on pages,
and the contract migration `0112_contract_pages_cutover` dropped the Channel
tree, archive state and tree views, keeping what they said in each Space's move
record. Channel memory left the product; its entries stay as data. Companion to
[`pages-and-conversations.md`](pages-and-conversations.md).

## 1. The decision that sizes everything

**A Conversation keeps the Channel's identity.** A conversation is an existing
Channel row and `channel_id` with three things removed:

- product meaning of `parent_channel_id`;
- archive state;
- view modes.

Pages are a new domain.

Everything keyed by `channel_id` therefore stays where it is and keeps working
unchanged:

- messages and sequences;
- replies, reactions, annotations and attachments;
- mentions and invocation status;
- Runs, Instances and Launches, and summon decisions;
- Automations and their occurrences;
- per-Channel entity coordinators;
- unread and search;
- cross-Space read grants;
- App connector bindings;
- trace access.

In the database, 34 of 99 migrations reference `channel_id`. None of those
tables change.

The alternatives are worse:
- introducing a new conversation id and re-keying those tables would be a
  migration of the whole data plane for a product rename;
- pages as "special Channels" would keep the overloaded object this proposal
  exists to remove.

## 2. Surface inventory

The table counts non-test source files that reference each concept. It is a
map of where work is, not an estimate of effort per file.

| Concept | Hub | Protocol | DB | CLI (Rust) | Web | Desktop | iOS / Android |
|---|---|---|---|---|---|---|---|
| Channel hierarchy (`parentChannelId`) | 31 | 3 | 8 | 7 | 12 | 1 | 0 |
| Archive (`archivedAt`, `archiveReason`, `channel_archive`) | 42 | 6 | 11 | 10 | 9 | 0 | 0 |
| Threads (thread roots, opened-thread context) | 31 | 1 | 4 | 5 | 21 | 0 | 0 |
| Child views / view preferences | 12 | 0 | 4 | 0 | 9 | 0 | 0 |
| Channel memory (`xmem.*`, `MEMORY.md`) | 2 | 2 | 3 | 6 | 0 | 0 | 0 |
| Focus (intents, review) | 20 | 6 | 3 | 2 | 12 | 0 | 0 |
| Overview | 0 | 0 | 0 | 0 | 4 | 0 | 0 |
| Channel move / transfer | 5 | 1 | 4 | 3 | 9 | 0 | 0 |

The native iOS and Android apps are Web containers (`WebContainerView.swift`,
`NativeBridge.java`), so they need no product change. Desktop has one reference.

### 2.1 Database

| Object | Today | Target |
|---|---|---|
| `data.channels.parent_channel_id` | Product hierarchy, and thread-to-root link | Carries no product meaning after cutover; dropped by the contract migration |
| `data.channels.archived_at`, archive metadata (`archiveReason` in `metadata_json`) | Archive state | Folded into pages at migration; dropped by the contract migration |
| `data.user_space_channel_view_preferences` | Tree / list / focus preference per user, pins, follow-up schedule | Tree views (`child_views_json`) dropped; pins and the schedule stay |
| Channel-catalog paging indexes (`0033`) and thread history lookup (`0035`) | Paging by parent and by thread | Replaced by a single activity-ordered conversation index |
| Memory annotations (`xmem.canonical.v1`, proposals) | Channel memory, inherited down the tree | Converted into page documents; the annotation namespaces are retired |
| `data.channel_transfer_proposals` | Moves a Channel subtree between Spaces | Moves one conversation; moving pages is a separate page operation |
| New: `data.pages` | — | id, Space, parent page, title, position, permissions, attached config, version |
| New: `data.page_revisions` | — | Immutable linear markdown revisions per page, with authors, source conversations and time; purge is bounded and audited |
| New: `data.page_links` | — | conversation ↔ page/block, source, created-by, created-at |

### 2.2 Hub

**Removed product paths:**
- child-Channel creation saga (`thread-root-channel-create.ts`,
  `relay-channel-family-child-registration.ts`);
- thread-root archive (`relay-authority-thread-root-archive.ts`);
- domain archive (`relay-authority-methods-domain-archive.ts`);
- opened-thread context (`channel-opened-thread-context.ts`);
- parent-scoped catalog reads (`relay-channel-catalog-product-read.ts`,
  `postgres-channel-catalog-authority.ts`);
- `channel_archive` and the archive-reason form of `channel_update` in
  `product-management-operations.ts`;
- the move routes.

**New:**
- Page catalog and revision authority (PostgreSQL).
- One page Durable Object per page hosting the live session (Yjs sync,
  awareness, auth). It commits revisions on idle and holds no authority of its
  own.
- A per-user git remote view over the page store (a later feature, see §4).
- Link authority.
- Presence read model, derived from Run and Instance state plus editor
  awareness.
- Page-scoped launch targets and page-context assembly for Jev
  (`registration-launch-context.ts` reads linked pages instead of ancestor
  Channels).

**Channel family:** A family today is one root Channel plus its thread
subchannels, which share one data closure and locator. After the PostgreSQL
cutover, message authority is per `channel_id` in PostgreSQL. Family membership
becomes a storage placement fact only:
- migrated threads stay where they are physically;
- new conversations are their own family roots;
- no product code reads family membership as hierarchy.

### 2.3 Protocol

- **Removed:**
  - `ChannelCatalogPageView` members `tree` and `archive` (`flat`, `direct` and
    `search` remain);
  - `parentChannelId` on channel serialization;
  - archive fields;
  - `rootMessageId` thread-origin fields;
  - the memory annotation types.
- **Added:** page, page link and presence types, the page-document sync
  messages, and the Run completion report's `pageUpdates`.
- **Focus snapshot:** a new `formatVersion` whose rows point at page blocks
  instead of Channels.

### 2.4 CLI and runtime (Rust)

**Commands:**

| Command | Change |
|---|---|
| `channel thread` | Removed |
| `channel create --parent` | Removed |
| `channel move --parent/--root` | Removed |
| `channel delete` (archive request) | Removed |
| `memory list/get/propose` | Removed |
| `channels` | Becomes the activity-ordered conversation list |
| `page tree`, `page read`, `page edit` | New; they use yrs to make minimal edits with a freshness check |
| `page link` | New |

**Bootstrap prompt (`core/src/bootstrap.rs`):**
- the thread, memory and channel-organization instructions become page
  instructions;
- the write-back contract is added.

**Space mirror (`memory/src/space_mirror_*`):** deleted. Management Runs read
the Space on demand (`xmatrix page`, `xmatrix channel history`) like any Run.

**Channel read context (`core/src/channel_read_context.rs`,
`channel/src/read_context.rs`):**
- the "picked up; work continues in the thread" annotations are removed;
- linked-page cards are added.

**Run completion:** the final report carries `pageUpdates` (block ids) or an
explicit empty set, and the runtime refuses to complete a Run that omits it.

### 2.5 Web

- **Rail:** Pages, then Conversations, then tools (`workspace-shell-chrome.tsx`).
  The mobile bottom bar follows the same order.
- **Removed:**
  - `ChannelChildView` and `channel-child-views.ts`;
  - `use-channel-view-preference`;
  - the tree sidebar and the Archive category;
  - Overview (`sidebar-management-overview-model.ts` and its entry in
    `workspace-channel-sidebar.tsx`);
  - thread panes (`open-thread-channel.ts`, the thread composer);
  - the channel move and transfer UIs for subtrees.
- **New:**
  - the page editor (Yjs block editor, cursors, attribution, history, suggest
    mode);
  - the per-block presence gutter;
  - the conversation list;
  - live page cards in conversation headers and messages;
  - "Discuss this block".

### 2.6 Focus and management

- **Prompt sections** (`docs/prompts/focus-review-sections.md`,
  `focus-review-prompt-sections.ts`):
  - rewrite `selection`, `open-loops` and `projects` against pages, links and
    presence;
  - delete `evidence-boundary` (the archive rules), `cleanup` and
    `archive-reasons`.

  These are prompt data, so they change without a Hub release once the page
  surfaces exist.
- **Management operations:** `channel_archive` and archive-reason updates are
  replaced by page edits through the same audited management-operation path.

### 2.7 Phase 0 findings

These are the answers to the three facts that phase 0 had to verify, taken
from `main` at `d7ac4e9c9`.

1. **Channel-family placement.** Production runs `MESSAGE_AUTHORITY =
   "postgres"` (`packages/hub/wrangler.toml`). Every message operation in
   `channel-messages.ts` takes the PostgreSQL branch keyed by
   `channel_id`. Family Durable Objects, family directory routes and the
   capacity partitions are read only on the retired `durable_object` branch and
   by migration and verification tooling.

   Disposition: flattening conversations needs no data movement. The
   retired-branch family code is deleted in phase 5, together with its
   child-registration saga.
2. **How access is derived.** Channel read authority is
   `channelCapabilityPredicate` (`packages/db/src/channel-capability-policy.ts`).
   It uses the Channel's own mode and its own `data.channel_access` rows, plus
   the Space owner/admin role. Nothing is derived from the parent at read time.
   The one parent-derived rule is at thread creation: the Hub copies the
   parent's `mode` (`index-routes-channel-agent.ts`, and Web
   `use-workspace-shell-actions.ts`). For a closed parent it grants only the
   creator.

   Disposition: step 4 of §3 grants former threads of closed parents their
   parent's access rows.
3. **Other consumers of `parent_channel_id`:**

   | Consumer | Location | Disposition |
   |---|---|---|
   | Cross-Space read grants | `cross-space-read-control.ts:406` extends a Channel-scoped grant to that Channel's threads | Channel grants become conversation grants. A new page-scoped grant covers the conversations linked to that page. At migration, each Channel grant that is active and unexpired is expanded into the equivalent conversation grants. |
   | Channel transfer between Spaces | `channel-transfer.ts` snapshots the recursive subtree | Transfer moves one conversation. Pages move with a separate page operation. |
   | Channel tree read, move, ancestors | `space-control.ts` (the `CHANNEL_TREE_QUERY_TEXT` recursive query, move and ancestors, archive cascade) | Removed; the page tree replaces it. |
   | Catalog `has_children`, parent paging | `channel-catalog.ts` | Removed; the conversation list is flat. |
   | Thread-root lookup for message rendering | `message-control.ts:2660` | Removed; the "picked up in thread" annotations go away. |
   | Management overlay: archived threads and memory | `management-overlay-control.ts` | Deleted; management Runs read on demand. |
   | Memory inheritance | `channel-memory-control.ts` (recursive ancestor chain) | Replaced by page context. |
   | Focus management | `focus-management-control.ts` | Deleted; Focus is an ordinary page goal with an Automation. |
   | Exports | `relay-control-plane-retirement-export.ts`, `relay-authority-methods-export-recovery.ts` | Retired-branch tooling only; deleted in phase 5. |

## 3. Data migration

A Space moves to pages by having its knowledge rewritten, not by converting
its Channels. The Channel tree and Channel memory are material for that
rewrite; neither is copied.

1. **Draft.** A Space owner or admin asks an Agent, in any conversation, to
   draft the move. The Agent is an ordinary Run of that owner or admin and
   acts with its own Run proof and its owner's access; there is no dedicated
   launch path or identity. It reads the Space's conversations and memory and
   writes a new page tree as documents: decisions still in force, current
   state, goals and open work, briefly. It organizes pages by what the Space
   works on, merging, splitting and dropping freely; page count and depth
   follow the content, not the Channel tree. Each page names the
   conversations it was written from. The Agent submits the whole draft with
   `xmatrix page migration submit`; the process stays in the conversations.
2. **Sources.** A draft cites only conversations its author may read, never a
   direct conversation. Reading a draft applies the same rule to its reader.
3. **Review.** The owner or admin reads the drafted tree in Pages, drops or
   renames pages (a dropped page's children move up), and applies it. There
   is no per-page approval. Every submission and revision is compare-and-set
   on the whole draft, and the draft's author is the authenticated Run. The
   owner or admin may instead tell an Agent to apply it: an owner's or admin's
   Run applies the draft by naming that message. The Hub reads it and binds it
   to the operation: a live message by a human who is a current owner or
   admin, in the Run's own conversation, sent after the current draft version
   was submitted, and readable by the Run. Whether it says to apply is the
   Agent's reading, not a keyword match. The
   record keeps the Agent as the one who applied it and the message as its
   authorization; no human is recorded as having applied it.
4. **Apply.** One transaction creates the pages, their first revisions
   authored by the drafting Agent, and a `source=migration` link from each
   page to each of its sources, and records who confirmed it. Page ids derive
   from the Space and the draft key, and new top-level pages follow any page
   already written by hand. A page written from a closed conversation is
   restricted to the users who read every one of its closed sources at the
   moment of applying; Space owners and admins read restricted pages as
   always. Applying again returns the applied migration unchanged.
5. **Cut over.** Product reads switch to pages and the flat conversation list.
   `parent_channel_id` and archive columns stay intact and unread until the
   contract migration, so rolling back is an exact-SHA Hub redeploy.
6. **Contract.** `0112_contract_pages_cutover` first moves every Space that
   has not applied its move (maintainer decision, 2026-09-27: the platform
   moves them rather than waiting for each owner). A drafted move is
   published as drafted. Any other Space gets a page tree built from its own
   Channel tree: a page for the Space carrying Needs attention, and a page for
   each Channel that kept memory or had Channels under it, holding its
   summary, its memory (goals first) and the closing lines of its archived open
   conversations; every other open conversation is linked to the page it sat
   under. The same rules as an owner's apply: sources are the Space's own,
   never direct; a page from a closed conversation is readable only by those
   who read all of its closed sources; no memory entry, message or
   conversation is rewritten or deleted. Each Space's move record keeps what the
   dropped columns said (`retiredChannelTree`: every Channel's parent, and when
   and why each archived Channel was closed), so no fact is lost. In the same
   transaction it drops
   `parent_channel_id`, `archived_at`, the archive metadata and the tree-view
   column (the view-preference table stays: it holds pins and the follow-up
   schedule), and rebuilds the indexes that carried an archive condition.

**Starting from a repository.** A Space that has not moved to pages may
start from one of its GitHub repositories instead of its conversations: an
owner or admin picks a repository of the Space's GitHub connection in Pages.
The Hub reads it with the Space's installation (its README, markdown
documents within a budget, and open issues and pull requests), opens an
`Import owner/repo` conversation (the same one each time), and launches an
Agent of that owner's or admin's there with what it read. The Agent drafts and
submits the page tree exactly as in step 1, citing no conversations, and the
owner reviews and applies it as in steps 3 and 4. The GitHub App needs
Contents: read and Issues: read on the repository.

Applying a draft publishes those documents; it does not declare the old
material obsolete. No message, attachment, reaction, memory entry or Run
record is rewritten or deleted at any step.

## 4. Build plan

Each phase ships complete behavior. No phase adds a surface that a later phase
removes.

| Phase | Delivers | Exit criteria |
|---|---|---|
| **0. Verify** | Written answers for the three open facts: family-placement readers, read-time access derivation for threads, and every consumer of `parentChannelId` in exports and cross-Space grants. | Each consumer has a disposition (unchanged / page / removed) in this document. |
| **1. Pages** | Page catalog and revision store, the per-page live-session DO, Web editor with cursors, attribution, revision history and suggest mode, `xmatrix page tree/read/edit`, and the Pages rail entry. | Humans and Agents co-edit one page live; an Agent edit made concurrently with a human keystroke loses nothing; permission changes take effect on open connections. |
| **2. Links and presence** | Link authority, Jev attachment at conversation start, the presence gutter, live cards, and "Discuss this block". | Opening a page shows who is on each block within one second of their state changing; links never widen access. |
| **3. Pages become the context** | Agent context comes from linked pages; the mirror renders the page tree; the write-back contract is enforced in Run completion; the Focus gardener prompt ships. | A Run cannot complete without a page-update report; a Focus review selects only from pages, links and presence. |
| **4. Migrate and cut over** | Agent-drafted page trees with their review and apply,  the flat conversation list, and the new rail. Removed from the product: tree, views, archive, Overview, threads, memory commands and move. | Every Space has applied a drafted page tree whose pages never widen their sources' readers; there are zero product reads of `parent_channel_id` or archive state. |
| **5. Contract** | Drop the columns and tables, and delete the retired Hub, CLI and Web modules and their tests. | `knip` and the guardrail review show no remaining references; the contract migration is applied through the normal release path. |

**Order constraints:**

- Phase 3 depends on 1 and 2.
- Phase 4 depends on 3, because Agents must already work from pages before the
  tree disappears.
- Phase 5 waits for the rollback window after phase 4.
- Phases 1 and 2 can overlap once the page catalog schema lands.

Phases 0–5 are the **core loop**. The first adopter is the x-matrix Space
itself: it runs on the new model for one to two weeks before any external
launch, to prove that one person plus Agents can hold the whole picture through
pages.

**Later features.** Each is complete on its own and none is a transitional
surface:

- the per-user git remote view over the page store;
- public pages (server-rendered and indexable) with the "maintained on xMatrix"
  footer;
- import onboarding from GitHub, Slack, Notion and Feishu, which generates an
  initial page tree;
- the GitHub App for open-source projects: project page generation, an
  `xmatrix/claim` status check and pre-review;
- open-source governance: trust levels, the intake queue, claims as leases and
  cross-project reputation.

## 5. Compatibility and release

- **CLI versions:** Commands removed in phase 4 are simply gone from the CLI,
  and the bootstrap prompt never offers them. An older CLI keeps working
  against the Hub until phase 5 removes the routes it calls. The daemon's
  auto-update moves CLIs forward. Ordinary Runs now read page context on demand
  with `xmatrix page linked`; the automatic `PAGES.md` mirror has been retired
  (see [`docs/channel-mirror.md`](../channel-mirror.md)). Launch commands already queued for older
  daemons stay decodable until the release's acceptance accounts for them
  (guardrail 7).
- **Cutover order:** Every Space applying its migration is the condition
  for completing phase 4 (§4), not for releasing the cutover. The release
  ships first, and until a Space applies it, the Space shows its flat
  conversations. Its Channel memory stays readable through
  `xmatrix memory list` and `xmatrix memory get`, but it is no longer
  discovered as default Agent context, because context now comes from pages.
  Owners and admins keep a "Move to pages" entry in the Pages header until the
  migration is applied, however many pages the Space already has. The phase 5
  contract migration moves every Space that has not applied its own (§3.6).
- **Release flow:** The expand migrations (new tables) ship in phases 1–2. The
  contract migration ships alone in phase 5 through the agent release workflow
  (guardrail 4). No release applies a contract migration ahead of the Hub that
  stops reading the dropped columns.
- **Surfaces outside the product:**
  - exports;
  - cross-Space read grants (`--whole-space` stays; per-Channel grants become
    per-conversation);
  - App connector bindings (stay on conversations, which are linked to the
    page sections they serve) and Automations (belong to a page section and
    execute in a conversation of their own, `pages-live-document.md` §6);
  - public docs at `/docs`, updated in phase 4.

## 6. Risks

| Risk | Mitigation |
|---|---|
| A draft misses or misstates something | The owner reviews the whole draft before it is published; conversations and memory stay intact and citable, and pages are revised like any page afterwards |
| Access regresses for former threads | Explicit access materialization plus before/after effective-reader comparison that fails closed |
| Agents keep acting on old instructions | The bootstrap prompt and Focus prompt change in phase 3, before the tree disappears; removed commands fail with a typed error that points to the replacement |
| CRDT edits by Agents clobber human work | Minimal-operation edits, freshness check, and attribution; suggest mode for sensitive pages |
| Page documents grow unbounded | Update-log compaction into snapshots; the gardener keeps bodies short; history lives in the editor, not the body |
| Contract migration applied early by another train | Phase 5 ships in its own release after the rollback window; the release workflow's pre-applied-migration check stays in force |
