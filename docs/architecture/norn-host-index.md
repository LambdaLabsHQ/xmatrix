# Norn Host Index (xMatrix, Edition 1)

Compact reference for authoring and reviewing Norn programs on xMatrix Pages and Channels.

## Block Headers
- Program on a Page: `` ```norn 1 run <name> `` (compatible with legacy `` ```norn run <name> ``; same identity).
- Space library on a Page: `` ```norn 1 lib <ModuleName> `` (capitalized ASCII name; definitions pinned by SHA-256 on running ledgers).

## Built-in Modules & Standard Capability (`Events`)
- `Std` (`open Std`): `remind`, `decide`, `followUp`, `schedule`, `routine`, `digest`, `all`, `allSettled`, `race`, `quorum`, `cancelAll`, `orEither`.
- `String`, `List`, `Option`, `Result`, `JSON`: pure data helpers.
- `Events`: CloudEvents 1.0.2 capability (`Events.kind(app, kind)`, `Events.events(kind, ~source=?, ~subject=?)`). Deduplicates idempotently by `(app, kind, source, id)`. Run `xmatrix connector list` to see declared event kinds and typed fields for this Space's connected apps.

## Built-in Application Libraries
- `GitHub`:
  - `GitHub.issueOpened(repo)` -> `stream<{ number: int, title: string, author: string, url: string }>`
  - `GitHub.ciFailed(repo)` -> `stream<{ workflow: string, branch: string, conclusion: string, url: string }>`
  - `GitHub.prMerged(repo)` -> `stream<{ number: int, title: string, branch: string, url: string }>`
- `Gmail`:
  - `Gmail.receivedAt(address, ~subjectContains=?)` -> `stream<Gmail.mailRef>` (`{ messageId: string }`)
  - Filters inside the mailbox owner's authorized scope; exposes only `mailRef` so email addresses and subjects never leak into public Channel `~about`.

## Combinators, Collaboration & Safety
- Streams: `merge`, `or`, `map`, `filter`, `filterMap`, `scan`, `timed`, `gather`, `never`, `every`, `after`, `forEach(~key, ~each=Queue|Latest|Restart|Together|Batch, ~per=?)`.
- Requests: `ask`, `confirm`, `choose`, `run`, `judge`, `wait`, `waitUntil`, `first`, `handOver`, `cancel`, `status`, `accepting`, `mapRequest`, `spawn(~key=?)`, `within(deadline, f)`.
- Ownership & notes: `anyOf(group, ~except=participant|request)`, `sameAs(request)`, `taken(request)`, `say(request, text)`, `request->notes`.
- Editing & upgrades: always pass `~key="..."` on `forEach` loops; preview edits with `previewNornEdit` and library upgrades with `diffNornProgramUpgrade` before applying.
