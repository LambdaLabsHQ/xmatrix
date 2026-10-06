# Open-project governance

Status: implemented (roles, joining, intake, governance page, promotion on
merge). Builds on pages, claims and the GitHub claim check
([`pages-and-conversations.md`](pages-and-conversations.md) §5.6).

An open project is a Space anyone can take part in. Attention is its scarcest
resource, so only trusted identities doing claimed work may spend it: new
people are heard, but through an intake that an Agent triages against the
project's own written rules, and they earn more reach by contributing.

## 1. Joining

- A Space owner or admin turns on **open participation** (Team, on the Space).
  From then on anyone signed in whose GitHub account is linked (their profile,
  the same link the claim check uses) can join it directly with no admin
  review: its public pages offer "Take part in this project", which leads to
  `/spaces/join/<space>`.
- There are no anonymous participants: every Agent acts under a verified
  human, and its actions count against that human.

## 2. Trust levels are the Space's roles

Trust is not a second concept beside roles. In any Space, open or not, a
person's role is their level, and the capabilities follow from it.

| Level | Role | Can |
|---|---|---|
| visitor | not a member | read published pages |
| participant | `participant` | read the Space's open conversations and pages; start conversations, which go to intake; write in the conversations they started; bring their own Agents on their own budget |
| contributor | `member` | everything a member can today: claim blocks, edit pages, start work with the project's Agents |
| committer | `member`, vouched | also open blocks for competition and triage intake |
| maintainer | `owner` / `admin` | everything, including editing the governance page and the roles of others |

- **Earned, not requested.** A participant becomes a contributor when a pull
  request of theirs that names one of the project's blocks is merged: the
  claim check already knows who they are through their linked GitHub account.
  A maintainer may also promote or vouch for anyone.
- **Identity sets the budget; there is no content filtering.** Nothing reads a
  participant's words for keywords; what they can reach is decided by who they
  are and what they have contributed.

## 3. Intake

- A conversation a participant starts is marked **intake**. It is not listed
  for the Space's other members by default; it has its own Intake list.
- The project's triage Agent (the Focus gardener of the Space, run by a
  maintainer's registration) reads intake against the governance page and, for
  each conversation, does one of three things:
  - merges it into an existing conversation or page block, linking it there;
  - writes what is valuable into the right block, or into the root page's
    *Needs attention* section;
  - lets it sink, saying why in the conversation.
- Maintainers read pages, not the intake list. Owners and admins still see
  it, at the top of their conversation list, and the triage Agent reads it
  with `xmatrix channels --intake`.

## 4. The rules are a page

- A maintainer marks one page as the Space's **governance page** (its Share
  dialog: only owners and admins edit this page). Only maintainers edit it; everyone can read it.
- The triage Agent and Jev apply it by meaning. There are no filters or flags
  derived from it.
- Every moderation action (a triage outcome, a promotion, a removal) is
  recorded with who did it and why, and the person affected can reply in the
  conversation where it happened.

## 5. Pull requests

- A pull request names the block it works on; the `xmatrix/claim` check passes
  when its author holds a claim there (§5.6 of the pages design).
- A participant cannot claim, so their pull request fails the check with
  the way in: talk in their intake conversation, or ask a contributor to
  claim the block. Once merged, it promotes them (§2).
- Pre-review runs before a maintainer sees claimed work (§5.6).
