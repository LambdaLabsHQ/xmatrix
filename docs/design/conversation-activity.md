# Conversation activity

Status: accepted and built (2026-09-27; see §8). Owner: Yiming Hu. Refines §4.3 of
[`pages-and-conversations.md`](pages-and-conversations.md) (what a
conversation shows besides messages).

A conversation is where people and Agents talk. Today it is also the only
place an Agent's progress can appear, so Agents narrate it, and the
conversation fills with status reports that a reader has to wade through to
find what was said to them. This design keeps talk in messages and moves
progress to where it belongs: an ordered, compact activity record, a live
"now" line, and folding of status reports once they are out of date.

## 1. What is wrong today

- **The contract forces narration.** The shared channel contract
  (`packages/cli-rs/crates/core/src/bootstrap.rs`) tells every Agent to post
  before any work, after finding context, before verification and when done.
  The Agent is the only sensor the conversation has, so it writes its plan,
  its steps, its CI results and its pull requests out by hand.
- **Narration is expensive for everyone else.** An ordinary message is
  delivered as work to every other live Instance in the channel
  (`channelMessageDeliveryIntent` in
  `packages/hub/src/runtime-transport/channel-message-frame.ts`), so each
  status line queues a turn for every peer.
- **Everything is shown at full weight.** A status report looks like a
  question, a decision or a result: same header, same size, same unread mark.
  Every message repeats the sender's five identity tags (owner, machine,
  branch, model, effort), which are constant for a Run.
- **Two of the reader's four questions have a home, two do not.** A reader
  asks *what is happening now* (the work dock and the invocation state on a
  mention answer part of it: whether an Agent is working, not on what), *what
  changed while I was away*, *who did what, in which order*, and *what exactly
  happened in one step* (the host trace answers this). The middle two only
  exist as narration.

## 2. Principles

1. **Order lives in one sequence.** Everything that happens in a conversation
   is an entry in the Channel's timeline sequence. Presentation may make an
   entry smaller; it never moves it.
2. **State is superseded, speech is not.** A status report stops mattering
   once a newer one exists; a question, decision, finding or result does not.
   Superseded state folds into one line where it was. Speech stays whole.
3. **Facts are recorded by their source.** A step completed in an Agent's own
   plan is reported by the runtime that saw the plan change; a pull request is
   reported by the Run that opened it. The Agent does not restate them
   (parent design §2.4: facts with an authority are referenced, not restated).
4. **Language decides salience, not syntax or author kind.** Whether a
   message is superseded is judged from what the messages say (Jev), with one
   rule for people and Agents. No flag, command or sender kind decides it.
5. **People and Agents read the same structure.** The web timeline and
   `xmatrix channel history` fold the same entries the same way.

## 3. Model

### 3.1 Speech

Ordinary messages (`xmatrix.message.text`) are unchanged: delivered as work,
counted as unread, notified through attention when they mention someone.

### 3.2 Activity entries

An activity entry is a message with `messageKind: "xmatrix.activity"` and
metadata `{ xmatrixProvenance: "activity", xmatrixActivity: <activity> }`.
It is written only by the Hub from a typed report; no caller can create one
by supplying metadata (§6).

| Kind | Reported by | Carries |
|---|---|---|
| `plan` | The Run's runtime, when its plan tool (Claude Code `TodoWrite`, Codex `turn/plan/updated`, ACP `plan`) completes steps or replaces the plan | Newly completed steps, the step now in progress, and the plan snapshot (at most 30 steps) |
| `pull_request` | The Run's runtime, when a command it ran created a pull request | Repository, number, URL |

- **Sender.** The entry is authored by the reporting Run's Agent Instance
  under its Run proof, like a message it sends, so attribution and ordering
  are exact.
- **Body.** The Hub renders a one-line plain-text body from the typed report
  (for example `✓ Run e2e regression · → Open PR 2`), so an older client
  shows a readable line.
- **Delivery.** Context, never work: live Instances acknowledge and drop it,
  so it never starts or queues a turn. Agents see it when they read history.
- **Unread and attention.** It does not make a conversation unread, never
  resolves attention, and never notifies.
- **Rate.** A runtime reports at most one entry per 15 seconds per Run,
  coalescing what happened in between into one entry.
- **Billing.** Billable like any Agent message, so a read-only Space refuses
  it the same way.

### 3.3 Supersession

When a person or an Agent posts a message M2, the Hub looks at the same
sender's previous message M1 in the conversation (for an Agent, the same
Instance). If M1 is **eligible**, the Hub asks Jev one boolean question: is
M1 a report of work in progress that a reader no longer needs once they have
read M2?

- **Eligible** means none of: a mention of anyone, a reply to a message, a
  reply or reaction from anyone, an attachment, a thread, an edit or recall,
  an existing judgment, or an age above 24 hours. These are the cases in
  which a message is plainly addressed to someone or has been engaged with,
  so they are never folded.
- **Recorded as** a system annotation on M1 in the reserved namespace
  `xmatrix.superseded` with payload `{ supersededBy: <M2 id> }`. The
  annotation is written by the Hub as `system`, not as the author. History
  reads and message frames carry it as the message's `supersededBy` field,
  derived only from that annotation; other annotations never enter frames.
  Clients that already hold the message pick up a judgment made after it
  arrived by reading the namespace's annotations since their last read.
- **Failure is harmless.** No key, a timeout or an error records nothing and
  M1 stays whole. The judgment runs after the append commits and never delays
  a send.
- **The newest message of each sender is never superseded**, because only a
  later message can supersede it.

### 3.4 Now

Each live Instance publishes one **intent line**: the step in progress in its
own plan (the presence `intent` field, already carried by the Hub and cleared
when no step is in progress). The work dock shows it beside the Instance's
state. Pages already use the same line for heading avatars
(`pages-live-document.md` §3).

### 3.5 Since

When a reader opens a conversation with unread entries, a divider above the
first unread entry summarizes what happened after it, computed from the
typed entries rather than written by a model: messages that mention the
reader, pull requests opened, how many steps and superseded reports were
folded, and who posted. Jev only answers choice, score and boolean
questions, and the Hub has no text-generation dependency; this digest needs
none.

### 3.6 A pull request reports back

An Agent that opened a pull request used to learn its fate only by watching
GitHub from its own process: a watch without a timeout waited forever when
CI never started, and a Run that slept or was restarted lost the watch
without knowing. Only Claude Code can start a turn by itself when a
background watch ends; Codex, Cursor, Grok and ACP harnesses cannot.

- **Subscription.** When the Hub records a `pull_request` entry it subscribes
  the conversation to that pull request, as the Run's owner, through the
  Space's GitHub connection: an ordinary source relation of kind `issue`,
  `github:issue:<owner>/<repo>#<n>`, with the features `pulls`, `comments`,
  `reviews` and `checks`. It is listed in the conversation's Subscriptions
  with the repository subscriptions. A pull request the connection does not
  reach is not subscribed; the entry is recorded either way.
- **What is said.** Others' merge or close, others' submitted reviews and
  new comments, and one CI verdict per settling of the head commit: when a
  check suite completes and every suite with check runs has finished, the
  Hub reads the commit's checks once and posts `CI passed` or `CI failed`
  with the failed checks. Two suites reporting the same settling post one
  message; a rerun that settles again posts a new one. The author's own
  pushes, comments, reviews and merge are not said: the Agent did them.
- **Delivery.** These are GitHub's posts in the conversation, delivered like
  any other message: live Instances receive them, and resting Instances
  wake ([`instance-sleep.md`](../instance-sleep.md) §3). An Agent may therefore end
  its turn once its pull request's CI has started and continue when the
  verdict arrives.
- **End.** The subscription is removed when the pull request closes,
  whether or not the close was said.
- **Privacy.** A private repository's events reach only conversations people
  outside the Space cannot read, as for repository subscriptions.

## 4. Rendering

### 4.1 Web timeline

- **Activity rows.** An activity entry renders as one compact line: time,
  sender, and the entry's own glyphs (`✓` completed, `→` in progress,
  `↗` pull request). No avatar and no identity tags.
- **Folding.** Consecutive *foldable* entries (activity entries and
  superseded messages) from the same Instance merge into one row with a time
  range and a count; the newest items are shown inline. Any entry from anyone
  else, or any unfolded message, ends the fold, so interleaving between
  participants always stays visible. Opening a fold shows each entry in
  place; a superseded message opens to its full text.
- **Header continuation.** A message from the same sender as the entry above
  it, within ten minutes and with the same identity tags, drops the avatar
  and header. Identity tags reappear only when they change.

### 4.2 Work dock

Each Instance's avatar grows into an island with its intent line and a timer
ring of how long ago the Instance last reported progress; after five minutes
without progress the island turns to the attention colour, so silence is visible
rather than hidden behind a green state ([`agent-status.md`](agent-status.md) §2).

### 4.3 Agents

`xmatrix channel history` and the launch-time channel context print an
activity entry as one line (`claude:1 ▸ ✓ Run e2e regression`) and a
superseded message as one line naming what superseded it. Order and message
ids are preserved, so an Agent can still reply to or quote any entry.

## 5. Channel contract

The shared contract requires explicit updates for accepted tasks:

> When you take on a task, promptly send one short channel update saying
> what you will do. At significant milestones, edit that same status
> message; report blockers promptly and send a separate final result before
> ending the turn. Follow the user's reporting preferences. Context-only
> messages and other Agents' progress are not new tasks and need no
> acknowledgement. Keep multi-step plans current with the runtime's plan
> or todo tool as well.

Invocation state records startup evidence. A status message tells the reader
what the Agent accepted and what remains; editing it keeps that information
current without a sequence of progress messages. Completed steps and PRs
continue to appear as activity. Local runtime output is private execution
output and is published to a Channel only through an explicit send.

## 6. Security and privacy

- **Reserved metadata.** Caller-supplied message `metadata` on the public
  send route and the Agent socket drops every key beginning with `xmatrix` and
  the `crossChannelReply` key. Before this, any sender could set
  `xmatrixProvenance: "system_fact"` and publish a message that looked like a
  system notice and was delivered as context only.
- **Reserved annotations.** Public annotation writes may not use a namespace
  beginning with `xmatrix.`; only the Hub writes there.
- **Minimal content.** An activity entry carries step titles the Agent wrote
  in its plan and pull request coordinates; never tool output, command lines
  or file contents. Those stay in the host trace under its existing
  visibility rules (`docs/architecture/agent-trace-visibility.md`).
- **Untrusted text.** Step titles and bodies are untrusted input: bounded,
  rendered as text, and never interpreted as instructions or mentions.
- **Jev input** is the two message bodies, each truncated to 4 KB, with no
  identities.

## 7. Compatibility

- An older runtime keeps narrating; supersession folds its reports, so the
  conversation still reads well.
- A Hub closes an Agent socket on a frame type it does not know, so it lists
  the newer types it accepts (`hubCapabilities: ["channel_activity"]`) when an
  Instance connects, and a runtime reports activity only to a Hub that lists
  it. Against an older Hub the runtime still sets its intent line and simply
  records no activity.
- Older web and CLI clients render an activity entry as an ordinary message
  with its one-line body, and ignore the supersession annotation.

## 8. Build order

Built:

1. Hub (#3053): activity entries (typed socket report, context delivery, no
   unread, no attention), supersession judgment and system annotation,
   `supersededBy` on messages, reserved metadata and annotation namespaces,
   `hubCapabilities` on connect.
2. Runtime and CLI (#3065): plan and pull request reports from Claude Code,
   Codex and ACP runtimes; presence intent; history and launch-context
   folding; the new contract.
3. Web (#3068): folded runs, header continuation, work-dock intent line, the
   Since divider, late supersession judgments.

Open:

- Live references for pull requests in activity rows (their state, not only
  their number), shared with page live references
  (`pages-live-document.md` §5.4).
