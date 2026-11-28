# Overview

Status: decided by Daniel on 2026-11-28 after five drawn drafts. The Hub side
(results, read state, the list of what waits on a person) ships first; the Web
view follows.

Pages are the Space's current state (`pages-and-conversations.md`). The
Overview answers a different question for one person: **what do I have to do,
and what happened while I was away?** It is the first entry of the Pages list
and replaces "Recent changes", which listed the three pages that changed last
with the first text each change added. That was an excerpt of edits: a fixed
typo and a decision read alike.

## 1. What it shows

Two columns on a desktop, stacked on a phone, under one strip of controls (its
name, the time range, how many things are left to handle):

1. **Needs you**: everything that waits on this person in the Space.
   - Each open Norn request they hold (`ask`, `choose`, `confirm`), answered
     where it stands: an option, or their own words.
   - Each conversation with a declared wait on them (`xmatrix send --wait`):
     opened, or marked done.
2. **Problems**: results of kind `problem` they have not handled. A problem is
   handled by replying (the reply goes to the Agent that made the change, in a
   conversation about that section of the page) or by checking it off.
3. **Happened**: the other results in the range. Nothing to do: once seen they
   are not shown again in the default range.

What is handled leaves the list, and the count runs to zero.

It is not a page: it has no title line, no document, no summary sentence above
the list. An earlier draft opened with two sentences about the situation; they
repeated the list under them and took a third of the first screen. Count tiles
("8 problems") were dropped for the same reason: a count changes no decision.

## 2. Results

A **result** is what one change to a page resulted in, in one sentence, with a
kind: `shipped`, `decided`, `problem`, `fixed` or `number`. It is written by
the page's summary execution (`page-summary.ts`): the same one-shot task that
writes the page's one-line summary is handed the lines the change added and
took out since the summary was last written, and answers a second line with the
result, or `none` for bookkeeping, rewording and routine logs. The Hub keeps it
in `data.page_results` for the revision the summary read, with the first section
that change touched. A summary whose page has moved on is dropped with its
result, so the next one covers the whole span once.

Results exist from the release that added them: earlier changes have none.

## 3. A person's place

- `data.page_overview_reads`: how far a person has seen the Space's results.
  The Web moves it forward to the newest result it showed when the person
  leaves the Overview. "While you were away" is what came after it.
- `data.page_result_marks`: the results a person has handled, and the
  conversation they answered in when they replied.

Both are a person's own; an Agent Run has no Overview.

## 4. Hub

- `GET /api/spaces/:spaceId/pages/overview`: the last week's results on the
  pages the caller can read, their `seenAt`, and what they have handled.
- `PUT /api/spaces/:spaceId/pages/overview/seen` `{ through }`.
- `PUT /api/spaces/:spaceId/pages/overview/handled` `{ pageId, revision, conversationId? }`.
- `GET /api/spaces/:spaceId/norn-requests`: the open requests the caller holds
  in the Space, each as its card shows it, with the conversation that carries
  the card. Answers go to the existing per-request routes.

Declared waits come from the conversation catalog's attention summaries, which
the Web already holds.

## 5. Entry in the Pages list

One section label over one row, where "Recent changes" stood. The row is not a
card: it is the list's own row, taller (86 px against a page row's 56), its name
at heading size, and the count left to handle at its end, which becomes a check
when nothing is left.
