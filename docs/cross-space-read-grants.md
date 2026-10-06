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
  (`xmatrix access revoke`), whichever comes first. Management Channel About
  Runs cannot hold a grant.
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
