# Onboarding: bring your work in

Status: design, 2026-10-07. Product context: the Space page "Onboarding" (P2).
Positioning: "import is activation". The first aha moment is seeing your own
work turned into living pages by your own agents.

## Problem

A new Space is empty. Its people already keep their work somewhere:

- repositories on GitHub;
- documents in Notion;
- decisions in Slack;
- projects on their own machine that Claude Code or Codex already work in.

Today xMatrix can draft a Space's first page tree only from one GitHub
repository, and only once. Notion, Slack and local projects reach pages only
if someone copies them by hand. None of the four competitors in the
"Competitors" page imports any of these.

## Experience

After the agents are in (onboarding P1), the Space's empty screen asks one
question: **Where is your work today?** It offers four optional sources, and
each one starts from something the person already has.

| Source | What the person does | Where the content comes from |
| --- | --- | --- |
| Projects on this computer | Ticks projects from the list the desktop app found (folders Claude Code and Codex worked in) | The Agent reads them on that machine |
| GitHub | Picks repositories of the Space's GitHub connection | The Hub reads the repository (as today) |
| Notion | Connects Notion, then picks pages in Notion's own consent screen | The Agent reads them through the Notion connector |
| Slack | Connects Slack and picks channels | The Hub imports the channels as conversations of this Space |

One button, **Draft our pages**, opens one import conversation. The person
watches their Agent write the page tree, then reviews and applies it in Pages
(the existing migration review). The Agent ends with one next step, usually a
conversation about the most urgent open item it found.

## Design

### One import, many sources

- `POST /api/spaces/:spaceId/page-migration/import` accepts
  `{ sources: [...] }`. Each source is one of:
  - `{ kind: "github", repo }`;
  - `{ kind: "notion", pages: [{ id, title }] }`;
  - `{ kind: "slack", conversations: [channelId] }`;
  - `{ kind: "local", machineId, paths: [path] }`.
- The existing `{ repo }` body keeps working as one GitHub source.
- The Hub writes one prompt as a **manifest**: each source and how to read it.
  It does not paste contents. Only GitHub is pre-read, as today, under the
  existing budget. Everything else the Agent reads itself, with tools it
  already has:
  - Notion: `notion__read_page`.
  - Slack: `xmatrix channel history` on the imported conversations.
  - Local projects: the files themselves.
  This keeps the prompt small however many sources there are, and keeps
  private file contents off the Hub.
- **Local projects:** the launch goes to the owner's registration on that
  Machine, with the first chosen path as the working directory. The other
  chosen paths must be registered Workspaces the Agent is granted. The desktop
  registers them when the person ticks them (`registerWorkspace`, as the first
  task card does today).
- **Slack:** `POST /api/migrations/slack` gains an optional `spaceId`
  (owner or admin) and imports into that Space instead of creating one. The
  imported conversations are then valid draft `sources`, so each page links
  back to the discussion it came from. Today the Slack reader runs only in the
  CLI; this needs a Web path, either the Hub fetching channel history with the
  OAuth token the existing device flow obtains, or the desktop app running the
  CLI migration.
- **Notion:** add a `search` read action (Notion `POST /v1/search`) that lists
  the pages the person granted. The picker shows them, and the manifest names
  their ids. Child pages are listed by the Agent with `read_page` on each.

### Eligibility first, then the conversation

The import conversation is opened only after the Hub has checked that a
registration can be launched:
- an online daemon;
- the chooser configured;
- for local sources, a registration on that Machine.

If it can't, the screen says what is missing. Usually that is "Bring your
agents in", P1. This fixes today's empty `Import …` conversation left behind
by a failed launch.

### First time and every time after

- **A Space that has not moved to pages** gets the reviewable migration draft,
  as today. The person sees the whole tree before it exists, and applies it.
- **A Space that already has pages** cannot take a second migration (409
  `page_migration_applied` today). Its import writes pages directly. The
  manifest tells the Agent to place them under a page named for the source
  and to link them from the root page's sections. Ordinary page edits are
  already the living-document norm, and every edit is attributed and
  reversible.

### Provenance

Draft `sources` stay conversations only, which is the existing authority rule.
Pages written from GitHub, Notion or local files link to their origin in the
body ("From README.md", "From Notion: Roadmap"). Slack pages cite the
imported conversations as real sources.

## Order in onboarding

Drafting needs a running Agent, so "Bring your work in" follows "Bring your
agents in". The person may connect Notion, Slack or GitHub earlier, from Apps
or from the step itself. The draft button turns on once an agent is in the
Space.

## Phases

1. Multi-source import for GitHub, Notion and local projects. This covers the
   manifest prompt, the eligibility check before opening the conversation, the
   Notion `search` action, local launch routing and the Web step.
2. Slack into an existing Space through the Web.
3. Imports into a Space that already has pages.
4. Linear and Google Docs as further sources (their read actions exist).

## Open questions

- Should the Hub ever draft without a user's Agent? Not now: xMatrix AI supply
  is paused (page "xMatrix AI"), and the user's own Agent is the product's
  point.
- Notion databases: read as one page per row, or as a table page? Proposed: a
  table page, with rows linked.
