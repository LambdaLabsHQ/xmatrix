# Instance and Run natural keys

Status: steps 1-3 have landed (#2850, #2856, #2857, #2859); step 4 is
`0084_contract_natural_instance_run_ids`, applied only through the PostgreSQL
Contract Migration workflow after every Run is stopped.

The owner asked on 2026-09-25 to remove the random `instance:<uuid>`,
`run:<uuid>` and `session:<uuid>` identifiers from the data model, not only
from rendered text. An Agent registration is already keyed by its tuple
(see `agent-registration-composite-key.md`); Instances and Runs still carry a
minted UUID beside keys that already identify them.

## Keys

| Record | Primary key | Why it is stable |
| --- | --- | --- |
| Instance | `(channel_id, channel_instance_id)` | The ordinal is allocated as `MAX + 1` per Channel, rows are never deleted and numbers are never reused. `UNIQUE (channel_id, channel_instance_id)` already exists (migration 0009). An Instance belongs to exactly one Channel. |
| Run | `(channel_id, channel_instance_id, run_ordinal)` | A Run is the k-th start of one Instance. Reborn and resume keep the Instance and start run `k + 1`; the ordinal is allocated under the Instance row lock and never reused. |
| Channel About Run | `(channel_id, run_ordinal)`, no instance ordinal | The About Session is not a Channel Instance and receives no instance ordinal (2026-08-15 boundary review). Its k-th start comes from the Channel's `about` counter. The `session:<uuid>` placeholder in the launch binding is replaced by the About Run's own id. |

Ordinals at or above `8000000000000000` are historical; step 4 deletes them. Instances persisted
before the ordinal allocator carried the sentinel `0`; the Postgres fact
backfill (`packages/db/scripts/postgres-fact-backfill.mjs`) mapped each to
`8e15 + low 48 bits of its UUID`, which stays below 2^53 and cannot overlap
dense ordinals. Allocation ignores that range (`channel_instance_id < 8e15` in
every `MAX + 1` query), and the existing unique constraint already covers it,
so these rows keep their ordinal as their key. No new row is written there.
The protocol carries ordinals as decimal strings, as `channelInstanceId`
already does, so no consumer depends on the 2^53 margin.

The display name (`claude` in `claude:3`) is presentation only and never part
of a key. The registration tuple is not an Instance key either: one
registration can hold several concurrent Instances.

Launch, execution, control and startup-attempt identifiers keep their
separate lifecycle roles. Fallback still replaces an attempt and fences its late
receipt by attempt identity; changing Instance and Run keys must not weaken
that check.

## Stored ids

The owner chose on 2026-09-25 to discard every existing Run and Instance
rather than migrate them. With no history to carry, the stored `instance_id`
and `run_id` columns stay, and their value becomes the key itself:

| Record | Stored id |
| --- | --- |
| Instance | `<channel_id>:<channel_instance_id>` |
| Run | `<channel_id>:<channel_instance_id>#<run_ordinal>` |
| About Run | `<channel_id>:about#<run_ordinal>` |

Released CLIs treat these ids as opaque strings, so no CLI release is
required. The Channel id is the Channel's own identity and is unchanged.

Ids used to be minted before the ordinal existed and doubled as the
idempotency key of their creation path (`instance:summon:<key>`,
`run:reborn:<key>`, a random uuid at registration staging, and so on). A
creation path now reserves its key first through
`data.natural_key_reservations`, keyed by that creation key, so a replay
receives the same ids; the Hub reaches it through the `natural_key_reserve`
runtime command. Ordinals come from `data.natural_key_counters`, one row per
Channel scope (`instance`, `about`, `run:<ordinal>`), which only moves
forward: an issued ordinal is never reissued, even if its row is removed.

## Rollout

1. Document and protocol shape (#2850).
2. Reservations and counters (`0083_expand_natural_key_reservations`), the
   `natural_key_reserve` command, and every ordinal allocator moved onto the
   counter. An Instance written with a natural id takes the ordinal it
   carries.
3. Each creation path reserves before minting: Hub summon, reborn, handoff,
   management and scheduled dispatch; registration launch including About;
   the Hub Run endpoint; database summon, Automation and registration reborn.
   Parsers of the old id shapes go with them.
4. Contract: stop every Run, delete every Run, Instance and dependent row,
   and add CHECK constraints that pin each stored id to its key.

## Presentation

Diagnostics and CLI output render `claude:3`, `claude:3#k` for a Run and
`about#k` for an About Run, never a stored id.
