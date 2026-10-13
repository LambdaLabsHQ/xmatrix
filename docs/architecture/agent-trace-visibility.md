# Agent trace visibility

An authenticated Human can open an Agent Instance trace directly from a Channel. The Run owner's trace is available to that owner. Another Human must currently have read access to each event's Channel and must share that Channel's Space with the Run owner. The owning Authority checks those facts for the initial host read, again after the host responds, and for every event Channel in the response. An authorization failure (401, 403, or `trace_access_denied`), an ended Run, or a failed first read clears the Web replica and fails closed. A later live read that fails for another reason, such as a host timeout or a Hub error, keeps the last authorized history on screen, marked as reconnecting, for at most 30 seconds from the first failure; if no read succeeds by then, the replica is cleared. A revocation pushed over realtime still clears it at once.

The Agent host remains the source of trace history. Terminal Runs and unavailable hosts do not fall back to a Hub or R2 copy. There is no trace access request or approval: the trace request API, its Web proxy and `xmatrix trace` are removed.

The Web shell does not fetch, retain, expire, or derive presentation from legacy
trace grants. It ignores their realtime notifications and reads traces through
the Channel-authorized Instance endpoint.

The Hub's authorization result is authoritative.

## Paging

The Agent host keeps one Instance's trace for 24 hours, bounded to the newest 5,000 events or 16 MB; a single event over 512 KB is dropped and the history is marked incomplete. A read returns one page, newest first in the requested ordering (see below), bounded by event count and bytes, with a `nextCursor` naming the oldest event of the page. Passing it back as `before` reads the next older page; `complete` is true only on the oldest page when nothing was evicted.

## Event order

The upstream stream's receive order defines a trace, including text, reasoning,
inputs, tool starts and tool updates. Wall-clock timestamps and random event ids
must not determine chunk order. Every trace producer uses the same Agent host
store: Codex retains thread/turn/item identities; ZCode retains session/input/turn
and tool identities; Claude retains message and tool identities; the generic ACP bridge used by Cursor, Grok, Kimi,
OpenCode and other ACP presets retains session, turn, optional message and tool
identities. These identities group or patch content; they are not sortable
chunk sequence numbers. Codex batches only consecutive chunks of one item and
flushes pending text before recording a later tool, status, error or item/turn
boundary. PTY-only harnesses do not gain structured LLM traces
from this change.

Web requests `order=received`. Hub passes the additive `receivedOrder` flag to
the host. A supporting host assigns each recorded event a `traceOrder` containing
a random stream id and a strictly increasing sequence under the store's lock.
It returns pages in reverse receive order without sorting by time. Hub validates
and preserves that order. Web merges overlapping pages by the supplied positions,
deduplicates by event id, and assembles each timeline in that order. Coalesced
tools and text blocks keep their first position; subsequent patches do not move
them. Timestamps remain display data.

Receive-order `before` and inclusive `since` cursors have the bounded form
`received:<stream UUID>:<sequence>`. They survive retention eviction and clock
reversal. A reconnect to the same host stream preserves its id and counter; a
replacement stream rejects old cursors as expired, so Web clears its cache and
reads a fresh head. A TTL-cleared live stream retains its counter and continues
to report incomplete history.

Compatibility is explicit: callers omitting `order=received` keep legacy
(timestamp, event id) pages and cursors. A host predating the flag may ignore it;
Hub and Web use full nanosecond timestamp ordering only for those unpositioned
responses. Supporting hosts never mix positioned and unpositioned events or
streams in one page. Deploy Hub and Web with CLI; existing Agent processes need
a restart to provide receive-order history. The compatibility path can be removed
when unsupported hosts and callers are no longer admitted.

The Hub adds canonical scope fields to every event and cuts a page at an event boundary when the response would exceed its byte bound, returning its own cursor for the cut. The Web opens a trace on a newest page of at most 100 events so it paints quickly, loads older pages on request, and keeps live sync on `since` deltas, following a delta's cursor when it is larger than one page. A live delta carries `waitMs` (at most 25 seconds): the Agent host holds the read until an event newer than its watermark lands, the session ends, or the wait elapses, so steps reach the Web about one hop after they happen. The Hub extends that request's timeout by the wait and still authorizes before and after it. Each traced Instance follows its own reads, and a host holds at most 16 waiting reads per connection. A host that cannot wait answers at once; the Web then falls back to one delta per second.

A host without paging omits `nextCursor`. The Hub then serves only its newest page and answers an older-page read with `host_paging_unsupported` instead of repeating the newest page. Responses keep `cursor: null` for older Web clients.
