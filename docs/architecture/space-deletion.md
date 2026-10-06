# Space deletion

Deleting a team Space happens in two phases. The owner schedules the deletion,
which revokes all access at once and can be undone for seven days. After that,
a background purge removes every Space-scoped fact in bounded, resumable steps.
PostgreSQL `data.space_deletions` is the only authority for the deletion, its
restore window, the purge progress and the final audit record.

## Scheduling

`DELETE /api/spaces/:spaceId` (Web Team view, `xmatrix space delete`) runs the
`space_delete` domain command in one serializable transaction:

- Only the Space owner may delete, and only a Human session; Agent Runs are
  refused by the Run route allowlist and again by the route itself. Personal
  (`private`) Spaces and the Spaces pinned by
  deployment configuration (`PLATFORM_ADMIN_SPACE_ID`,
  `TEST_ENVIRONMENT_ACCESS_SPACE_ID`) cannot be deleted.
- A live Space subscription or open checkout still blocks deletion, because the
  Hub cannot cancel a provider subscription.
- Every membership is removed and kept as restore evidence, together with the
  enabled Automations, which are paused. Invites and join requests are deleted.
  Membership routes are tombstoned and every member receives a `revoked`
  recipient change, so every ordinary access check fails closed with no
  deletion-specific branch. Joining an open Space is refused while its deletion
  is pending.
- Live Instances and Runs in every Channel of the Space are terminalized in the
  same transaction; the Hub then issues best-effort daemon stops.
- The Space row, Channels, messages and all other facts stay in place.

The route then arms `RelaySpaceDeletionClock`, a per-Space Durable Object that
stores only the Space id and an alarm. If arming fails the route answers 503.
The owner repeating the request gets the already scheduled deletion back
without a second mutation, and the route arms the clock again.

## Restore

The owner lists restorable Spaces with `GET /api/space-deletions` (Team view,
`xmatrix space deletions`) and restores one with `POST
/api/spaces/:spaceId/restore` (`xmatrix space restore`). Restoring re-inserts
the recorded memberships and membership routes, resumes the Automations that
were paused and have not changed since, and deletes the scheduled deletion
row. Stopped Runs stay stopped. Restore stays possible while the deletion is
`scheduled`, including after `purge_after` until the purge actually begins. To
anyone other than the owner, a deleted Space is `not_found`.

## Purge

When the clock fires, the Hub asks PostgreSQL for the next step. A step is
due only once `purge_after` has passed; the first due step moves the deletion
to `purging` and drops the restore evidence, so restore is no longer possible.

1. **Objects.** Keys are read in key order, 100 at a time, from content objects,
   message attachments, upload intents and GC candidates. Only restricted
   `restricted/channel-user:<channel>:<reader>/objects/<sha256>` keys whose
   Channel belongs to this Space are deleted from R2. Unrestricted
   `objects/<sha256>` keys are content-addressed and may be shared with other
   Spaces, so a Space purge removes their references but never their bytes.
   The Hub deletes the batch from R2 before recording the cursor, so a failed
   delete retries the same keys.
2. **Rows.** `SPACE_PURGE_STEPS` deletes every Space- or Channel-keyed table in
   batches of 500 rows, at most 2,000 rows per transaction. Channel-keyed facts
   go before the Channels that locate them. A real-PostgreSQL classification
   test fails when a table with a Space or Channel key is neither purged nor
   listed in `SPACE_PURGE_EXCLUDED_TABLES` with a reason.
3. **Finalize.** The Space row, its control head and its placement are deleted,
   and the deletion row becomes the `completed` audit record with the number
   of purged rows and objects.

Each alarm runs steps for at most 20 seconds and then wakes again after one
second. Every step is its own transaction fenced by the Space placement, so an
interrupted purge resumes from the last committed step. A 5-minute recovery
alarm is set before any database or R2 work. A Space being deleted is never
moved between shards (`space_deletions` is a blocking table for shard moves).
