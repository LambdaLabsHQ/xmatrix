# A new account's first Space

A person who opens xMatrix with no Space at all lands in one of their own,
named after them ("Ada Lovelace's Space", or the email's name part when the
account has no name). Without it the first screen is an app with no Space, in
which nothing can be done and nothing says how to start.

- `POST /api/personal-space` (Web: `/api/xmatrix/personal-space`) creates it.
  The Web shell calls it only when the Space list it loads is empty.
- The Hub creates it only for a Human session whose account has no Space at
  the moment of the call. Agent Runs are refused by the Run route allowlist.
  Anyone who already has a Space, including someone who arrived through an
  invite or join link, gets `{ "space": null }` and nothing is created.
- The Space id derives from the account id and the command id is fixed per
  account, so a retry or a second tab replays the same `create-space` command.
  Once the personal Space exists, deleting it does not bring it back: the next
  call conflicts on the id and returns `{ "space": null }`.
- It is an ordinary Space with the caller as its owner. It can be renamed,
  shared and deleted like any other.
- A plan's allowance of Spaces per account may leave it out: the Hub passes
  its id (and `private:<user id>`, which held a person's Channels before
  Spaces existed) to the billing policy's `spaceCreation` check. The official
  policy refuses a new Space (`402 free_space_limit`) while the account owns
  two Free Spaces besides these; paid and deleted Spaces do not count.

## The welcome conversation

The personal Space opens with a conversation in which xMatrix, not the owner,
tells a new person how to bring their agents in. Agents run on the person's
own computer, so a Space without one can do nothing; the first thing it says
is how to connect one.

- `POST /api/spaces/:spaceId/welcome` (Web: `/api/xmatrix/spaces/:spaceId/welcome`)
  makes it. The Web shell calls it when a Space it shows has no conversation;
  only the caller's own personal Space gets one, and any other Space answers
  `{ "channelId": null }`. Agent Runs are refused.
- The conversation is closed ("Welcome to xMatrix", only the owner) and its
  id derives from the Space. Each message has a fixed id and command, so a
  reload, a second tab or a retry replays it instead of adding one:
  - `bring-agents`, at once;
  - `agents-in`, once the Space has an enabled agent; the Web asks again when
    it sees one, and the Hub checks the fact before writing.
- The messages are `xmatrix.onboarding.v1` system notices (`xmatrixSystemNotice`,
  `system_fact` provenance), written under the owner's principal with the
  xMatrix label, so no Agent takes them as the owner's request. A message names
  only its step; the Web draws what the step shows from the facts (the setup
  command and its approval, the machine's agents, the Space's registrations),
  so the conversation reopened later shows what happened, never a stale command.
