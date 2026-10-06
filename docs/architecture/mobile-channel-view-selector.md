# Mobile channel view selector

## Status

Superseded by [Pages and Conversations](../design/pages-and-conversations.md): the Channel list is one flat, activity-ordered list, and how work is organized lives in Pages. Tree, Flat and Focus views, their chips and the personal view preference are removed.

Amends [Channel-local personal views](./channel-local-personal-views-adr.md),
which has been updated alongside it: the vocabulary is now three views plus two
filters, and Flat enumerates a scope's whole subtree rather than its direct
children. Unchanged from that ADR: Tree is the real hierarchy and the default,
every view is a personal projection that owns no shared state, and a view
preference is personal UI state keyed by `(user, scope)`.

## Problem

The mobile channel list header carried two independent selectors that meant
overlapping things, one of them a dropdown:

1. A four-segment filter row **above** the `Channels` title —
   `All / @Me / Unread / Archive` — held in `useState` and lost on remount.
2. A `Tree` dropdown **beside** the title — the root scope's personal view,
   persisted per scope as `root:<spaceId>`.

Concrete consequences:

- **The two axes only composed in one cell.** The root view projection was
  applied only when the filter was `all`; under `@Me` or `Unread` the list
  rendered flattened nodes, silently discarding the chosen projection. Sixteen
  reachable combinations, one of which behaved as labelled.
- **`@Me` and `@` were the same idea implemented twice** — one from the unread
  counter, one from the shared projection — and could disagree on screen.
- **Two persistence models for one question**: half persisted, half transient.
- **The second dropdown was not what it looked like.** `Manual` next to `Tree`
  read as a sort order; it was the review cadence, shown in every view.

## Design

One selector: a single row of chips directly **under** the `Channels` title.
No dropdowns in the header.

```
Channels                                          ( + )
677 channels
────────────────────────────────────────────────────────
[ Tree ] [ Flat ] [ Focus ]  ⟨ Unread 97 ⟩  |  [ Archive 99+ ]
```

### One vocabulary, every scope

Every scope — the root list and each expandable channel — offers the same three
views, and the mobile list shows them as chips instead of hiding them in a
dropdown. Both surfaces read `CHANNEL_CHILD_VIEW_MODES` and
`MOBILE_CHANNEL_LENS_LABELS`, so a view cannot appear on one and not the other.

| Chip | Stored id | What it does |
| --- | --- | --- |
| Tree | `tree` | The real hierarchy. The default. |
| Flat | `list` | The scope's whole subtree, one pass, most recent first. |
| Focus | `followups` | The channels in that subtree deserving attention, ranked, each with its reason. |

The stored ids are unchanged so that renaming a display name never migrates a
preference a user already saved.

**Flat sweeps the whole subtree.** Its value is that reaching the bottom means
nothing under the scope was skipped, so it cannot stop at direct children —
which is what it did between #1487 and this change, quietly removing the
guarantee the view exists for.

**Focus is Flat done by xMatrix.** The same rows, narrowed through a holistic
review of the accessible conversation, ranked by closure risk, and annotated
with why. Focus and
Flat agree on what a row is — the channel the work is in — so falling back when
the inference is unhelpful does not change what the reader is looking at.

Getting that wrong is easy and was caught in review: resolving each atom to its
first-level ancestor branch made Focus report `x-matrix` where Flat reported
`x-matrix/bugs/ios-crash`, leaving the automated sweep coarser than the manual
one it is supposed to save you from.

The name follows the reader's goal rather than the authority's Follow-up
record — naming a view after the record is what invites a UI to behave as
though the list were the ledger.

**Unread and @ are filters, not views.** They rearrange nothing, and every row
already carries an unread badge and an @ marker. One control cycles
off → Unread → @ and narrows whichever view is selected: Tree keeps its
hierarchy (an ancestor stays for a matching descendant), Flat and Focus keep
their order. Two independent toggles were rejected — "both on" would mean
either union or intersection and neither reading is guessable from the control.

The filter reads the same state the row badge reads, which is what finally
removes the duplicate definition of "@": the old `@Me` filter and `@` view
answered the same question from two different sources and could disagree on
screen.

Archive is neither view nor filter. It is the archived-channel scope, sits
after a separator, and is the only selection that is not persisted — it is a
destination the user leaves, not the state they should land in next time.

### Layout and touch

Three view chips, Archive, and the filter fit at 390pt, but a longer space
name or a wider locale can still overflow, so the view row is a single line
that scrolls horizontally with native `overflow-x` and scroll snapping. No
`preventDefault` on move events and no runtime `touch-action` rewriting —
mobile list gestures stay the browser's.

### Flat renders the whole subtree at once

Flat has no virtualization, and this change raises its row count: the root
scope used to render only top-level channels and now renders every visible
channel in the Space. That is deliberate and was reviewed — the view's purpose
is the complete linear scan, Tree already permits comparable DOM once a user
expands it, and adding virtualization to this one path would bring scroll
restoration, dynamic row height, and accessibility regressions wider than the
change itself.

The sort is memoized independently of unread state: `rootProjectedNodes`
depends on the channel tree, the selected view, and the Focus atoms — never on
read counts — so an arriving message re-runs the O(n) filter predicate, not the
O(n log n) ordering. If profiling on a real device shows jank, the answer is
shared list infrastructure, not a local fix here.

### Manual review is a button; the cadence is only automatic

Refreshing **is** the manual review: it starts a direct Focus
organization request for the configured Management Agent. The Agent inspects the
complete accessible Space conversation and authoritative work-item ledger,
applies any required
create/update/close operations, and the browser re-reads Focus only after Hub
publishes the resulting authority change. It does not create, require, or post
to a Management Channel. The Agent Run uses the currently accessible Channel
only as its authenticated execution scope.

The cadence decides only when the *automatic* review runs. The header therefore
states the next automatic run rather than naming a frequency, and keeps the
configuration behind a low-contrast wrench:

```
( ⟳ )  Next update in 4 h                                    ( 🔧 )
```

The wrench opens Off / Every day / Weekdays / Every week, with the reminder
that refresh never waits for a schedule. `nextChannelFollowUpReviewAtMs`
computes the stated time from the same rules the scheduler runs, including the
weekend skip — otherwise Friday's list would promise a Saturday run.

The desktop review bar states the same two things for the same reason, so the
two surfaces cannot drift into different vocabularies.

A cadence never runs Space-wide inference behind an unopened list: the
automatic review only ticks while the user is reading Focus. Before this
change the mobile schedule was decorative — it was persisted but no mobile
code path consumed it, so `Daily` never ran anything.

## Why three views and not five

An earlier round had five chips — Tree, List, Follow-ups, Unread, @ — and they
read as too many. The count was the symptom; the cause was that they were not
the same kind of question:

| Kind | Views | Question |
| --- | --- | --- |
| Structure | Tree | Where does this live |
| Closing the loop | Flat, Focus | What of mine is unfinished — observed vs inferred |
| Signal | Unread, @ | Where is there activity, who addressed me |

The rule that settled it: **a view changes how content is organized; something
that changes only how many rows survive is a filter.** Unread and @ reorganize
nothing, so they became one filter. Tree, Flat, and Focus each reorganize, so
all three stayed — and demoting the two also made "only what needs me, inside
Flat" expressible, which no combination of the old five could say.

## What does not change

- Nested scopes keep their own stored presentation preference and the same
  three-view projection model as the root. Their selectors are temporarily
  withheld on desktop and mobile while the per-channel interaction design is
  revisited; this does not migrate or discard existing preferences.
- The root Channels selector remains the only visible selector and renders
  from the shared vocabulary on both platforms.
- No view writes to a Channel or a Message. Focus stays advisory.

## Implementation

- `mobile-channel-views.ts` — the chip vocabulary, display names, and the
  mapping onto `ChannelChildView`.
- `mobile-channel-list-header.tsx` — the chip row, the filter, the review
  strip, and the automatic-update sheet.
- `channel-child-views.ts` — the three views, the Flat subtree sweep, and the
  filter vocabulary.
- `channel-follow-up-review.ts` — `nextChannelFollowUpReviewAtMs`.
- `space-focus-review-request.ts` — the direct, authenticated Management Agent
  request; it has no Channel-message fallback.
- `workspace-channel-sidebar.tsx` — the mobile list, and the desktop review
  bar and per-row control.

Both new modules are registered in `workspace-shell-source-fixture.cjs`, which
is the fixture the shell's structural tests read.

`apps/ios/xMatrix/MobileTabBarView.swift` loses its `followups` tab. The web
layer stopped recognizing that view in #1487, so its `isAppView` guard silently
dropped the tap — the tab was visible and inert in the shipped app. Focus is a
view inside Channels, not a destination.
