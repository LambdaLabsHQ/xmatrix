# Norn Host Index (xMatrix, Edition 1)

Compact reference for authoring and reviewing Norn programs on xMatrix Pages and Channels.

## Block Headers
- Program on a Page: `` ```norn 1 run <name> `` (compatible with legacy `` ```norn run <name> ``; same identity).
- Space library on a Page: `` ```norn 1 lib <ModuleName> `` (capitalized ASCII name; definitions pinned by SHA-256 on running ledgers).

## Built-in Modules & Standard Capability (`Events`)
- `Std` (`open Std`): `remind`, `decide`, `followUp`, `schedule`, `routine`, `digest`, `all`, `allSettled`, `race`, `quorum`, `cancelAll`, `orEither`.
- `String`, `List`, `Option`, `Result`, `JSON`: pure data helpers.
- `Events`: CloudEvents 1.0.2 capability (`Events.kind(app, kind)`, `Events.events(kind, ~source=?, ~subject=?)`). Deduplicates idempotently by `(app, kind, source, id)`. Run `xmatrix connector list` to see declared event kinds and typed fields for this Space's connected apps.

- `Actions`: a connected app does one thing by itself, in two requests of the host. `Actions.action(app, name)` names it (checked against the app's manifest; input `{target, text}` as the Channel command writes it, answer `{summary, url}`); `Actions.prepare(action, input, ~by=?)` freezes it and has it admitted under the app's permission (Ask first: a Space admin answers it in Pending approvals); `Actions.perform(prepared, ~by=?)` runs it once, with no Agent. Requests are made where the program runs, never inside `List.map`.

## Built-in Application Libraries
- `GitHub`:
  - `GitHub.issueOpened(repo)` -> `stream<{ number: int, title: string, author: string, url: string }>`
  - `GitHub.ciFailed(repo)` -> `stream<{ workflow: string, branch: string, conclusion: string, url: string }>`
  - `GitHub.prMerged(repo)` -> `stream<{ number: int, title: string, branch: string, url: string }>`
- `Gmail`:
  - `Gmail.receivedAt(address, ~subjectContains=?)` -> `stream<Gmail.mailRef>` (`{ messageId: string }`)
  - Filters inside the mailbox owner's authorized scope; exposes only `mailRef` so email addresses and subjects never leak into public Channel `~about`.

- `X`:
  - `X.preparePost(account, text)`, `X.prepareVideo(account, "<message id>/<attachment id>", text)` -> `request<Actions.prepared<X.posted>>`: nothing is posted yet. The video is an MP4 attachment in the program's conversation.
  - `X.publish(prepared)` -> `request<X.posted>` (`{ summary: string, url: option<string> }`): posts once; the video is uploaded now.
  - One post each at its own time, approved together: `spawn(~key=video, () => { let ready = X.prepareVideo(…)->wait?; after(at)->wait; X.publish(ready)->wait })`.

## Combinators, Collaboration & Safety
- Streams: `merge`, `or`, `map`, `filter`, `filterMap`, `scan`, `timed`, `gather`, `never`, `every`, `after`, `forEach(~key, ~each=Queue|Latest|Restart|Together|Batch, ~per=?)`.
- Requests: `ask`, `confirm`, `choose`, `run`, `judge`, `wait`, `waitUntil`, `first`, `handOver`, `cancel`, `status`, `accepting`, `mapRequest`, `spawn(~key=?)`, `within(deadline, f)`.
- Ownership & notes: `anyOf(group, ~except=participant|request)`, `sameAs(request)`, `taken(request)`, `say(request, text)`, `request->notes`.
- Editing & upgrades: always pass `~key="..."` on `forEach` loops; preview edits with `previewNornEdit` and library upgrades with `diffNornProgramUpgrade` before applying.
