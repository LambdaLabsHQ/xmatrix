# Cross-Space read grants

An Agent Run reads and writes only in the Space it was launched in. That keeps
one Space's content out of another, but it also means an Agent cannot debug a
Channel in another of its owner's Spaces. A cross-Space read grant is the
owner-approved exception: one exact live Run may read one Channel family, or one
whole Space, outside its own Space. The grant is read-only.

## Why the owner must approve each grant

Anyone who can talk to an Agent in its Space can ask it to do things. If a Run
could read everything its owner can read, a teammate in a shared Space could ask
the owner's Agent to read another of the owner's Spaces and repeat the content in the
shared Channel. So reaching outside the Run's Space is never implied by who owns
the Run. It takes an explicit decision by the owner, for that Run and that target.

## Flow

1. The Agent runs `xmatrix access request <channel> --reason "<why>"` (add
   `--whole-space` to ask for the Channel's whole Space). The Channel may be its
   ID or its exact-id link (`.../channels/<name>--<id>`).
2. The Hub proves the exact live Run in its own Space, checks that the target is
   in another Space and that the owner can read it now, and records a pending
   grant in the target Space. A retry reuses the open request.
3. An approval card appears in the Run's own Channel. It names only the Agent
   and the grant reference `<space-id>/<grant-id>`, because everyone in that
   Channel sees it and the target Space may be private. On the owner's card the
   Web client reads the target and the reason from the Hub as the owner.
   The request also waits in that Channel's **Pending approvals** dock, beside
   machine requests. The Hub lists it
   (`GET /api/channels/<id>/cross-space-read-grants/pending`), so it shows however
   far back in the timeline the card is.
4. The owner approves or denies on the dock or the card, or with
   `xmatrix access approve|deny <space-id>/<grant-id>`. Approval may narrow a
   whole-Space request to the Channel it named (`--channel-only`); it can never
   widen a request. Only the Run's owner can decide; the decision route never
   admits an Agent Run.
5. By default `xmatrix access request` waits for the decision. Once approved,
   the ordinary read commands work on the target: `xmatrix channel history`,
   `xmatrix diagnose ... --decision-evidence`, for a Channel family
   or a granted Space `xmatrix channels`, and for a granted Space
   `xmatrix space launch-targets <space-id>`.

## What a grant covers

- **Channel scope** covers the named Channel and its threads. **Space scope**
  covers every Channel in that Space the owner can read, the Space's Channel
  catalog, and the Space's launch targets (`xmatrix space launch-targets`).
- Reads only: history, decision evidence, the catalogs, and launch targets.
  Sending, reacting, joining, launching, and stopping stay
  limited to the Run's own Space.
- The grant is bound to the Run, its Instance, and the digest of its execution
  key. A new execution of the same Run does not inherit it.
- A pending request expires after one hour. An approved grant ends after 24
  hours, when the Run stops, or when the owner revokes it
  (`xmatrix access revoke`), whichever comes first.
- A grant never reaches beyond the owner: each read also requires the owner's
  current read access to the target, so a Channel the owner cannot see stays
  invisible, and losing access ends the grant's reach immediately.
- A grant never applies inside the Run's own Space. There the ordinary Agent
  Channel access rules decide, so a closed Channel the Agent was not given stays
  closed even though its owner could read it.

## How a read is authorized

The ordinary Agent read runs first, so reads inside the Run's own Space cost
nothing extra. Only when that read is refused (403 or 404) does the Hub ask the
grant authority (`PostgresCrossSpaceReadRepository.authorizeRead`):

1. Resolve the target's Space. The Run's own Space ends here, and the original
   refusal stands.
2. Re-prove the exact live Run in its own Space, as invocation diagnostics do.
3. In the target Space, find an approved, unexpired grant for this Run,
   Instance, and execution, covering the target, and count the read on it.
4. Check that the owner can read the target now.

The read is then retried as the owner, through the same authority any read by
the owner uses. The retried reads are pure reads (a regression test holds
history to that), so they move none of the owner's own read state. Each granted
read is recorded on the grant (`read_count`, `last_read_at`), attributed to the
Run, not to the owner.

Revocation applies to every read authorized after it commits. A read that was
authorized a moment before the revocation may still complete.

With no grant the Agent gets a 403 `cross_space_read_grant_required` that names
`xmatrix access request`.

## Storage

`data.cross_space_read_grants` (migration `0093`) lives in the target Space and
moves with it. `data.cross_space_read_notices` (migration `0094`) lives in the
Run's own Space and only locates the requests waiting in each Channel. Each
listed grant is re-read from its own Space, as the owner, before it is shown.
Notices expire with the request they point at and are removed a day later. At most one open grant exists per Run and target. Terminal rows
older than 30 days are removed, a bounded batch at a time, when a new request is
made in that Space.

## Support handoffs

A person can hand one of their conversations to xMatrix support ("Hand to
xMatrix support" in the conversation's menu and on xMatrix's failure notices).
Staff and Agents of the support Space read a customer's conversation only this
way: product analysis uses metadata only. A handoff is the same grant with a
different grantee, the support Space instead of one Run
(`data.cross_space_read_grants.grantee = 'space'`, migration `0273`).

1. The person writes one line about what went wrong and ticks what to include.
   Nothing is ticked by default:
   - `messages`: this conversation's messages;
   - `diagnostics`: execution states and failure codes of the conversation's
     Agent starts and Runs, as events that pass the diagnostics allowlist
     (`SUPPORT_LAUNCH_DIAGNOSTIC_EVENT`, `SUPPORT_RUN_DIAGNOSTIC_EVENT` in
     `packages/protocol/src/support-handoff.ts`): no ids, prompts or error text;
   - `logs`: a recent tail of their machine's daemon log, redacted on the
     machine and previewed before it is sent. Ticking it asks one of the
     person's online Machines (`POST /api/machine-daemons/log-excerpts` with a
     `machineId`, then `GET .../log-excerpts/<control-id>` until it settles).
     Only the Machine's owner, signed in as a Human, may ask or read; Agent
     Runs are refused. It is the `log_excerpt` machine command (migration
     `0275`), leased only to a daemon that advertises
     `machine_log_excerpt_v1`. The daemon reads at most the last 200 lines
     and 64 KiB of each of its own logs (launchd's
     `~/Library/Logs/xmatrix-daemon{.err,}.log` on macOS, the update-started
     daemon's `logs/daemon.{err,out}` in its config directory, and the systemd
     user journal of `xmatrix-daemon.service` when systemd runs it), and
     redacts every line on the machine with the Desktop daemon failure card's
     rules (`apps/desktop/src/daemon-failure.ts`): the home directory becomes
     `~`, other user directories, email addresses, URL queries and fragments,
     bearer/token/secret/password/key values and 32+ character token-like
     strings are replaced. The answer is bounded to
     `SUPPORT_HANDOFF_LOG_EXCERPT_MAX` characters and kept, readable only by
     the owner, on the command row until machine-command retention removes it
     (7 days after its 2-minute claim window). Support sees it only when the
     person sends the handoff with it, as `logExcerpt`.
   Then they tick "I agree to let xMatrix support read what I selected". The
   Hub refuses a handoff without that agreement (`consent_required`).
2. `POST /api/channels/<id>/support-handoffs` records an approved grant in the
   person's Space. Only the person who started the conversation, or an owner or
   admin of its Space, can hand it over, and only while they can read it. The
   Hub then opens a support conversation in the support Space
   (`support-handoff:<grant-id>`) with the line, who sent it, what is included
   and until when, and posts a receipt in the person's conversation.
3. Support reads only the ticked parts, read-only:
   `GET /api/spaces/<space-id>/support-handoffs/<grant-id>/messages|diagnostics|logs`.
   Readers are the support Space's owners, admins and members (never its
   viewers) and the live Runs working in that support conversation, which can
   also use `xmatrix channel history <channel>`. Every read is made as the
   person who handed it over, so it never reaches what they cannot read, and is
   counted on the grant.
4. Every read is shown in the person's conversation, one note an hour so it is
   not flooded. The hour's first read posts "xMatrix support read this
   conversation (time)"; each later read in that hour edits the same note to
   "xMatrix support read this conversation 3 times (latest 14:05 UTC)". The
   next read after the hour starts a new note. The grant keeps the note's hour
   (`access_noted_at`) and its count (`access_note_reads`, migration `0276`).
   The handoff card's read count reads the grant again whenever a note
   arrives or changes, so it moves with the note.
   When a Run reads with `xmatrix channel history`, the Channel's name and
   threads printed above the messages are covered by the same handoff and are
   not counted as a second read; a withdrawn or expired handoff refuses both.
   That Run's refusal is 403 `support_handoff_ended`, saying when the customer
   withdrew the handoff or when it expired and that only the customer can hand
   the conversation over again, not the generic
   `cross_space_read_grant_required` that suggests `xmatrix access request`.
5. Support answers with `POST .../replies`; the answer lands in the person's
   conversation as a message from "xMatrix support". Support may also answer by
   email, which the support card shows.
6. The grant ends after 14 days, or at once when the person, or an owner or
   admin of their Space, withdraws it (`POST .../revoke`). Every read checks
   the grant first, so an expired or withdrawn handoff reads nothing. A
   withdrawn handoff's log excerpt is erased at once; an expired one's when the
   next handoff is made in that Space, a bounded batch at a time.

The support Space is deployment configuration: `SUPPORT_SPACE_ID`, or the
platform admin Space (`PLATFORM_ADMIN_SPACE_ID`) when it is unset. With
neither, handoffs answer 503 `support_unavailable`. Its open conversations are
visible to all its members, so it must be a staff-only Space.
