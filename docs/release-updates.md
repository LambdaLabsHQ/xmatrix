# Release Updates

## Unreleased: a Google Play base plan keeps its stated price at home

`@googleplay:base_plan` used Google's converted price for every region,
including the price's own, where Google's local pattern turned 10.00 into
9.99. The command now names the region the price is for, and that region
keeps exactly the stated price; the others take the conversion. Hub and
protocol; no schema change. Recovery is a CI-validated beta reverting this change.

## Unreleased: a Google Play upload URL reaches only the Agent that asked for it

`@googleplay:api_upload` published its resumable upload URL in the Channel
receipt, and that URL alone accepts the file. It now runs only as
`xmatrix call`: the URL returns to the caller, the Channel receipt and
execution history are always masked, and sent as a Channel message it is
refused with that instruction. It needs the app permission to allow writes
without asking. Hub and protocol; no schema change. Recovery is a
CI-validated beta reverting this change.

## Unreleased: Google Play Console creates a subscription base plan in one command

`@googleplay:base_plan` adds an auto-renewing base plan to a subscription from
one price: Google converts it to every region, the plan is saved with all
regional prices, and it can be activated in the same step. The catalog write
could not do this, because the converted prices of every region do not fit a
bounded receipt. Hub and protocol; no schema change. Recovery is a
CI-validated beta reverting this change.

## Unreleased: a command checks a failed app connection again by itself

A connection whose last check failed blocked every command until a Space admin
pressed Check again in Apps, even after the cause was gone. A command by a
Space admin, or by an Agent acting for one, now asks the provider again first,
records the answer as Check again does, and runs when it passes; when it still
fails the receipt carries the fresh reason. Others keep the pointer to Apps.
Hub only; no schema change. Recovery is a CI-validated beta reverting this change.

## Unreleased: a failed app check states its reason once

After Check again failed, an app's page showed the same reason twice: as a red
line above and again in the block that holds the fix. It now appears once, in
that block. Web only. Recovery is a CI-validated beta reverting this change.

## Unreleased: connecting an app from the desktop app returns to the desktop app

A one-click connect started in the Mac or Windows app opened the provider's
sign-in in the browser and then finished, and stayed, on the web. The connect
now records that the app started it; after sign-in the browser page hands the
grant back through `xmatrix://connect/oauth`, the app finishes the connection
with its own sign-in and shows the connector's page, and the browser tab says
it can be closed. It needs this desktop version; an older app keeps finishing
on the web. Google Play Console's "API not enabled" failure now names the API
and the Hub's Google project instead of asking to reconnect. Hub, web and
desktop; no schema change. Recovery is a CI-validated beta reverting this change.

## Unreleased: Google Play Console connects with one sign-in, for every app

Connecting Google Play Console no longer asks for an app's package name. The
sign-in also grants the read-only Play Developer Reporting scope, Check lists
the apps the account can see, and `list_apps` gives Agents their package
names. An existing connection signs in once more for the added scope. The
Google Cloud connector's `enable_api` now accepts the two Play APIs. Hub and
protocol only; no schema change. Recovery is a CI-validated beta reverting
this change.

## Unreleased: a Google Play Console connector

Apps gains Google Play Console (`googleplay`), so Agents release Android apps
without the Play Console website. It pins the official androidpublisher v3
discovery document and offers every operation through `api_operations`,
`api_schema`, `api_read`, a digest-bound `api_plan`/`api_write`, and
`api_upload`, which opens a resumable upload the machine with the app bundle
sends its bytes to. `tracks` and `release` read tracks and roll version codes
out to a track and commit. It signs in with the company Google client and keeps
its own grant for exactly the androidpublisher scope; Check reads the saved
app's production track. Hub, protocol and web copy only; no schema change.
Recovery is a CI-validated beta reverting this change.

## Unreleased: the Android app sells Pro through Google Play

The Android app's Billing settings buy Pro through Google Play Billing instead
of showing Stripe checkout, as Google Play's payments policy requires for a
subscription bought in an app. A purchase is one human seat bound for good to
the Space it was bought for, like an App Store purchase on iPhone. The Hub
reads every purchase from the Google Play Developer API, acknowledges it after
recording it, and re-reads it on each Real-time developer notification
(`/api/billing/google-play/notifications`, Pub/Sub push with an OIDC token).
Expand migration 0246 adds `google` as a billing provider and the
`google_play_account_tokens` and `google_play_purchase_bindings` tables.
Purchases need the production secret `GOOGLE_PLAY_SUBSCRIPTIONS_CONFIG` and an
Android build with Play Billing; until both exist, the Android app shows that
subscriptions are unavailable and the web keeps Stripe. Setup is in
`docs/operations/google-play-subscriptions.md`. Recovery is a CI-validated beta
reverting this change; the two tables then stay unused.
## Unreleased: an Instance at rest that a Norn request started is retired too

Stopping the Run a Norn request started left the Instance when that Run had
already exited: an Instance at rest has no live Run, stays listed, and wakes
with the conversation's next message. The release step now retires such an
Instance as a stop of that exact address does, and stops the Instance's
current Run when it is live. Hub only, no schema change. Recovery is a
CI-validated beta Hub reverting this change.

## Unreleased: a Run started for a Norn request ends with the request

Every request of a Norn program starts a new Run, and those Runs stayed in the
conversation after answering: a review of three rounds left ten resting
Instances, and each later message woke all of them. Once a request has ended
(answered, refused, broke, cancelled or past its deadline), the Channel's
coordinator now stops the Run its delivery started, once, and the delivery
message says that answering ends the Run. Requests that ended before this
release have their Runs stopped at the conversation's next coordinator pass.
Hub only, with expand migration 0245 (`norn_requests.released_at`). Recovery is
a CI-validated beta Hub reverting this change.

## Unreleased: a Norn program in a message asks Agents typed requests

A message with one top-level fenced block tagged `norn run` starts that
[Norn](https://github.com/norn-lang/norn) program with its author's authority
([Norn host](architecture/norn-host.md)). Each request the program makes is one
xMatrix message under it that starts a Run of the harness it names (or of
`@auto`), and that Run ends the request with the new Hub-defined commands
`xmatrix reply`, `xmatrix refuse` or `xmatrix broke`; `xmatrix requests` lists
the open ones. An answer outside the form the program reads is refused. A
request whose launch was refused, whose Run stopped or exited, or whose turn
ended without an answer is settled `Broke`, so a program never waits in
silence. A stop of the whole conversation ends its programs, and the result is
posted under the program's message. A block tagged `norn` alone is only shown,
and no existing message starts anything. Requests to people and to an existing
Instance are refused with the reason in this version. Hub only, with expand
migration 0244 (`norn_programs`, `norn_requests`); every CLI that passes
unknown words to the Hub has the commands. Recovery is a CI-validated beta Hub
reverting this change; the two tables then stay unused.
## Unreleased: a beta train ships the Hub alone, so a Hub fix no longer waits for client builds

A release holds its first component's place in line until its slowest
component is published. On 2026-11-11 `xmatrix-v4.0.7-beta.5` shipped all six
components: its Hub deployed five minutes in, and the release held the Hub's
place for 41 minutes while the desktop and CLI builds ran, so a Hub fix asked
for at 19:34 UTC started deploying at 19:55. Of the last 39 releases, 13
carried the Hub together with the CLI or desktop and ran 14 to 57 minutes; a
Hub release alone takes 4 to 6.

A beta train whose selection includes the Hub and anything else now ships only
the Hub. A request that names more than the Hub is shipped for its Hub, and
the rest of it stays open under the same request id; requests without the Hub
stay open as they are. The train wakes the next one, which ships the rest
beside or right after that Hub release by the existing dependency rule. The
rest of a request therefore starts a few minutes later than before, and the
Hub's place frees after a Hub deploy. Stable trains, the dependency rule,
concurrency groups, authorization and recovery are unchanged; nothing is
cancelled. A request whose Hub part is in flight while its rest is open is no
longer read as a half-finished move, which is now decided by request id and
scope together.

Release train only (`scripts/release-train.mjs`,
`production-release-request.yml`); no product, schema or client change.
Recovery is a CI-validated main revision reverting this change: open and
in-flight refs written by either version are read by both.

## Unreleased: the connector list says a subscription is sent, not called

`xmatrix connector list` printed `read   @github:subscribe:...`. The manifest's
`read` is the approval class, and every other `read` row is run with `xmatrix
call`, but subscribe has no call executor: it changes the Channel it is sent in,
and `xmatrix call` answered `Unknown connector action`. `GET
/api/connectors/usage` now adds `via` (`call` or `send`) to each action and the
description of a read without a call executor says to send it with `xmatrix
send`; the CLI labels that row `send`. `xmatrix call` on a command the provider
runs only from a Channel message now answers that it is sent with `xmatrix
send`. No action's `effect` or approval changed. An older CLI ignores `via` and
still prints `read`, with the new description; a new CLI against an older Hub
prints `read` as before. Hub and CLI. Recovery is a CI-validated beta reverting
this change.

## Unreleased: a GitHub command the Space cannot reach says who links the account

A GitHub command against a repository whose App installation exists but is not
linked to the Space answered `GitHub subscribe: failed; github installation not
linked to space.`, the internal code with its underscores removed. The receipt
now names the repository and says a Space admin links its account in the
Space's Apps → GitHub (Find my GitHub accounts, then Link), and that installing
the App on github.com alone does not link it. It carries the existing
`reconnect` fix, so the receipt draws the settings card that opens Apps →
GitHub. A Space with no linked installation gets the same treatment; a
repository the App is not installed on gets a sentence and no card, because a
mistyped name gets that answer too. The execution record and every other
caller keep the machine codes. The card does not settle by itself after
linking, because linking an installation does not run a connection check. Hub
only, no schema or client change. Recovery is a CI-validated beta Hub reverting
this change.
## Unreleased: an Agent's own connector receipt no longer refuses its next send

An Agent that ran `xmatrix call "@googlesearchconsole:list_sites:*"` or sent a
connector command such as `@cloudflare:put_dns:…` had its next `xmatrix send`
refused with "the Channel moved on after the last message you read", once per
command, and the identical retry went through. The read-before-send check
counts every App message after the sender's last read as unread, and the
receipt the Hub posts for a command is an App message: nothing related it to
the command's own sender. The check now leaves out an App receipt whose id is
`system:<command message id>:<app>` when that command message is the sender's
own in the Channel. Messages from people, other Agents and sibling Instances,
Apps' native events, and receipts for anyone else's command refuse a send as
before. A write's outcome still reaches the Agent that sent it as queued work
after its turn, so it may post once more before reading it. Hub only, no
schema, protocol or client change. Recovery is a CI-validated beta Hub
reverting this change.
## Unreleased: a card that asks to connect GitHub offers Connect, and a link settles it

A settings card for `connector:github/connect` showed a Space admin "A Space
admin can make this." and no button. The card decided who may act by reading
back the App's typed credential fields, and GitHub, which is connected by
authorizing, has none, so every viewer was treated as unable to connect it.
The card now asks the Space's admin authorization directly for such an App and
shows **Connect GitHub**, which opens the Space's Apps page. Linking a GitHub
account there now also runs the connection check, so the card sees a check
after it asked, settles, and wakes the Agent that asked; before, only a manual
Check did. The link stands when the check cannot run. Hub only, no schema or
client change. Recovery is a CI-validated beta Hub reverting this change.

## Unreleased: a stale command lease is a fence, not a Hub error

HUB-7F kept reporting `machine_command_stale_lease` after the 409 had already
refused the caller. The latest production case is `complete.owner` on a
harness action: the command is still leased, but to a different holder, so the
old completion must not land. `renew.status` is the same fence after the
command has left `leased`. The socket still returns that non-retryable refusal
and the log keeps the static reason, command type and bounded lease timing.
The log is a warning, so console capture no longer files it as a Hub error.
Hub only, no schema or client change. Recovery is a CI-validated beta Hub
reverting this change.

## Unreleased: daemons tell the Hub they can start a summon on a catalog model

The daemon kept two copies of its capability list, one in its connect metadata
and one in the list the Hub stores. `registration_native_model_v1` (#1510) was
added only to the metadata copy, so the Hub saw no daemon able to start a
runtime on a model from its own catalog: the `@` menu offered no `model:` rows
and `@claude model:sonnet` was still refused. The daemon now builds one list
for both. CLI only; it takes effect when a Machine's daemon restarts on this
release. Recovery is a CI-validated beta reverting this change.

## Unreleased: a stop or reborn that did nothing tells whoever sent it

`@<agent>:<n>:stop`, `:reborn` and `:handoff:` that address no Instance (a
mistyped name, or the full Instance id in place of the Channel's number, as in
`@deepseek:<id>:3:reborn`) recorded their refusal only on the message. An
Agent sending through the CLI never saw it, and waited for a restart that was
never queued. The send's answer now carries each refusal, and `xmatrix send`
exits with an error that says the message was sent, quotes each refusal, and
shows the address form to resend (`@deepseek:3:reborn`). Hub and CLI; the
message and its recorded result are unchanged, and an older CLI ignores the
new field. Recovery is a CI-validated beta reverting this change.

## Unreleased: Connect with X reaches consent again

X answers an authorize request whose `state` is longer than 500 characters with
`invalid_request` before it shows consent. The Hub's X state carried the Space,
the admin, the PKCE claims and the connection snapshot in about 719 characters,
so every **Connect with X** ended on "Something went wrong / You weren't able to
give access to the App" and no X account, company or personal, could be
connected; a different X account, permission set or callback changed nothing.
The claims now travel compressed and signed in about 407 characters, a state
minted before this release still finishes its flow, and a provider that
declares a state limit refuses an oversized connect instead of letting the
provider reject it silently. Hub only, no Web, client or schema change.
Recovery is a CI-validated beta reverting this change.

## Unreleased: the model tag names the model, not its selector

An Agent's model tag showed whatever id its harness selects the model with.
DeepSeek Harness selects with a JSON pair such as
`["deepseek-official","deepseek-flash"]`, so its tag read
`["deepseek-official","…` and never reached the model. The tag now shows the
name the harness gives the selected model in its own catalog
(`DeepSeek-V4.1-Flash`), on the Agent card and in message headers, and keeps
the id only when the catalog lists no name. The CLI now also reads model
choices a harness lists in groups, as DeepSeek Harness does per provider, so
its models appear in the model switcher. A harness whose catalog names a
model differently from its id (Cursor's `Composer 2.5`) shows that name too.
Hub, Web and CLI; the selected id itself is unchanged, so switching works as
before. Recovery is a CI-validated beta reverting this change.

## Unreleased: `xmatrix send --file` is the message body, `--attachment` attaches

`xmatrix send --file` attached a file while `xmatrix page edit --file` read the
text from one, and `send` had no way to take its body from a file. An Agent
that wrote its reply to a file therefore sent `--file reply.md`: a message with
no text and a Markdown attachment the reader had to open. `--file <path>`
(`-f`) now reads the message body from a UTF-8 file, as it does for a page, and
`--attachment <path>` attaches a file beside the body. A send with attachments
and no body is refused, and so is `--file` beside another body; each refusal
names the other flag. The help, the Agent prompt and the guides say the same.
CLI only: the Hub, the Web and the send wire format are unchanged, so the flags
change with the CLI a Machine runs. A script that attached with `--file` moves
to `--attachment`. Recovery is a CI-validated beta reverting this change.

## Unreleased: a page is always as it is now, and History shows what changed

A page could be in a state its reader had not chosen and could not name: what
changed since they last read it, or since an Agent's edit when they came from
a message's edit card, marked word by word over the text until they found the
card that hid it, and back again each time they returned. A rewritten table
was unreadable that way. A page now has two states. The page is always its
newest version with nothing marked in it; History is the same page, where it
stood, at a version, with that version's changes marked in its text and the
versions listed in the margin. *Since your last visit* is History's first
entry, across however many versions that took, and what History opens on; a
brass dot beside History says there is one (the old dot was drawn in a colour
that did not show on paper). A changed block keeps its words marked one by one
only while most of them stayed; rewritten past recognition, the old block is
struck out and the new one stands whole, and a table keeps its rows and
columns. A message's edit card opens the page as it is now at the change.

Read now means visited: the newest version a person has had open. The Web no
longer times which blocks were on screen or sends the page as its reader saw
it, and the Hub no longer reads or writes `data.page_reads.seen_body`;
contract migration 0243 drops the column once this Hub is verified. Web, Hub and
protocol, no expand migration; an older Web keeps working against this Hub and
this Web against an older Hub. Recovery is a CI-validated beta reverting this
change.
## Unreleased: Gmail paperclip attachments are no longer listed as inline images

Gmail's web composer gives an ordinary paperclip attachment a Content-ID, and
the Gmail connector counted any file part with a Content-ID as an inline
image. A draft carrying a PDF therefore showed in `@gmail:drafts` as
"0 attachment(s), 1 inline image(s)", and its `@gmail:send_draft` approval
card listed no attachments. An explicit `Content-Disposition: attachment` now
counts as an attachment. A part is inline only when its disposition says
`inline`, or when it has a Content-ID and no disposition at all, as quoted
signature logos do. Hub only, no schema or client migration. Recovery is a
CI-validated beta Hub release reverting this change.

## Unreleased: Gmail send and reply carry the files attached to the command

`@gmail:send` and `@gmail:reply` could only send a plain-text email; a file
attached to the command message was ignored, so the email went out without it.
The files on the command message itself (`xmatrix send --attachment`, or a file
attached in the composer) now go as email attachments: at most 20 files and
25 MiB. Each is read as the Human the command runs for, through the same
Channel attachment authority as a download. The approval card lists every
file's name and size; the send rereads each one and refuses a file whose
content, type or version changed after approval. A message with attachments
goes to Gmail's upload endpoint through the short-lived Hub staging that
`send_draft` uses. An approved send reads the files its card froze; the first beta
refused them as unreadable and sent nothing (#1521). No new scope, no reconnect. Hub and protocol only, no schema
or client migration. Recovery is a CI-validated beta Hub reverting this change.

## Unreleased: a missing harness is refused by name before its Run starts

When npm left `opencode` off a Mac daemon's PATH, xMatrix still listed
OpenCode as installed there and every Run died in the wrapper on a bare
`No such file or directory`. Inventory and launches now search one PATH,
the one a Run gets, which carries each harness installer's directory on
every platform (now including `~/.opencode/bin` and `~/.kimi-code/bin`). At
launch the daemon resolves the preset's launcher on the Run's own PATH; when
it is missing, the launch is refused as `harness_missing`, naming the program
and its install, and the machine reports its inventory again. An install or
update xMatrix runs fails when the launcher cannot answer its own version.
Hub and CLI, no migration (#1516). Recovery is a CI-validated beta reverting
this change.

## Unreleased: a conversation's list copy can no longer stand in for its live Agents

Since Instances became records of their own, a Channel held by a list carries
no Agent Instances, yet its type still said it did: code that read Instances
from a list copy compiled and found none. `ChannelSnapshot` now describes what
lists hold (metadata and people) and `LiveChannel` the Channel with its
Instances; only live reads return a `LiveChannel`, and every Instance reader
takes one. The places this surfaced read live again: mentions in the message
timeline resolve their Instance and show why a mention waits for an offline
machine, the cards beside a Page show which Agents are live in each linked
conversation, and Status counts work in hand while a conversation is open.
Message rows read who wrote them from a sender directory taken when they are
built, not from a subscription, so no Instance report re-renders the shell. Web only; recovery is a
CI-validated beta Web release reverting this change.

## Unreleased: Instance runtime catalogs keep every entry

Runtime catalogs were cut at fixed counts, so a Claude Instance with many
skills lost the tail of its slash menu (production showed exactly 64 stored
commands), and a runtime with more than 64 parameters had its whole catalog
rejected. Commands, capabilities, models, parameters and options now keep every
entry; per-string length and the presence body's byte bound remain. The compact
hibernation attachment leaves out commands and capabilities, and the Instance
row keeps any runtime catalog a report omits (an explicit empty list still
clears it), so a long list can neither overflow the 16 KB attachment nor be
wiped after a restore. No schema migration. The Hub carries the fix; the CLI
change only lifts the ACP parameter count. Recovery is a CI-validated beta Hub
release reverting this change.

## Unreleased: Summons infer and apply a model from the runtime's own catalog

A summon could choose a model only from a list its Agent's owner declared, and
no registration declares one, so `@claude model:sonnet` was refused and Jev
never chose a model. With no declared list, a summon now chooses from the
runtime's fresh native model catalog, the same set a live `/model` offers. Jev
keeps the runtime's default unless the author or the discussion names or asks
for another model; a written `model:` matches the runtime's model id or any
selector or display name it lists (Claude's `opus`, `Sonnet 5.5`). The launch
stays on the runtime-default authority, with no grant or model resource change,
and carries the choice as `preferredModel`; the daemon requests it of the
runtime as it does an admitted model, so a runtime that rejects it fails to
start rather than running its default. A reborn restarts on the same model.
Stored catalogs keep a collapsed selector as an alias, so live `/model opus`
works too. Needs the Hub and daemons advertising
`registration_native_model_v1`; on older daemons a written model is still
refused. Evidence uses `registration-parameters-v12`. Recovery is a beta Hub
release reverting this change; daemons ignore the field without the Hub.

## Unreleased: Instance command and parameter menus retain their runtime catalogs

Modern clients read versioned Instance records, but their durable projection
omitted commands and capabilities on write and omitted models and parameters
on read. The command palette, model choices and harness configuration therefore
lost the runtime's advertised choices. Both boundaries now retain those catalogs,
workspace and worktree-base presentation. A complete typed checkpoint and
exhaustive normalizer share one field registry with the SQL reader; adding a
presentation field without its durable mapping fails compilation. Explicit
empty catalogs remain withdrawals, including after hibernation. Message headers keep their own smaller
projection; temporary work stays on its live activity stream. Hub only, no
schema or client migration. Existing connections repopulate the missing fields
on their next presence update or ordinary reconnect. Recovery is a CI-validated
beta Hub release reverting this change.

## Unreleased: Agent sends require an Instance or an explicit launch

A CLI or MCP send without an Instance number returned success even though
its Agent summon could not route to an existing Instance. The Hub now refuses
that send before publication with `agent_instance_required`. Use
`@<agent>:<instance>` to address an existing Instance, or `--launch` (MCP
`launch: true`) to start one; message text `launch:force` is insufficient.
Human mentions and code/quoted examples remain valid. The Web composer already
requests launch. Older CLIs receive the Hub refusal too; updated CLI help
explains the contract. No schema migration. Recovery is a CI-validated beta
reverting this change.

## Unreleased: Apple relationship writes require a complete current snapshot

Generic App Store API plans treated every POST as a resource creation, so
adding members to an existing relationship did not bind its current state.
Direct relationship reads and App Review draft attachments could also bind
only a partial response. These paths now share one completeness check, and
relationship POSTs bind current membership before approval and execution.
Pagination, inconsistent totals, malformed linkage and duplicate identities
refuse the plan or draft mutation before any provider write. Inspect the full
relationship at Apple when its bounded response is incomplete. Existing
resource-create plans remain valid; relationship POST plans must be refreshed.
Hub only, no schema or client migration. Recovery is a CI-validated forward
Hub release retaining complete snapshot checks; uncertain Apple writes still
require inspection before retrying.

## Unreleased: ACP Agents without image support still read a message with a picture

A message with an image sent every ACP Agent an inline image block, and an
Agent whose initialize result did not advertise `promptCapabilities.image`
(DeepSeek Harness among them) rejected the whole turn with -32602. Such an
Agent now gets the message text alone, which already names each image's local
copy for its own tools to open. CLI only; no Hub, schema or protocol change.
Recovery is a CI-validated beta reverting this change.

## Unreleased: Apple commerce watch failures keep their phase

HUB-C0 reported only that a commerce watch would retry. The pass still retries
that watch and does not discard its snapshot or pending events. The report now
names the failed phase, a fixed failure kind and code, and whether the retry
was recorded, and keeps a database failure's existing attempt evidence.
Provider response text, bundle ids and credentials stay out of the event. Hub
only, no schema or client migration; recovery is a CI-validated beta Hub
release reverting this change.

## Unreleased: Windows Agents work with files past 260 characters

`xmatrix setup daemon` now turns on Windows' LongPathsEnabled switch before it
starts the daemon (one administrator prompt; without one it prints the exact
administrator command), Git run by an Agent or any tool under it has
`core.longpaths` on, and xmatrix.exe declares itself long-path aware. Together
they let a checkout hold files deeper than 260 characters. Windows still starts
no program from a folder or an executable path past 260, whatever these
settings say: the short pool path keeps checkouts within it, and an Agent whose
Workspace folder is too long now fails naming the folder and its length
instead of "The directory name is invalid". CLI only; no Hub, schema or
protocol change. Recovery is a CI-validated beta reverting this change.

## Unreleased: New sessions get the short pool path on Windows

A repo pool created before the compact layout (`<64hex>/slots/<32hex>`) kept
taking every new session on that machine, so each checkout was 88 characters
longer than the compact `<8hex>/<6hex>` path. On Windows that put deep
dependency trees past MAX_PATH (260), where a nested executable, such as a
test runtime installed under `node_modules`, could not start. A legacy pool now keeps only the
sessions, handoff predecessors and slots it already holds; new sessions start
in the compact pool, and the sweep keeps no warm spares in a legacy pool, so it
drains as its sessions end. Nothing is moved or deleted. The desktop App's git
probes name the workspace with `-C` instead of starting git inside it, so a
deep workspace no longer shows a blank repository, remote and branch. CLI and
desktop App; no Hub, schema or protocol change. Recovery is a CI-validated
beta reverting #1498.

## Unreleased: Every quote opens with a large quotation mark

A quote above a reply, a passage quoted in a message, and the reply or quote
slip in the composer were a plain yellow slip that read like any other card.
Each now opens with a large curly quotation mark in the slip's own wood, drawn
as a vector so it is the same light mark on every system. Beta Web only;
recovery is a CI-validated Web release reverting the style.

## Unreleased: the details rail lists a conversation's Agents again

Since Instances became records of their own, the right-hand details rail read
its Agents from a Channel list that no longer holds them, listed none and hid
its Agents block: only the Summary was left. The rail now reads the same live
Instance store as the Agents-at-work dock. Beta Web only, no migration.
Recovery is a CI-validated beta reverting this change.

## Unreleased: Launch candidate reads recover a lost response

HUB-BZ lost the model catalog's PostgreSQL response before an Agent could be
selected. Candidate grants, model/parameter observations, response latencies
and directory enrichment now use independent lock-free reads, each recovering
one lost response on a fresh connection. A repeated loss or explicit SQL error
still fails; placed reads recheck the fence and a retried candidate read sees
revoked grants. Preparation, launch writes and unknown-COMMIT reconciliation
keep their existing boundaries. Hub only, no schema or client migration;
recovery is a CI-validated beta Hub release reverting this change. The
underlying database stall remains unattributed.

## Unreleased: A signed-in desktop App with no CLI session hands it one

The desktop App installs its CLI only with a CLI session, and the Web asked
for one only when the daemon reported a sign-in error. An App signed in by a
path that did not hand its session over found no CLI, reported the daemon
`missing` (not an error), and showed the setup command with nothing failing
and nothing reported. A new user on 11-08 stopped there. When the App can
install its own CLI and finds none, the Web now exchanges a CLI session,
saves it and starts the daemon, as after the App's own sign-in. Beta Web
only; recovery is a CI-validated Web release reverting the effect.

## Unreleased: preserve app-owned product items during iOS review updates

The iOS release script accepts an app version alongside subscription, group and
in-app purchase versions in the same review submission. Before refreshing an
editable version or withdrawing a queued submission, it verifies each product's
parent against the app's collections. Unknown, foreign, duplicate or ambiguous
items stop the release before mutation. A queued replacement carries all three
product version kinds forward. An unresolved rejection still requires a factual
review response and explicit resubmission; updating the exact build does not
resolve review issues automatically.

## Unreleased: App Review attachments and draft replies use the saved web session

Review reads now expose thread/message IDs and linked attachment metadata,
with one-file signed downloads fetched without Apple credentials. Optional
thread/message selectors retain the existing newest-thread command. Unsent
drafts can be read, created, updated, deleted and sent. Edits and sends require
the current body/attachment digest, preserve existing drafts unless explicitly
named, and verify the provider result. Sends never retry an uncertain mutation.
Every web-session write revalidates current app permission before fetch, and
responses are bounded while streaming. Hub only; no schema or credential
migration. Recovery uses a CI-validated forward Hub release preserving these
checks. Physical-device testing, truthful review evidence and App Review
acceptance remain independent of these connector capabilities.

## Unreleased: video attachments declare microphone use, and support has a contact page

Recording a video from the iOS attachment picker uses the microphone, but
the app declared only camera use. iOS terminates an app that accesses the
microphone without its purpose string. The app now declares sound capture
for user-initiated video attachments and describes both camera modes;
a hosted test checks the actual built app's capture purpose strings.
Physical-device video capture remains a separate validation step.
The App Store support address now names `/support`, an unauthenticated page
with an email contact and account, purchase and troubleshooting guidance,
reachable from the guide and footer. iOS and Web, no data or API migration.
The new binary and support page require a verified beta followed by stable
before App Review can use them; the old binary is unchanged by a Web deploy.
Recovery is a CI-validated forward release preserving both capture declarations.

## Unreleased: Sentry events follow all current installation bindings

Installation binding storage already accepts more than 50 Spaces, but Sentry
event admission still rejected the entire event at binding 51. Admission now
shares the complete resource-page iterator used by installation retirement and
writes jobs in bounded pages inside one transaction. Current grants and
credential versions are checked on every page; replay, delivery fencing and
the 1,000-pending-job backpressure remain. A failed later page rolls back all
new jobs and the receipt. Cleanup still takes at most two expired receipts,
now at most 2,000 child jobs under the existing transaction deadline. Hub only,
no schema or client migration; recovery is a CI-validated beta Hub build that
retains complete reads for already-saved bindings. Events already acknowledged
by the provider are not recreated; rejected deliveries depend on its retries.

## Unreleased: CLI release feeds are read before the cron opens its other connections

HUB-BX lost the dev CLI feed twice while waiting for response headers. The
waits were 15s and 7s, past the five-second abort, while the stable feed in
the same minute succeeded and both public feeds answer within a couple of
seconds on their own. A minute cron may keep only six connections waiting on
headers. Each other pass opens a Hyperdrive connection, which counts, so a
feed fetch queued behind them does not see its abort until a slot frees.
Hyperdrive's connect wait is 15 seconds. Both feeds are now read, including
one retry of a lost response, before any other pass opens a connection. Owner
queries and socket delivery are unchanged and still are not replayed. Hub
only, no schema or client change. Recovery is a CI-validated beta Hub
reverting this change.

## Unreleased: Expired Machine leases retain their timing

HUB-7F reports expired harness-action renewals, but the refusal alone could not
separate delayed initial admission from a later heartbeat gap. The existing
locked command read now supplies a database observation clock, and the single
rejection log keeps the grant window, expiry lateness and command age as bounded
millisecond durations. Raw timestamps, identities and payloads stay private;
socket replies and all lease fences are unchanged. This adds missing evidence,
not a confirmed fix of the underlying delay. Hub only, no schema or client
migration. Recovery is a CI-validated beta Hub reverting this diagnostic change.


## Unreleased: personal browser history stays with its signed-in user

Input and search history used a Space-only browser key, so signing into the
same Space as another person on that device could offer the previous person's
inputs and searches. Page summon markers and the preferred writer also lacked
a reader boundary. All four now share storage addressed by the current user
and Space, and in-memory choices follow the same scope. Old ownerless records
are left unused because their author cannot be recovered. A blocked or full
store never interrupts sending, searching or calling an Agent. Beta Web only;
no Hub, schema or client protocol migration. Recovery requires a forward beta
that preserves this ownership boundary.

## Unreleased: the last message scrolls clear of the Agents at work again

Since Instances became records of their own, the Conversations view asked a
Channel list that no longer holds them whether an Agent was in the Channel,
always heard no, and kept no room under the last message: the floating Agent
card covered it and it could not be scrolled out from under it. The timeline
now asks the same live Instance store the card is drawn from. Beta Web only,
no migration. Recovery is a CI-validated beta reverting this change.

## Unreleased: ↑ in an empty composer lists what was sent before

The composer now keeps what the reader sent in each Space, on this device.
↑ in an empty composer opens that history in the composer's own panel, newest
beside the field; ↑/↓ move the highlight, Enter or Tab puts the entry back to
edit or send, and Escape, typing or ↓ past the newest closes it. Picked pages
and channels come back picked; Agents come back as their written `@name`.
Beta Web only, no migration. Recovery is a CI-validated beta reverting this
change.

## Unreleased: a read Gmail message opens in Gmail when its card is clicked

Clicking the email card a Gmail read draws in a Channel now opens that
message in Gmail's web app, in the signed-in Google account that holds its
mailbox (`authuser`). The card tints slightly on hover; its own links,
toggles and text selection keep their meaning. The Hub now names the mailbox
on every read and notification read, not only when several are connected.
Hub and beta Web, no migration. Recovery is a CI-validated beta reverting this
change.

## Unreleased: Transfer proposal lists recover a lost database response

HUB-BW lost its connection at BEGIN while listing Channel transfer proposals.
This lock-free read now combines the current Human admin check and the bounded
queue in one placed single read. One lost response retries on a fresh connection,
rechecking both admin authority and placement; repeated loss stays visible.
An authorized empty queue remains distinct from a denied reader. Transfer
confirmation, writes and unknown-COMMIT recovery are unchanged. Hub only, no
schema or client migration. Recovery is a CI-validated beta Hub reverting this
change. The underlying connection termination is not attributed.

## Unreleased: Registration presentation keeps its own clock

The ordered Instance store no longer accepts writes to its derived Channel
view. Registration quota now updates a separate account pool and joins local
Instance counters when displayed, including on cold reads. A registration's
name travels with its own Space-scoped version, so a rename reaches an idle or
ended Instance on focus, reconnect or cold read without changing its lifecycle.
The same database projection now includes the persisted goal and current Git
branch. Hub, beta Web and additive shared protocol; no migration. Recovery is a
CI-validated beta reverting this change.

## Unreleased: a Gmail draft's approval card says when it carries no real attachment

A reply to TradeStation was approved and sent whose card listed "7
attachments", all the logos of the quoted signature, while the two PDFs its
text promised had never been attached. The card and receipt now list real
attachments and inline images (parts with a Content-ID or `inline`
disposition) separately, and say "Attachments: none" outright, so a card of
logos cannot read as carrying documents. Hub only, no schema or client
migration. Recovery is a CI-validated beta Hub reverting this change.

## Unreleased: Instance status has one ordered source

A newly running Agent could speak while its message said `instance offline`:
bounded Channel windows replaced the whole roster, while live cards could
only update an Instance already in it. Messages also cached a second live
status. Self-contained Instance records now merge by lifecycle version and
socket sequence; empty or late windows cannot remove a live record. Only an
explicit ended record means offline, and exact reads reconcile held IDs after
reconnect or focus. Message headers, avatars, Reborn and the work dock share
the live state without rebuilding Markdown on activity. Hub, Web and shared
protocol; capability-negotiated legacy compatibility, no schema migration.
Recovery is a CI-validated beta reverting this change.

## Unreleased: A page's comment thread no longer hides its own words

An open thread in a page's margin floated the Conversations view's Agent
disc (46px) and composer over its last lines, a "back to the last person"
capsule over its first, and showed its Agent again as a chip in the head.
The same glass disc and composer now stand in flow under the comments at
the thread's scale (a 32px disc on the comments' avatar column, a 40px
composer), the head names the conversation on the passage's column without
the chip, comment avatars drop their status dot, the jump capsule is gone
from the margin, and text fades at the scroll edges. The Conversations view
is unchanged. Web only.
## Unreleased: page edit takes what page read printed, never its header alone

Agents wrote `xmatrix page read`'s header into pages: 62 revisions of 10
Lambda Labs pages since 2026-10-02 carry its lines, first written by codex,
claude, opencode and grok. `page edit -f` took a file as the page's text, so
each Agent cut the header off by hand; a cut one line short or mid-header
landed above the page's heading. `page edit` and `page create` now take the
page's text or all of what `page read` printed, whose header is left out. A
line only that header writes (`pageId:`, `headRevision:`, the `writeLive:`
hint) elsewhere outside fenced code means it was cut by hand: nothing is
written, and the refusal names the line and what to give instead. CLI only;
no Hub, schema or protocol change. Older CLIs write what they are given.
Recovery is a CI-validated beta CLI reverting this change.

## Unreleased: An idle Agent's 5h/1w usage comes back when its Channel is opened

A registration's quota reading counts for fifteen minutes, and since idle
Instances stopped polling their provider (#1328) nothing read it again while
an Agent sat idle, so its Channel card lost its 5h/1w tags. Opening the
Channel is now the event that reads it: when the Agents it shows have no
reading in force, the Hub asks their machines' daemons for one (the existing
once-a-minute-per-daemon probe), and the reading reaches the owner's card
when the probe lands. Hub only, no schema or client protocol migration.
Recovery is a CI-validated Hub reverting the change.

## Unreleased: A page's name is its first top-level heading, wherever it stands

Two Lambda Labs business-line pages read "Untitled" in the page tree,
Schedules and root tables while their documents carried `# NomadCafe` and
`# 酒店积分数据产品（常旅客）`: an Agent's edit had left `page read` header text
above the heading, and only a heading a document opened with named it. There
is no stored title to drift; production history shows 49 revisions of 18
pages unnamed this way, by notes, stray rules and pasted headers. A page's
name is now its document's first top-level heading outside fenced code,
wherever it stands (`data.page_title` in SQL, `pageTitleLine` in the protocol);
a document without one, or whose first one is empty, still reads "Untitled".
Rename rewrites that heading where it stands; the editor draws "Untitled" only
for a document without one, and the byline and the published page stand under
the title wherever it is. Hub and beta Web with expand migration 0238;
`data.page_name` stays for the Hub this replaces until contract migration 0240
drops it. Recovery is a CI-validated beta Hub and Web reverting this change.

## Unreleased: A schedule says what its latest runs produced

Learning which of a Space's schedules earn their cadence took a manual,
hours-long audit of their conversations. Each page Automation listed by its
page or its Space now carries `outcomes`: its ten latest occurrences that were
not cancelled, newest first, each a pull request it opened, a page it changed,
nothing, failed to start, or still running. The Hub reads them from each
occurrence's own conversation (its launches, Runs, page revisions and activity
entries) in one bounded statement per list; nothing new is stored and merges
are not shown. `xmatrix page automation list` and `page read` print
`last 10: 4 PR · 3 page · 2 none · 1 failed to start`, and Schedules shows the
summary in each row and every run, with its conversation, in its detail.
Expand migration 0239 adds online indexes for those reads (a GIN index on page
revision conversations and a partial index on activity entries and failure
notices). Hub, Web, CLI and shared protocol; older clients ignore the additive
field. Recovery is a CI-validated beta reverting the change; the indexes may
stay.

## Unreleased: Phone conversation heads share state without inspecting the app tree

The phone navigation bar inferred its paper tone from a Summary plaque found
by an app-root `:has()` selector. The shell now supplies the same summary and
linked-page data to the bar and plaque, keeping their shared tone, spacing and
page actions. A stylesheet architecture gate rejects this root dependency,
and the existing scroll scope test now covers phones as well as desktop.
The pre-fix bounded scroll sample passed its element-count budget; this change
does not claim a measured jank reduction. Web only, no schema or client
protocol migration. Recovery is a CI-validated beta Web reverting the change.

## Unreleased: System judgments recover a lost database response

HUB-BV lost the outbox INSERT response while recording a Machine result on
its command message, before COMMIT. System annotations now close the failed
session and replay their database-only transaction once on a fresh session,
including when the caller owns a request session. Each attempt rereads the
message and annotation, preserving recall and idempotence; live publication
stays outside recovery. A second loss or an answered rejection still fails,
and an unknown COMMIT is never replayed immediately. The underlying stall
remains unconfirmed. Hub only; no schema or client migration. Recovery is a
CI-validated beta Hub reverting this change.

## Unreleased: Socket overloads keep their failed Runtime fetch evidence

HUB-BS/BT reported only an opaque platform error at the Agent and Machine
Daemon WebSocket routes. The socket router now adds bounded wall duration,
owner/unassigned routing, the platform remote flag and a fixed message category
to the single original report, readable through Sentry. These distinguish a
quick refusal from a slow fetch without retaining owner names or request data;
they do not establish the cause of the overload. No immediate retry is added,
and existing 503 responses and client backoff remain. The same investigation
found daily harness notices rejected for having no version registry despite
an official update recipe: action admission now matches the daemon and accepts
those notices. Hub and shared protocol only; no schema or client migration.
Recovery is a CI-validated beta Hub reverting this change.

## Unreleased: A Codex CLI too old for xMatrix is named instead of started

Codex threads start with the goal tools as one namespaced dynamic tool, which
Codex CLI 0.140 and older reject at `thread/start` ("missing field
`inputSchema`"). A new Windows user's first message on Codex CLI 0.104.0 failed
with only that protocol error. The Codex preset now requires 0.141.0, the first
release with namespaced dynamic tools: routing leaves an older Codex out, the
connect flow says it is too old, and a refusal names Codex CLI, the machine and
its update. Protocol registry only; no schema, daemon or client migration.
Recovery is reverting this change.

## Unreleased: OAuth cookie refusals identify the failed browser binding

HUB-BR found and parsed its stored OAuth state, then refused its signed browser
cookie. Google and GitHub callbacks now retain the original error with a fixed
cookie diagnosis and parameter-presence flags, readable through the Sentry
connector. Request-local evidence keeps simultaneous flows separate and retains
no state, code, cookie, URL or identity. Validation, state consumption, callback
recovery and SDK deduplication are unchanged. This adds the missing
diagnostic; the original browser cause remains unproven. Hub only, no schema or
client migration. Recovery is a CI-validated beta Hub reverting the change.

## Unreleased: An idle Machine Daemon no longer wakes the Hub or writes PostgreSQL

The daemon's minute session probe and its at-least-minutely load report each
woke the owner's Relay Runtime, and every report wrote PostgreSQL. The daemon
now probes with the edge heartbeat the Runtime auto-answers without waking, and
the Hub reads liveness from the platform's timestamp of that answer: a daemon
silent past 45 s is closed and shown offline at the next event in its owner's
cell, or within 30 s while it carries a Run. Load history is kept on the daemon
one sample per minute and sent with the next report, at most five minutes late;
placement load is reported on material change. A failed delivery no longer
closes the daemon with the client-upgrade code that stopped it reconnecting.
Old daemons keep the previous behaviour; no schema migration. Recovery is
reverting this change: the Hub ignores the new capability and field.

## Unreleased: A reconnected daemon keeps its fresh Machine credential

HUB-A9 received a refresh credential that had expired 901 seconds earlier.
The reconnect path could enroll a fresh token, then replay a queued old refresh
and roll its local HTTP credential cache back.
Refresh now captures the live connection epoch before minting and is sent only
on that same connection. Offline and replaced-connection refreshes are discarded;
current refreshes retain their wire format. CLI daemon only; no schema or Hub
compatibility migration. Existing daemons receive the fix when they update to a
release containing it. Recovery is a CI-validated CLI release reverting this
change; Hub credential verification remains unchanged.

## Unreleased: Markdown round-trip tests reuse their parsed documents

The shared Node gate parsed both the original and canonical Markdown twice for
every document in the repository corpus. The round-trip test now reuses those
documents for its idempotence and equivalence assertions. Every corpus input,
syntax case and assertion remains; focused tests still cover the convenience
API. Product behavior, required gates and release authority are unchanged.
No migration is needed.

## Unreleased: Literal attachment examples survive sending in every Markdown context

An attachment-looking line inside multiline inline code or HTML was treated as
a draft picture: sending deleted it without an upload, or rewrote it when an
upload matched. Removing a real picture also erased literal references to the
same file. Draft widgets, file removal and sending now inventory actual image nodes in
the shared GFM tree, using the same parser configuration as Page documents and
operational mentions. Whole-line uploaded pictures keep their existing format
and selection offsets. Web only; no schema, API or saved-message migration.
Recovery is a CI-validated beta Web release reverting this change.

## Unreleased: The timeline stays put while rows above the reader load

A reader who had scrolled up in a conversation saw it jump when a row above
the screen grew late, most often a Gmail card filling in its private result,
and the same while scrolling up with a wheel or trackpad. The list made up for
rows above the first one in view only while the reader was scrolling up, and
that direction resets 50ms after the last scroll event. It now makes up for
them in any direction and at rest. Web only, a react-virtuoso patch; no schema
or client migration. Recovery is a CI-validated beta Web reverting this change.

## Unreleased: Release storage tests skip idle retry waits

The R2 upload regression spent 24 seconds in production retry backoffs on every
PR and release gate. It now records and fast-forwards only those waits while
keeping real abort deadlines, child-process termination, retry counts, phase
diagnostics and credential redaction checks. The file runs in the bounded
child-process test lane because it launches Wrangler fixtures. Production
transfer behavior and required gates are unchanged; no migration is needed.

## Unreleased: Message files follow the pictures actually shown

An attachment could disappear when its picture syntax was inside code or beyond
a folded preview, while a Markdown image reference showed the same file twice.
The message now prepares its displayed body and consumed attachments from one
final Markdown tree, after quote replacement. Files not actually drawn remain
under the words, including in long plain-text messages and system cards. The
independent line scanner is removed. Editing before a composer quote also no
longer strands its remove control: it reads the widget's current editor position.
Web only; no schema, API or saved-message migration. Recovery is a CI-validated
beta Web release reverting this change.

## Unreleased: Recorded database connection terminations remain recoverable

HUB-BQ failed both fresh connections at BEGIN before business SQL. Recovery
already replayed once, but the common CONNECTION_TERMINATED code erased the
difference between pg termination messages and Hyperdrive's explicit egress
severance. Each failure attempt now retains a fixed driver reason, readable
through Sentry without copying driver text, SQL, credentials or causes. This
fills a diagnostic gap; the underlying outage remains unconfirmed. The Hub also
uses the database's recorded termination evidence to answer retryable unavailable
after the single replay is exhausted, instead of a permanent session failure.
Arbitrary text and explicit SQL rejections retain their classification. Existing
retry limits and unknown-COMMIT reconciliation are unchanged. Hub only, no
schema or client migration; recovery is a CI-validated beta Hub reverting this
change. Historical events remain readable.

## Unreleased: A jumped-to message stays where it landed

Opening a Needs-you conversation landed on and highlighted the message, then
private result cards above it loaded their content and pushed it off screen a
second later. The timeline now holds a landed message in place while rows above
it change height, until the reader touches, scrolls, clicks or types, jumps
again, or switches conversation. Web only, no schema or client migration.
Recovery is a CI-validated beta Web reverting this change.

## Unreleased: Gmail hands a large approved draft to Composio by short-lived link

The upload-endpoint fix still ended in 413: Composio's proxy, not Gmail,
refuses a request body of a few MB, so an approved draft of about 5 MB of
attachments could not be sent through it at all. The Hub now stages the
checked snapshot under an unguessable token for at most ten minutes, lets
Composio fetch it from `/api/connectors/mail-snapshots/<token>` and deletes it
as soon as the send ends. What is sent is still exactly the approved snapshot.
Hub only, no schema or client migration. Recovery is a CI-validated beta Hub
reverting this change.

## Unreleased: Gmail sends a large draft through the upload endpoint

The first real `@gmail:send_draft`, an application email of about 5 MB of
attachments, was approved and then refused by Gmail with 413 Request Entity
Too Large: the checked snapshot went in an ordinary JSON body, which Gmail caps
at about 5 MB. It now goes to Gmail's upload endpoint as multipart/related
(the draft id and the snapshot's own message bytes), which takes up to 35 MB.
Nothing was sent by the failed attempt. Hub only, no schema or client
migration. Recovery is a CI-validated beta Hub reverting this change.

## Unreleased: Gmail sends a saved draft, attachments included, after approval

The Gmail connector could only send a plain-text email it composed itself, so
an email with attachments drafted in Gmail could not go out through an
approval. `@gmail:drafts:*` now lists your drafts with their recipients and
attachment count, and `@gmail:send_draft:<draft id>` sends one as it is. The
approval card names its sender, recipients, subject, text and every attachment;
a draft edited after approval is refused rather than sent. The existing Gmail
grant covers drafts: no new scope, no reconnect. Hub and protocol only, no
schema or client migration. Recovery is a CI-validated beta Hub reverting this
change.

## Unreleased: The welcome says an agent is in, in one line, with no cards

Once a new person's agent was in, the welcome showed four cards (start a new
conversation, several AIs together, write with AI, connect another computer).
Of the external people whose agents were in, 8 of 39 in 28 days still never
sent a message. Daniel's call (2026-11-04): no menu; the welcome says
"@codex is in. Mention it here to give it work." and the composer below it
already says "@ to summon an agent". A Space without GitHub is offered
"Connect GitHub so agents can work in several repositories in parallel."
(it used to say the repositories "become pages"); once GitHub is connected the
welcome says nothing more, and no longer lists repositories to draft pages from.
The welcome's one-click co-writing page and the code only it used are gone;
co-writing from a page is unchanged. Web only; no schema or client migration.
Recovery is a CI-validated beta release reverting this change.

## Unreleased: xMatrix's own messages no longer use a Free Space's writes

A Free Space's 500 writes were also spent on what xMatrix itself said: the
welcome steps it writes into a new person's conversation (written under their
name, kind `xmatrix.onboarding.v1`) and the `@<agent>` summon it sends for a
first message nobody was named in. A new Space on 2026-11-03 had used 4 writes
for one message of its owner. Only messages from people, Agents and apps now
count, as `docs/design/agent-credits.md` already said for system notices; a
paid Space's credits were already untouched by these. Writes counted before
this release stay counted (the counter never goes down). Hub only, no schema
or client migration. Recovery is a CI-validated beta Hub reverting this
change.
## Unreleased: Reloading a conversation no longer waits for a page render

Reloading the app (Ctrl+R / Cmd+R) or opening a link into a Space, view or
conversation kept the old page on screen while the Web Worker rendered the
startup frame for that address; a cold Worker took up to about 2 s, longer from
far networks. Only the bare `/app` was served as the prerendered page. Every
address the app shell answers itself now gets that same prerendered page, so
these loads wait only for a static file. Legacy addresses still redirect as
before. Beta Web only, no API, schema or native change; recovery is a
CI-validated beta Web release reverting the change.

## Unreleased: Gmail automatic read failures retain their failing step

HUB-BP reported only 502 when a notification's private message read failed,
losing the distinction between an oversized response, a Composio HTTP/proxy
failure, Gmail's refusal and message formatting. One explicit report now keeps
the read step, fixed failure kind, status and uploaded Worker code locations;
Sentry issue reads expose the same bounded diagnosis. Provider text, mail,
credentials and mailbox/message identity remain private. Notifications still
arrive with their manual read command after failure. This supplies missing
evidence; the original 502's underlying cause is unconfirmed. Hub only, no
schema or client migration. Recovery is a CI-validated beta Hub reverting this
change.

## Unreleased: Pictures are blocks of what is written, a row at a time

Pictures waited in a strip above the words and showed under the message, in
no relation to what was written. A picture now goes into the draft where the
caret is, as its own attachment card (preview, Original, retry, ×) among the
lines; pictures put together, or one after another, are one row that wraps,
and words between them start a new row. Sent, each picture is named by its
place among the message's files (`![name](attachment:1)`), so the message
draws it where it was put and Agents read the pictures in order with the
words; any file the words do not name, and every file of older messages,
stays under them as before. Backspace or Delete beside a picture, or its ×,
removes it and its file. An image card's Original toggle and × now sit over
the picture in the light theme instead of below it. Web only; no schema or
client migration. Recovery is a CI-validated beta release reverting this
change.
## Unreleased: Receipt recovery verifies the release channel's Web

The archive recovery reader accepted either Web origin for every beta, so a
current beta receipt claiming the stable Web could pass. It now requires
`beta.xmatrix.sh` from `1.3.1-beta.7`, the first immutable train that selected
the beta Web; older betas and stable releases require `xmatrix.sh`. Exact
scope, SHA, tag and run checks remain required. Production validates each new
receipt with the same reader before persisting it to R2; recovery uses the
default branch's reader without changing historical tags or receipts. No product,
schema or client migration is needed. A CI-validated forward change to this
reader can recover a mistaken historical boundary; do not rewrite receipts.

## Unreleased: Quotes are blocks of what is written, as many as wanted

A composer held one quote, above what was typed, and a message drew only the
quote it opened with as a slip. Quote now puts the passage into the draft as
a yellow block on the line after the caret, so a message can quote several
passages, each among what is written around it, in the order they were put;
the caret steps over a block, and Backspace or Delete beside it, or its ×,
removes it whole. The draft is the message's own Markdown (`> passage`, then
`— [source](link)`), so drafts save, restore and send unchanged, and Agents
read the quotes in order. A message draws every such passage as its slip
where it was put, and previews and automatic names read what was written
around them. Discuss in new channel opens the new conversation's draft
holding its passage as the first block. Hub and Web; no schema or client
migration. Recovery is a CI-validated beta release reverting this change.

## Unreleased: Connected mobile conversations slide in

Opening a conversation from the channel list now runs its push transition when
the Human socket is connected. Sending channel focus stamps the incoming
history acceptance refs before the route commits; navigation now decides
whether the channel changes before that stamp, so it cannot mistake the new
channel for one already open and skip the animation. The temporary browser
Sentry push diagnostic is removed. Beta Web only, no API, schema or native
change; recovery is a CI-validated beta Web release reverting this change.

## Unreleased: Gmail reads currency and punctuation entities

A Gmail read showed `&yen;` and similar named HTML entities literally, for
example in a bank statement's amounts. Common currency, typographic and
spacing entities now read as their characters; unknown names stay as written.
Hub only, no schema or client migration. Recovery is a CI-validated beta Hub
reverting this change.

## Unreleased: Gmail reads a statement-sized message body

The large-body read shipped in the previous beta still failed on a real bank
statement with "Provider response is too large": the fetched body exceeded the
Hub's default 256 KiB provider response bound. That one call now allows up to
3 MiB, enough for the 2 MB body limit once base64-encoded; every other provider
call keeps its bound. Hub only, no schema or client migration. Recovery is a
CI-validated beta Hub reverting this change.

## Unreleased: Gmail reads large message bodies

`@gmail:read` showed "(no text body)" for mail whose HTML body is large, such as
a bank's credit-card statement: Gmail returns such a body by reference
(`attachmentId`) instead of inline, and the connector did not fetch it. A read
now fetches up to four such text bodies of at most 2 MB each through
messages.attachments.get; real attachments are still never read. The existing
Gmail grant covers it: no new scope, no reconnect. Hub only, no schema or client
migration. Recovery is a CI-validated beta Hub reverting this change.

## Unreleased: A quote is one yellow slip

A quoted passage in a sent message was a grey block followed by a dashed,
underlined "— author in #channel" link. Every quote is now one yellow paper
slip, the open ask card's wood thinned into the paper, sized to its words:
above the composer before it is sent, in the message once it is, and on the
words it marks when opened. A quote of a message in the same conversation is
its own reference: the slip alone, with no author, time or channel, which
jumps to that message and highlights exactly the quoted words. A quote from
another conversation keeps a quiet source line inside the slip. Same-channel
is decided by the link's path, so quotes written on xmatrix.sh, beta or the
desktop app all count. The Markdown Agents read is unchanged. Web only, no
schema or client migration. Recovery is a CI-validated beta release reverting
this change.
## Unreleased: Desktop navigation does not report a missing mobile push

The conversation push diagnostic added for WEB-Z also ran for desktop
selections, whose driver deliberately declines mobile animation. Reporting now
requires a mobile viewport and spends its once-per-page allowance only then;
a desktop page later resized to a phone can still report its first failure.
The missing-driver path supplies that same viewport flag. Animation behavior
is unchanged. Web only, no schema or client change; recovery is a CI-validated
beta Web release reverting the report scope.

## Unreleased: Conversation push diagnostics can be read

WEB-Z captured why the mobile conversation push declined, but the Sentry issue
reader omitted the shell conditions already attached to the event. Reads now
retain only its fixed boolean flags and allowlisted view/client labels, so an
existing event can identify the blocking condition without exposing arbitrary
extra data. The animation's underlying cause is still being investigated.
Hub only, no schema or client change; recovery is a CI-validated beta Hub
release reverting this projection.

## Unreleased: Floating menus highlight edge to edge

A floating paper menu's hovered item was a rounded box inset in the slip,
and its corners did not follow the slip's. Items now run to the slip's edges,
whose own corner cuts the first and last, with a hairline between groups: the
message and page selection menus, the table tools, the insert and mention
menus, a heading's menu and a message's More actions. Pill-shaped bars keep
their round items. The shared slip clips highlights with automatic overflow,
so a height-bounded menu still scrolls by wheel or touch; clipping with hidden
overflow had overridden the page editor's scrolling and made later options
unreachable by pointer. Consumers set their size, and the material owns this
common clipping and scrolling behavior. Web only, no schema or client migration. Recovery is a
CI-validated beta release reverting this change.

## Unreleased: A list's + row is centred, quieter, and shows Ctrl/⌘+N

The desktop "+ New conversation" row (and New page, Manage machines) drew a
bold, left-aligned label behind a thin + icon. The label now sits centred in a
lighter ink without the icon, and a faint ⌘N / Ctrl+N at the row's end, on the
label's baseline, shows the shortcut that already worked. Only actions Ctrl/⌘+N
performs show it; New workspace does not. Web only, no schema or protocol
change. Recovery is a CI-validated beta Web release reverting this change.

## Unreleased: Agent message headers name their repository

Agent message headers omitted the repository even though the Run already knew
it. The message commit now reads the admitted repository from the proven Run
in the authorization transaction and captures it as a Repository status tag,
including sends before runtime presentation arrives. A stale Instance chip
array cannot override or erase that repository.
It uses the sanitized repository reference rather than a managed checkout path;
later presence changes cannot rewrite historical headers. Existing Web and
native clients already render this tag. Hub only, no schema or client migration;
older messages without the snapshot remain unchanged. Recovery is a CI-validated
beta Hub release reverting this change.

## Unreleased: Claude runs report xMatrix as their client

Claude Code labels every request with the client that drives it. A Claude
started headless with `--print`, as every xMatrix Agent and one-shot text task
is, labelled itself `sdk-cli`, and Claude subscriptions currently use up the
5-hour window about twice as fast per token under that label as under the
interactive TUI's (anthropics/claude-code#97074). The daemon now sets
`CLAUDE_CODE_ENTRYPOINT=xmatrix` on every Claude it starts, overwriting a value
inherited from a parent Claude session, so transcripts and requests name
xMatrix. Client only; Agents pick it up when their Claude process next starts.
No schema or protocol change. Recovery is a CI-validated release reverting this
change.

## Unreleased: Quote a selected passage of a message

Selecting text in a message offered only Discuss. It now offers **Quote ｜
Discuss in new channel**: Quote puts the passage above this conversation's own
composer, with its author and Channel, and the next message sent there opens
with it as a quote linking back to the message; Discuss in new channel is the
former Discuss. Floating paper menus (this one, a message's hover actions, a
page's selection and `/` menus) are now a flat wood-tinted slip without a
shadow. Web only, no schema or client migration. Recovery is a CI-validated
beta release reverting this change.

## Unreleased: Handoff preserves explicit placement and Instance ownership

Handoff now parses launch conditions after the successor address and carries
an explicitly selected source machine forward by its admitted identity. An
override passes ordinary launch authorization; unavailable placement remains a
visible refusal. A successor starts only after its source's stop is confirmed.
Reborn stop failures retain the daemon's bounded reason. Exact Instance
assignments remain context for peers, while unaddressed messages and broadcasts
keep their existing behavior. Bootstrap identifies the current Instance and Run
and asks completed temporary helpers to stop, preserving unfinished waits.
Hub and CLI; no schema migration. Existing wrappers need a normal reborn after
updating CLI to load the new bootstrap. Recovery is a CI-validated beta release
reverting the change.

## Unreleased: Gmail sends from a verified send-as alias

`@gmail:send:<to> from:<address>` refused any address that was not a
connected mailbox, so a verified Gmail "Send mail as" alias (a company address
forwarded into a personal Gmail) could not be used. `from:` may now name an
alias Gmail lists as primary or accepted on one of the caller's mailboxes; the
mail goes out through that mailbox with the alias in From, the approval card
names both, and the alias is checked again just before sending. A reply to mail
addressed to such an alias goes out from it. The existing Gmail grant covers the
send-as read: no new scope, no reconnect. Hub only, no schema or client
migration. Recovery is a CI-validated beta Hub reverting this change.
## Unreleased: A new Gmail message is one card

A new-mail notification was followed by a separate Gmail read receipt that
held the automatic read, so every arrival took two messages. The connector now
reads first and posts one notification per Channel that carries the read as
its private result: the owner sees the email card; others and every Agent see
the unchanged notification text, which still wakes Agents and fires
Automations. A failed read says so in that text. The 30-per-hour automatic
read cap is removed; every read stays metered as `auto_read`. Hub and Web; no
schema change. History keeps its earlier receipts. Recovery is a CI-validated
beta release reverting this change.

## Unreleased: Content lock holders retain their last statement

HUB-BN's About write waited behind `content.ref.commit`, but the captured
idle transaction did not identify its last statement. The existing bounded
lock sample now retains a fixed, allowlisted content/billing query label and
query/state ages for content intent and reference transactions. Sentry's issue
reader exposes those fields without SQL, values or identities. This is missing
diagnostic coverage; the underlying slow round trip remains unproven. Locks,
timeouts, replay and unknown-COMMIT handling are unchanged. Hub only, no schema
or client migration. Recovery is a CI-validated beta Hub reverting this change.

## Unreleased: An agent that vanishes while starting says so, and Windows sees its running daemon

A Run whose process ended in `relay_registered`, `channel_joined` or another
phase before its agent was ready got no startup-failure notice and did not
count against routing, because the Hub and the routing breaker each kept their
own, shorter list of startup phases. Both now read one list in the protocol
(`RUN_PHASES_BEFORE_READY`), and a process the daemon only found gone says
that rather than the agent's bare name. A Run someone stopped is not a failed
start. On Windows the desktop App took a running daemon for a stopped one when
its two-second PowerShell scan ran out, reporting `service_not_up` with no
detail and offering a restart that ends the daemon's agents. A daemon lock
that refuses the App's read now counts as a running daemon, and the scan has
ten seconds. Hub and Desktop; no schema change. Recovery is a CI-validated
release reverting these files.

## Unreleased: CLI release feed reads recover one lost response

HUB-BM lost a CLI release feed response and flattened the failure into a
message without its origin or stage. A feed transport failure now gets one
fresh read, each bounded to five seconds and 64 KiB. Invalid feeds still fail;
owner queries retain their existing single-read recovery, and socket delivery
and the whole pass are never replayed. Failed attempts and independent cell
failures retain their original causes and fixed channel, stage, attempt,
duration and HTTP status in Sentry and its issue reader, without response
content or owner/cell identities. The external timeout's cause remains unknown.
Hub only, no schema or client change; recovery is a CI-validated beta Hub
release reverting this change.

## Unreleased: Database maintenance waits through release status changes

The lifecycle broker could select an older beta when a newer release moved
from queued to running between its separate status reads. Each poll now reads
one complete, unfiltered release-run list for both successes and active runs,
including waiting, requested, pending and older stuck trains. The existing
45-minute wait, annotated tag/SHA verification and executor authority gates
remain in force. Workflow and selection policy only, no schema or client change;
recovery is a CI-validated revert through the same broker, never direct executor
dispatch or a changed production tag.

## Unreleased: Gmail reads the HTML body behind a "view in HTML" stub

Some senders put only "Please view this email in an HTML capable client" in
the plain-text alternative and the real message in the HTML one. Gmail reads
and the automatic read receipt returned that stub. A short plain alternative
that is a prompt to read the HTML, or only a template's empty value such as
`None`, now yields its longer HTML sibling's readable text (no images,
scripts or remote loads). Any other plain alternative still wins, even a
short summary worded differently from the HTML or one that mentions HTML,
and mixed segments and attachments are unchanged.
Hub only, no schema change; recovery is a CI-validated Hub release reverting
this change.

## Unreleased: Page headings with leading separators can commit

HUB-BK exposed a mismatch between generated heading slugs and the page
repository's validator: `🚀 Launch` becomes `-launch`, which the repository
refused because it started with a separator. Live edits then stayed pending.
Commits, reads and discussion links now accept leading hyphens and underscores,
preserving existing anchors, the 200-character bound and other character checks.
Retained edits can commit through the session's existing alarm. Hub only, no
schema or client migration; recovery is a CI-validated Hub release reverting
the validation change.

## Unreleased: Public pages declare their own language and sharing URL

The Chinese homepage declared English until browser scripts ran. Separate
static language roots now send `zh-CN` in its initial HTML, matching its
hreflang, while sharing one document shell. English routes keep their URLs
and static rendering. Downloads, legal pages and versioned release notes now
name their own canonical URL in Open Graph metadata, instead of inheriting
the old domain's homepage. The Calendar guide link opens its repository
document directly. Web only; no schema or client change. Dual hosting, App
redirects and robots policy remain as configured. Recovery is a CI-validated
Web release reverting this change.

## Unreleased: No page slides in over another on a phone

A phone slid whole pages in and out as a stack (a View Transition) whenever
the lists could not trade places themselves: a notification tapped in another
conversation, a search result, and the Back from them. It is removed. A phone
moves in its two designed ways only: a conversation and its channel list
trade places, and the dock tabs slide. A notification tapped over the channel
list slides its conversation in as a tapped row does; over anything else it
replaces the screen; Back goes to the channel list. Web only; no client or
schema change. Recovery is a CI-validated Web release reverting this change.

## Unreleased: App Store Connect reads and submits one-time In-App Purchases

The App Store Connect connector listed and submitted only auto-renewable
subscriptions, so an app's consumables (credit packs), non-consumables and
non-renewing subscriptions could not be checked before a review or included
in one. `in_app_purchases` lists them with type and review state;
`submit_in_app_purchases` submits the ready ones (or those named). Hub only,
no schema change; recovery is a CI-validated release reverting this change.

## Unreleased: Legacy Desktop feeds can fetch their beta installers

The legacy metadata route still serves dev, but versioned file requests treated
beta filenames as stable and returned 404. The filename's version now selects
its channel: beta files read dev, stable files read stable, and unversioned
metadata keeps dev. Reads remain confined to that channel's published asset
catalog. Explicit native feeds, signing and stored artifacts are unchanged.
Web only; no client setting or schema migration. Recovery uses a new validated
Web release correcting the mapping, never a moved tag or changed artifact.

## Unreleased: Stable Desktop manifest URLs keep their channel

The dedicated and aggregate stable manifests now link every Desktop asset
through the existing explicit stable download route. Their YAML metadata used
the legacy unversioned route, which intentionally reads dev, so downloading it
returned beta bytes beside a stable version and checksum. Native stable updater
feeds were already explicit and remain unchanged; legacy URLs retain their dev
meaning. Web only, no schema, signing, artifact or pointer change. Consumers
follow the corrected URLs without migration. Recovery is a CI-validated forward
Web release correcting the mapping; published releases stay immutable.

## Unreleased: Settings guidance fits the CLI launch budget

The settings-card guidance pushed the CLI's compiled fallback launch text past
its existing 9,000-byte budget. Concise wording brings the default launch back
under that bound while retaining settings cards, commands, Page scheduling,
authority boundaries and the Channel contract. Hub-provided templates still
replace the fallback as before. Hub and CLI, no schema or API change; recovery
is a CI-validated forward release revising the wording. The existing bootstrap
owner test continues to enforce the unchanged budget.

## Unreleased: A web session counts only once a call needing it works

App Store Connect's connection check signs with its API key, so an expired web
session beside the key still read as checked. `xmatrix settings status` said
`in`, and a settings card for it could settle with nothing proven. A credential
field may now name a `verify` read in its manifest. App Store Connect's web
session names `web_session`. The field's state follows the Space's recent calls
that needed it: the latest one that ran makes it verified, and the latest one
that stopped on it makes it invalid, in that call's words. Saving it on a card
runs that read in the card's Channel. Asking for a setting now reads it as of
the request. Hub only, no schema change; recovery is a CI-validated release
reverting this change.

## Unreleased: The Agents page asks for quota when you look, not every 15 seconds

While the Agents page was open, every 15-second refresh asked the Hub to read
provider quota again, a daemon request a minute for as long as the tab stayed
open. It now asks when the page opens or comes back into view; a reading that
lands meanwhile (an Agent's turn, a refused summon's check) is pushed and
shown at once. Web only, no visual change; recovery is a CI-validated revert.

## Unreleased: Any setting only a person makes goes on one card

An Agent stopped on a sign-in, credential, Space secret, secret access or
harness login can now ask for it with `xmatrix settings ask <address>…`. This
is a Hub-defined command, so a CLI needs no update. One settings registry
turns each address (`connector:`, `secret:`, `secret-access:`, `harness:`)
into a descriptor from its own store. The card, the Agent's status read and
the wake use only that descriptor. The Web draws one settings card from it,
under a stopped connector receipt and on an Agent's request. Once every
setting is in, xMatrix answers the card, and that answer wakes only the
Instance that asked. Hub-written request cards (settings, secret, secret
access, harness sign-in, cross-Space read) now arrive live instead of after a
reload. Hub and beta Web, plus CLI help text; no schema change. Recovery is a
CI-validated release reverting this change. See
[settings cards](design/settings-cards.md).
## Unreleased: Machine scope timeouts retain the command holding the lock

HUB-BJ rejected a daemon report at its first SQL statement, waiting on the
Machine's advisory scope. The event could not identify the holder because
this lock was absent from the existing bounded wait sampler. A slow scope
wait now retains the holder's operation, state, wait type and capped age
before PostgreSQL removes the wait edge. The original lock rejection and
rollback still propagate without replay; the holder's underlying cause is
not established. Hub only, no schema or authorization change; recovery is a
CI-validated release reverting the sampler selection.

## Unreleased: Agents start without waiting on a quota read, and idle ones stop polling it

A Codex, Grok, Cursor or OpenCode Instance read its provider quota over the
network before its first turn, and a Claude Instance before announcing itself
ready, so every start waited on that request (seconds on a slow link, up to a
ten-second timeout). The read now runs beside the start and its reading
follows when it lands. An idle Codex Instance no longer asks for its quota
every minute; it reads it when a turn ends. A daemon answers a Hub probe that
checks a refused summon (`fresh`) from the provider rather than its
two-minute cache, so a reset or top-up is seen at once. CLI only; recovery is
a CI-validated forward release.

## Unreleased: A refused summon starts once its quota is back

A summon refused because a stored reading said its provider quota was used up
stayed refused after a reset or top-up until someone summoned again. Now the
refusal records what it rested on and asks that pool's daemon for one fresh
read. The reading that shows headroom, from that read or an Instance's own
report, marks the wait in the same transaction that records it; the Hub then
wakes the summon and the launch coordinator starts it under full admission. Many refusals of one pool
share one read. A summon's ordinary refresh reads only quota no current
reading covers, at most once a minute per daemon, and a waiting retry is
checked at its reset rather than every few minutes. Recovering a stopped
Instance still waits for its author's choice. Daemons from before this release
may answer the fresh read from their two-minute cache; the summon then starts
on the next newer reading. Hub release with expand migrations
(`0236_expand_registration_quota_waiters.sql`,
`0237_expand_quota_retry_refusal_fence.sql`); recovery is a CI-validated
revert, and the added tables and columns are unused by older code. Deleting
a Channel or Space erases its quota waits with its other records.

## Unreleased: Follow-up messages wait for the Agent already being started

Before a chosen Agent had a Run, a second message could offer another picker
and two concurrent picks could both succeed. The Hub now treats the Channel's
pending launch decision as startup ownership in both the Ask projection and
its locked claim. Follow-up evidence stays available for explicit recovery
after a failed, cancelled or expired startup; exact retries keep the original
decision. Hub only, no schema or client change; recovery is a CI-validated
Hub release reverting this pending-startup check.

## Unreleased: Runtime control-head deadlocks retain the live blocker

HUB-BH aborted a registration launch while advancing its Space control head.
The original event names the failed query but cannot identify the other
transaction in the cycle. Runtime and machine lifecycle head updates now use
the existing bounded lock-wait sampler before PostgreSQL removes the wait
edge, retaining only the other operation, state, wait type and transaction age.
The original rejection, rollback and replay boundaries are unchanged; no
underlying lock-order cause is claimed. Hub only, no schema or authorization
change; recovery is a CI-validated release reverting the sampler selection.

## Unreleased: Used-up quota pools are no longer re-read on a clock

The minute re-read of pools held used up (#1321) is withdrawn: quota is read
when work needs it, never on a timer. Hub only, no schema or authorization
change; recovery is a CI-validated revert of this change.

## Unreleased: An agent that quits or waits for a sign-in is not chosen

The daemon's can-it-take-work check counted only credential errors, so an ACP
agent that quit before opening a session (a WorkBuddy-bundled CodeBuddy on
Windows) stayed "unknown" and routing kept choosing it. Any failure before a
session opens now reads as unable to take work, in the agent's own words, with
the existing Check again. A credential retry that waits on a browser login
(CodeBuddy Code without a sign-in) fails as signed out after 20 seconds instead
of hanging the start. CLI only, no protocol or schema change; recovery is a
CI-validated CLI release reverting `runtime_acp_session.rs`.

## Unreleased: Daily PostgreSQL maintenance waits for a release to finish

A concurrent Production Release could outlast the lifecycle broker's six
short polls and skip the daily cleanup. The broker now waits up to 45 minutes,
within a 60-minute job, and reselects the latest successful beta before
verifying its annotated tag and exact SHA. An exhausted wait still refuses
to dispatch a stale tag. No retention, schema or credential change; recovery
is a CI-validated revert of the broker workflow. See
[lifecycle retention](operations/postgres-lifecycle-retention.md).

## Unreleased: Update manifests name their actual publication workflow

Public client update manifests now identify Production Release beside their
exact commit and run, replacing the retired CLI workflow label shared by all
client manifests. Beta Web only, no schema or authorization change; recovery
is a CI-validated Web release reverting the label.

## Unreleased: CLI releases use the compiler their pull requests checked

Unix release builds used the runner image's default Rust while PR Clippy used
1.96.0, so new compiler warnings could first fail a production release. Linux
and both macOS CLI targets now install and verify the same reviewed compiler
as PR Clippy, matching the existing Windows pin. No API or schema change;
signing, artifact verification and release gates are unchanged. Recovery is a
CI-validated forward release updating the shared compiler pin after native
qualification.

## Unreleased: A daemon reconnect leaves old snapshots behind

HUB-BF exposed a snapshot queued before disconnect and sent after the next
connection authenticated. The Hub correctly refused its stale epoch. The CLI
now discards full and partial snapshots from a replaced connection at the
socket writer boundary; reconnect captures a fresh full snapshot instead of
restamping an old observation that could retire a newly admitted Run. Durable
spawn results keep their original causal fields for reconciliation. CLI only,
no protocol or schema change; existing daemons need the updated CLI. Recovery
is a CI-validated CLI release reverting the sender check.

## Unreleased: The CLI uses the panic-safe hash buffer patch

The CLI now locks block-buffer 0.12.1, the same-line fix for
[GHSA-qwgh-2vcv-g2f7](https://github.com/RustCrypto/utils/security/advisories/GHSA-qwgh-2vcv-g2f7).
The old buffer could retain an invalid cursor after a compression or block
generation callback panicked and its caller caught the panic and reused it.
The CLI uses this dependency through SHA-2; no such application callback path
has been identified. Hash formats, APIs and stored data are unchanged. CLI
only; recovery is a CI-validated CLI release reverting the lock, which would
restore the advisory exposure.

## Unreleased: The phone's loading dock waits until it can navigate

The startup frame drew enabled Pages/Channels/Status/More buttons with inert
handlers. A tap before session resolution disappeared when the real shell
mounted. Those placeholder buttons are now disabled; the real dock enables
them when it can navigate. Web only, no API or schema change; recovery is a
CI-validated release reverting the disabled startup state.

## Unreleased: Codex on credits no longer shows LIMIT

ChatGPT now reports a Codex account as not allowed as soon as its plan week is
used up, even while credits keep serving it. Such Instances showed LIMIT and
routing could treat them as refusing work. The CLI now records the account as
serving while it has credits and no overage or spend limit is reached, so the
Agents list shows credits and routing keeps using it. CLI only, no API or
schema change; recovery is a CI-validated CLI release reverting the check.

## Unreleased: Every client names a file's type from one table

Which type a file extension names, which extension a saved copy gets and
whether a conversation or a page shows a file inline now come from one table
the Web, the Hub and the CLI all read. A conversation shows MKV, AVI and MPEG
videos as video wherever the Web already did, downloads of audio get their
extension, `xmatrix send --file` names every listed type (AVIF, Opus, WebA and
more), and an Agent's local copy of an `audio/mp4` voice note is `.m4a`, not
`.mp4`. Web, Hub and CLI, no API or schema change; recovery is a CI-validated
release reverting the table.

## Unreleased: The site also answers at xmatrix.page

xmatrix.sh is a country-code domain Google does not treat as generic, so the
site was indexed as a Saint Helena site. The stable Web now also serves the
marketing site at xmatrix.page: the home pages, docs, download, release notes
and legal pages answer there, and canonical URLs, the sitemap and robots name
xmatrix.page on both origins, so search engines index it there. Every page
still answers at xmatrix.sh and nothing redirects away from it; at xmatrix.page
any other path, the app and sign-in among them, goes to xmatrix.sh with a
temporary redirect. The Hub, its OAuth callbacks, webhooks, MCP endpoint, token
issuer and the session cookie are unchanged. Stable Web only, no API or schema
change; recovery is a CI-validated stable Web release without `web.siteOrigin`.

## Unreleased: Seeing a CLI behind checks for its update at once

The daemon updated only when the Hub's release push reached it, and a Machine
page could not tell a check that ran from one that never arrived. A view that
shows a Machine's CLI behind now asks its daemon to check now, and the daemon
reports each step it actually takes (checking, installing a version, current,
or failed with the reason) for the page to show. The Hub joins requests within
a minute and touches only that Machine; the daemon folds requests into a
running check and answers a request during its post-failure hold with that
failure. Older daemons are answered "unsupported" without being asked. Hub,
CLI and a Web proxy route, no schema change; recovery is a CI-validated release
reverting the request route and report.

## Unreleased: The daemon updates its CLI when a release is published

A machine could run the previous CLI for up to 30 minutes after a release,
because the daemon read its release feed on a 30-minute clock while the web
already marked it "Update". The daemon now keeps no clock: besides its startup
check it updates when the Hub pushes `machine_cli_release`. Every minute the Hub
reads the stable and dev CLI feeds and tells, over their existing connection,
the online daemons on that channel still behind it, until they reconnect on the
new version. Hub and CLI, no schema change; older daemons keep their clock
until they update. Recovery is a CI-validated release reverting the notice.

## Unreleased: Approved connector actions explain stale approval failures

An action approved after its OAuth token approached expiry could refresh the
credentials and then fail the approval's credential-version check. The receipt
called that internal refusal a provider failure. Known approval and credential
authority errors now report a blocked action with the required connection review
or new approval. Unknown exception details stay hidden; approval checks, single
use and write retry rules remain unchanged. Hub only, no schema change; recovery
is a CI-validated release reverting the receipt mapping.

## Unreleased: Connector JSON commands keep working with web addresses

A connector command containing a URL in a JSON string could be treated as
ordinary speech and never run. Markdown's generated autolink lacked source
positions, so context filtering excluded the entire message. Plain autolinks
now recover their offsets when their ancestor reconstructs its source exactly,
preserving the command outside them; links, code and quotations still cannot
invoke anything, and unmappable literals still fail closed. Hub and beta Web, no schema or permission
change; recovery is a CI-validated release reverting this parser correction.

## Unreleased: On a phone only the lists move between a conversation and its list

Opening a conversation and going back slid the whole page, bar included, and
the iOS left-edge swipe slid a snapshot of the screen with a shadow. Now the
bar, its wood sign and the controls at the bottom stay where they stand: only
the conversation and its Space's channel list move, side by side as one flat
strip with nothing drawn between them, and the names slide through the still
sign. The bar's glyphs (share and more, search) and the bottom controls
(composer, dock and +) trade places where they stand. The iOS swipe follows the
finger and lands on a critically damped spring from the finger's speed; the
page draws it from the distances the app sends (`window.__xmatrixBackGesture`),
and the native tab bar fades in with the list. The bar's chevron and opening a
conversation from the list play the same motion. Switching dock tabs moves the
whole page, sign included, so the two read apart. A Back the page does not draw
(an open page, channel details) keeps the snapshot slide, without its shadow
(#1229), and a list no longer scrolls under the same finger while the page
draws the swipe (#1244). Each frame touches only the dozen elements that move,
through their own inline styles, and starting or ending the change renders only
the layer that draws the list's bar and controls, not the shell: a move costs
12 ms instead of 144 ms at 4x CPU throttle (#1250). Everything that moves is
then its own compositor layer moved by transform or opacity alone, the rest of
the way after release runs on the compositor as keyframes sampled from the same
spring, and the iOS app reports a touch at the left edge so the page sets the
change up before the swipe is recognized: the swipe begins in 2 ms, a move
costs 3.5 ms and repaints only the sign, and a swipe that catches the
spring-back carries on from where it is (#1255). The moving parts' own CSS
transitions are off for the length of the change, so none trails the finger
(the leaving name had stood 48 px behind it), and a drag seeks paused
animations laid once for the whole way instead of writing inline styles: a
drag frame takes 3.6 ms of main thread instead of 6.2 (#1260). Beta Web and
iOS, no API or schema change; recovery is
a CI-validated release reverting the change (an iOS build without it falls back
to the snapshot slide, since the page answers only the new bridge call).

## Unreleased: A failed redial no longer re-reads every workspace list

Since #1225 the Human socket also announced a redial that failed and waits out
backoff, and the shell re-read every workspace resource (launch targets,
Automations, transfers, cross-Space reads, connector approvals) on each such
announcement. While the Hub was unreachable each failed redial fetched all of
them again, although nothing had changed. They are now re-read only when the
socket connects or drops (#1243). Beta Web, no API or schema change; recovery is
a CI-validated release reverting the change.

## Unreleased: An App's Recent activity is a call log that names the calling Agent

Recent activity printed each run's whole answer on the page, so a calendar list
ran as raw JSON across the background. It is now a call log on one rounded
tinted sheet: per call the day and minute, the action and its command, who made
it and how it ended, and under it the sentence it answered with; the returned
content stays in the conversation. A call an Agent made now names that Agent
with both faces ("claude for Daniel"): the Hub records the Agent's name and
harness when the call runs, in new nullable `requested_by_agent` and
`requested_by_harness` columns (migration 0232); earlier calls show only
their person. The copy line on App pages shares the sheet's tint,
radius and width (#1234). Beta Web and Hub; additive schema change; recovery is
a CI-validated release reverting the change (the columns may stay).

## Unreleased: A page's code blocks take syntax colours

A page's code blocks were plain text. They now take the same low-chroma inks
as a code block in a conversation (#1238): in the live editor as decorations
over the text, in the read-only preview and public pages once drawn. A fence's
language picks the grammar; a fence without one is coloured only when a
grammar clearly claims it. Beta Web, no API or schema change; recovery is a
CI-validated release reverting the change.

## Unreleased: Code blocks in a conversation are the same paper as a page's

A fenced code block without a language drew its code as an inline chip, so in
the light theme every line wore its own rim and long lines were cut off; every
block also carried a bold uppercase CODE title band and a border. A code block
in a message is now one piece of tinted paper, the same as a page's code block
and quote: plain monospace ink that scrolls sideways, the language as a quiet
label (an icon and the language's name in the interface face, so it never reads as
the first line of code) only when the fence names one, and copy at the corner. Code takes
syntax colours in low-chroma inks (highlight.js, loaded only once a code block
appears): by the fence's language, or, for a fence without one, only when a
grammar clearly claims it, so a table or a log stays plain. A quote in a
message is the same tinted paper instead of a rule beside grey text. Beta Web,
no API or schema change; recovery is a CI-validated release reverting the
change.

## Unreleased: Apple sign-in names why native authorization stopped

An Apple authorization error 1000 with no underlying error could be a missing
window, an empty nonce, a failure before Apple showed its sheet, or an unknown
system failure, and those were the same report. The attempt now keeps whether
the page's window, another on-screen window, the window captured at the start,
or no window was available, whether Apple asked for a presentation anchor, the
application phase, the nonce shape (empty, 64-character hex, or other), and
whether the error carried userInfo keys outside a fixed allowlist. Descriptions,
key names, values, and the nonce are not included. A missing window or an empty
nonce is reported as that fact and Apple is not asked. A replaced attempt cannot
complete the new one. Authorization is not replayed. The native string stays
inside the browser defect limit. iOS only; recovery is a CI-validated beta iOS
release reverting this change.

## Unreleased: The Mac app opens with its traffic lights centred on the rail

The Mac app's first frame, drawn before the app's script runs, laid out the
browser's 64px rail, so the traffic lights spilled off the wood onto the paper
until the script added the macOS frame and everything jumped to the 80px rail.
The window frame (macOS and Windows) now reads the platform from
`<html data-desktop-platform>`, which the root layout's inline script sets
before the first paint, so the window opens in its final layout. Beta Web, no
desktop, API or schema change; recovery is a CI-validated release reverting
the change.

## Unreleased: Stripe Checkout returns open Billing again

Since #1203, Stripe Checkout and portal returns to `/billing`, and the
allowance notice's link outside the shell, opened Settings › Account, so a
returning payer had to find Billing before their payment was confirmed. They
open Billing again, and confirmation runs there (#1227). Each view's address
field is now named once in protocol, and the shell, provider returns and the
Hub's Apps redirects build addresses from it. Beta Web and Hub, no API or
schema change; recovery is a CI-validated release reverting the change.

## Unreleased: Text-task answer failures retain the failing database path

HUB-BC completed a text task but timed out applying its Channel About. Its
best-effort handler discarded the original stack and database evidence. It now
reports that exception once, retaining the named query and transaction phase;
slow Channel metadata root/control-head locks also capture the bounded live
wait graph, with a fixed catalog writer category. Diagnostic connections share
the existing one-per-isolate budget. This fills missing evidence, not a proven
repair of the underlying contention. Completed commands are still acknowledged;
replay, authorization and unknown-COMMIT rules are unchanged. Hub only, no
migration; recovery is a CI-validated beta Hub release reverting the change.

## Unreleased: Returning to the iOS app no longer says "Reconnecting"

The iOS app replaces its live connection every time it comes back to the
foreground, and on cellular the new connection often took longer than the
4 s grace, so the open app said "Reconnecting to xMatrix…" when nothing had
failed. The tile now waits until a redial has actually failed (#1225).
Offline still shows at once. Beta Web only, no API, schema or native change;
recovery is a CI-validated beta Web release reverting the change.

## Unreleased: Unreadable Channel catalogs answer not found

Opening a Channel list for a Space the account cannot access returned an
internal error even though authorization correctly withheld the rows. Catalog
pages, counts and resolution now return the same non-retryable 404 for an
unreadable or nonexistent Space. Membership and Channel access checks stay in
PostgreSQL; this changes the rejection response, not access. Hub only, no
schema or client change; recovery is a CI-validated Hub release reverting the
error classification.

## Unreleased: The app downloads a sixth less code before its first screen

Tool views (Status, Agents, Machines, Schedules, Apps, Settings, Team, Profile,
Platform admin), the Agent configuration page, the trace window and error
reporting no longer load before the first screen of `/app`: initial JavaScript
falls from 3.64 MB to 3.02 MB (1.17 MB to 0.98 MB gzip). Each view loads when first
opened and shows its loading skeleton meanwhile; errors before error reporting
starts are held and sent. Measured in [Channel startup](performance/channel-startup.md#cold-start-tool-views-and-error-reporting).
Beta Web only, no API, schema or native change; recovery is a CI-validated beta
Web release reverting the change.

## Unreleased: Opening the app no longer waits for a page to be rendered

`/app`, where every desktop, iOS and browser launch starts, was rendered by the
Web Worker on each request; on a fresh connection a cold Worker took 0.7–2.1 s
before the first byte. The page is the same for everyone (the startup frame;
sign-in and the signed-out redirect happen in the browser), so it is now
prerendered once per build and the Worker answers with that copy before any
route code loads, as it already did for other prerendered pages such as sign-in.
The copies ship in the same deploy as the scripts they name, and every cache is
told to revalidate them (`public, max-age=0, must-revalidate`), so a deploy never
serves a page naming removed scripts. Deep links under `/app/<space>/…` are still
rendered per request. Beta Web only, no API, schema or native change; recovery is
a CI-validated beta Web release reverting the change.

## Unreleased: Launching the app reopens the last conversation

Opening the bare `/app` now goes straight to the conversation this account
last had open on this device (its address, ids only, kept per user in
localStorage), as soon as the account is known, so its history read starts
with the first reads. A notification's `/app?channel=` and `?view=` launches
keep naming their own screen. When that conversation can no longer be read,
the launch settles on its Space's list. Web only.

## Unreleased: Each app start reports how long it took for the person

Once per page load the app sends when it first reached its shell, signed in,
its Channel list and its first messages (ms since navigation; absent when not
reached), its device, and whether it painted this device's cached list
(`warm`/`cold`). The Hub writes one diagnostics point per start under the
person's keyed hash (`startup`/`startup_timing`, doubles 3–6), with no Space,
Channel or content. Nothing waits on it. Hub and Web; an older Hub answers 404
and the start simply goes uncounted.

## Unreleased: The Apps list groups by connection state and ticks what works in green

The Apps list put category headings (Code & CI, Chat…) beside Connected, mixing
a state with what an app does, and connected rows carried no state mark. Sections are
now connection states only: Needs attention, Connected, Disconnected, Not
connected and Coming soon. Categories are subheadings inside Not connected, and
each connected row ends in a green tick. Unit and browser coverage check the sections,
the subheadings and the mark. Beta Web only, no API, schema or native change;
recovery is a CI-validated beta Web release reverting the change.

## Unreleased: Stripe payment notifications include the App's publishing account

Temporary refresh conflicts, storage/network failures and rate limits in the
publisher's event confirmation return 503 for Stripe to retry. Confirmed
401/403/404 read refusals remain acknowledged without delivery; temporary failures no
longer silently lose a notification. No configuration, schema or scope change.

Stripe Channel notifications cover paid invoices, successful payments and
subscription creation as well as failures, disputes and later subscription
changes. Subscription creation keeps its real status and does not imply a
successful payment. Amounts are labeled as Stripe minor units.

Stripe excludes an App's publishing account from Connect webhooks, even after
OAuth installation. A separate operator-configured own-account endpoint now
verifies its independent signature and reads the same event using each Space's
current OAuth grant before posting. Reconnection or removal fences an in-flight
delivery. It keeps all retained merchant grants, the five read-only permissions,
and billing unchanged. The platform endpoint still ignores events without an
account. Hub only, no schema or client change; the endpoint stays unavailable until its optional configuration pair is deployed. See [Stripe accounts](connectors/stripe.md#the-app-publishers-own-account).

## Unreleased: The iOS app says when its page cannot load and retries

A main-frame load that fails (not a cancelled navigation) now shows a
tinted-paper tile over the app's paper, "can't be reached" or "offline", with
Try again; it retries when the network returns (NWPathMonitor) and every 15 s,
and a page whose web process iOS reclaimed reloads instead of staying blank.
iOS only.
## Unreleased: The open app says when it is offline or reconnecting

A tinted-paper tile over the reading column, just under the top band, says
"You're offline" while the browser is offline, and "Reconnecting to xMatrix…"
when the live connection has dropped for more than 4 s after it had connected.
It disappears when the connection returns; nothing on screen is blocked. Web
only.

## Unreleased: A desktop window always appears and says when the app cannot load

A new window shows within 1.5 s even while the app's page is still on its way.
A main-frame load that fails (not a cancelled navigation) shows a tinted-paper
status in the window, "can't be reached" or "offline", with Try again; it
retries when the network returns and every 15 s, and a crashed renderer
reloads. Desktop only.

## Unreleased: Android opens its own copy when the edge answers with a server error

A main-frame 5xx from the Web origin (an edge error page) now opens the copy
of the app the Android shell carries, as a network failure already did, so the
person sees the app's startup frame and its connecting status instead of an
error page. Android only.

## Unreleased: Startup reads answer in time and failures show in place

A sign-in session read (Web and native) now gives up after 15 s and counts as
a transient failure the existing backoff retries, and each Channel list page
attempt after 20 s, retried as a dropped connection, so a silent network no
longer holds startup forever. A conversation whose latest messages cannot be
read shows why where the messages would be, instead of a skeleton that never
ends; the periodic read keeps retrying. While the Space's list has not
answered, the reading pane shows its skeleton rather than "No conversations
yet". Web only.

## Unreleased: A Space keeps every Stripe account it connects

Connecting another merchant previously replaced the Space's single Stripe
grant. Each account now has an independently encrypted grant, refresh lease
and event binding, shown under Stripe accounts with Add and Remove actions.
Stripe's own picker still authorizes one merchant at a time. Uninstalling or
removing one merchant leaves the others connected. Check reads events using
the existing `event_read` permission, including an empty list, and fails on
a refusal; it no longer requests account profiles with an ungranted permission.

Hub and beta Web, with additive migration 0231 and no client protocol change.
The new Hub adopts each old verified grant atomically under its parent lock;
pending copies cannot route events. Retained grants use the new account store,
so Hub recovery is a CI-validated forward fix that keeps that store. Do not
roll the Hub back to the old single-grant reader after adoption. Web recovery
can revert its UI independently. See [Stripe accounts](connectors/stripe.md).

## Unreleased: The app opens on its own frame and says what it waits for

The preparation progress bar and the signed-in shell's full-screen spinner are
gone. Both waits render one `StartupShell`: the wood frame with the account's
last list, or the list's skeleton, from the server's first frame onward. List
skeletons no longer name a section before the list arrives. A tinted-paper
status, timed by CSS so it works before scripts run, says "Connecting to
xMatrix…" after 2 s, that it is still trying on a slow network after 6 s, and
offers a reload after 15 s; an offline device says so at once. Web only.

## Unreleased: Automatic harness updates keep trying until installed

With the Machines switch on, harnesses still sat weeks behind. The Hub stopped
telling a daemon once it had seen a new version, the daemon queued that update
in memory only, and the update waited for every Run on the machine to end.
Self-updating harnesses were assumed to update themselves, but they do not in
xMatrix's headless launches. Now, while the switch is on, the daemon runs the
official update. The Hub tells it every 30 minutes until the inventory shows
the latest version installed, and daily for harnesses without a registry. Only
live Runs of that same harness delay it. Hub and daemon, no schema change.
Recovery is a CI-validated beta revert.
## Unreleased: Shared links name the selected object

An Apps link such as `?connector=stripe` previously stayed on the list because
detail selection read `item`, while only OAuth returns interpreted `connector`.
Apps now uses `connector` for opening, switching and closing details, including
OAuth and Gmail returns. The old Apps `item` parameter is removed without an
alias. The shared item hook and helpers are removed; Agents use `agent`,
Machines use `machine`, Schedules use `schedule`, Settings/admin use `section`,
and Team uses `space`. Existing item-only links return to their destination
list; this is an intentional address change across Web consumers. Beta Web only, no protocol
or schema change. Recovery is a CI-validated beta Web reverting this change.

## Unreleased: A new Page keeps its first pasted image

Pasting an image or video into an empty new Page captured its still-null id
while the first write was creating it. The media ref then failed to bind.
The editor now awaits that same creation before uploading against the permanent
Page id. A browser regression reproduces the null owner id before the fix.
Beta Web only, no schema or protocol change; recovery is a CI-validated beta
Web reverting this change.

## Unreleased: Unchanged Page edits preserve a word being typed

A repeated Markdown write could parse an unchanged projection back into the
live document and remove the trailing space a reader had just typed. The next
word then joined the preceding one. The Hub's fragment writer and the parallel
Web preview writer now leave an unchanged projection alone; empty documents
still initialize and actual edits still apply. Real Yjs regressions reproduce
`Shipped andverified` on both old paths. This independently establishes the
bug; the original browser first attempt has no trace proving its timing. Hub
and Web, no migration or native update; recovery is a CI-validated beta revert.

## Unreleased: Agents can upload Page images and videos

Agents previously could only preserve images pasted by a person; new local
images were refused with an editor-only instruction. `xmatrix page upload
<page> <file>` now uploads images and videos to the Page's private content and
returns Markdown for ordinary edits or live writing. The Hub checks current
Page write access and canonical Space/Page/hash refs on every binding, including
replays. Text never causes an implicit local-file upload. Hub and CLI, no schema
or wire migration; older CLIs continue to preserve existing media. Recovery is
a CI-validated beta reverting the change. See [Page media](design/pages-live-document.md#66-images-and-videos).

## Unreleased: Pasted page images upload to the Hub straight

Pasting an image into a page sat at about 80% and then the image vanished.
The Web's Worker (OpenNext) reads a whole request into memory before its route
runs, so the upload body sent through it showed no progress while the Worker
re-sent it, and the 30-second stall watchdog gave the upload up. The browser
now sends the body straight to the Hub from the app's own origin, with its
bearer and client identity and never a cookie, as page reads already do; a
`401`, `426` or no answer across origins goes through the Web. Message
attachments share the path. Hub and Web, no migration. Recovery is reverting
#1196. See [Client resilience](architecture/client-resilience.md).

## Unreleased: The app starts one Hub round trip sooner and paints its last list

Web sign-in now takes the bearer from the `set-auth-jwt` header the Hub's jwt
plugin already returns on a signed-in `get-session`, instead of a second
`/api/auth/token` request, so every launch reaches its first reads one Hub
round trip sooner. A remembered compatibility admission is keyed by Hub,
component, protocol and platform rather than the exact version, so the first
load after a release no longer waits behind the preparation bar; the Hub is
still asked in the background and a refusal still opens the upgrade wall. The
presentation-only Channel list snapshot is now written whenever the list
settles, so a returning account sees its last list while its session is
confirmed; it remains inert and user-partitioned. App routes preconnect to the
Hub while scripts download. Web only. See
[Channel startup performance](performance/channel-startup.md).

## Unreleased: Message append recovers a lost pre-COMMIT response

HUB-B6 lost its final live-routing read after publication writes, before COMMIT.
The database-only append now closes that session and retries once on a fresh
connection, checking authority and rebuilding reply/attention recipients for
each attempt. Real PostgreSQL coverage verifies one committed message, mutation
and outbox entry, fresh reply targets, bounded repeated loss and the unchanged
unknown-COMMIT boundary. Delivery remains outside the transaction; unknown
commits use existing receipt reconciliation. This repairs recovery without
attributing the underlying disconnect. Hub only, no migration or client change;
recovery is a CI-validated beta Hub reverting this change. See
[PostgreSQL recovery](operations/postgres-hyperdrive-origin.md).

## Unreleased: Stackless Durable Object outages retain their HTTP caller

HUB-B5 reached the common HTTP outage handler without an originating stack;
its console report discarded the route, leaving only the common capture stack.
The original exception now reaches Sentry once with its registered method and
route template, or the fixed PageSession/Harness watch boundary, and boolean
platform flags. The issue reader exposes only that bounded diagnostic, never
path values, request data or identities. Different routes retain independent
fingerprints. Existing 503 responses and replay boundaries are unchanged.
HUB-88/9C share this diagnostic gap; their underlying invalidation remains
unproven. Hub only, no migration or client update. Recovery is a CI-validated
beta Hub reverting this diagnostic change. See
[Runtime delivery errors](operations/runtime-delivery-errors.md).

## Unreleased: Bounded schema collections reject oversized input early

The Hub authentication and AI SDK dependency graph now resolves Zod 4 to
4.6.6, fixing GHSA-mrhx-c7xc-m3w5 for constrained collections: size checks
reject oversized arrays, maps and sets before validating their elements.
Unbounded schemas still need transport limits; the authentication stream
limit remains the protection for those inputs. Zod 3 in the build tooling
is outside this change. Hub and beta Web, no schema or protocol migration.
Recovery is a CI-validated beta reverting the dependency constraint and lock,
which also restores the dependency risk; keep the transport limit in place.

## Unreleased: A failed App run is fixed where it shows

Apps → Recent activity showed a failed private call as a user id and
"Result: [hidden — private call]", with no cause and no next step. A failure
now records its remedy: sign in again for a credential, replace one, or
reconnect. The failed row names the problem and offers that fix in place
(App Store Connect sign-in in the desktop app, a paste field in the browser,
Reconnect for OAuth apps), then runs the read again and shows the result.
Every stopped read has Retry, through a new retry route that runs the recorded
command as the person asking, with its original visibility. A private call is
private from the rest of the Space, not from the person it ran for: their row
shows the original, and the Hub's own guidance is never masked. Hub and beta
Web, with additive migration 0229 and no host update. Recovery is a
CI-validated beta reverting the change while keeping the additive columns.

## Unreleased: An empty Channel cannot keep another Channel's history

A connected focus request stamps its target before its history arrives. An
empty fallback page could therefore mistake the previous Channel's retained
rows for the target's current window and keep them. Returning to the previous
Channel then showed a blank until the next read restored its render authority.
The empty-page guard and merge base now verify the rows' Channel as well as
the focus refs. The existing painted-frame switch case covers a connected
socket with a delayed focus page and an empty HTTP fallback; it fails before
the fix. Beta Web only, no API, schema or native change; recovery uses a
CI-validated beta Web reverting this change.

## Unreleased: Slow Channel opens keep their messages in place

A Channel's hidden virtual list could finish measuring after the 1.2-second
bottom-stick grace. Its growth then started the ordinary bottom-follow glide
behind the opening rows; taking them over mid-animation moved the messages
down and back. Bottom following now lands directly while the opening tail
exists, retaining the existing glide once the conversation is open. Browser
coverage crosses the wall-clock grace during a populated Channel switch and
checks every painted frame. Beta Web only, no schema or native change;
recovery is a CI-validated beta Web release reverting the change.

## Unreleased: Choose to wait when provider quota blocks every Agent

Usage exhaustion still attempts the ordinary automatic handoff first. When no
eligible Agent can take over, the task owner can choose **Retry when quota
recovers** or **Not now**. A rejected initial summon has the same choice.
Waiting survives closing the browser, can be cancelled, and has a fixed 35-day
limit covering monthly resets. Only a newer provider quota reading authorizes
retry; expiry of a routing hold never does. Staged launch and original-session
continuation replay retain one attempt, current permissions and stop/source
fences. Hub and beta Web, with additive migration 0228 and no host update.
Older clients retain the ordinary failure text. Recovery is a CI-validated beta
reverting the feature while retaining the additive table. See
[quota recovery](operations/agent-quota-recovery.md).

## Unreleased: Message preflight lock failures retain their blocker

HUB-B3 timed out while append's combined authorization preflight waited for
the Channel row. The existing execution-owner and Agent Channel-lock sampler
did not cover this query. It now shares their one bounded diagnostic connection
per isolate, retaining only fixed waiter/blocker state, owner category and capped
transaction age. Real PostgreSQL append coverage checks a held Channel lock,
unavailable diagnostics, the original rejection, no partial message and a
successful uncontended retry without extra sampling. This closes missing
diagnostics; the underlying holder remains unproven. No lock, authorization,
deadline or replay policy changes. Hub only, no migration; recovery is a
CI-validated beta reverting this diagnostic change.

## Unreleased: Channel catalog stalls retain evidence and GitHub invalidation recovers

HUB-B0 exhausted its existing single-read recovery without source activity
evidence. Channel catalog reads now share the placement-read diagnostic from
HUB-B1: each slow attempt samples only its own active source statement, keeping
fixed state, wait and blocker categories without SQL, parameters, identities or
the ephemeral marker. Fast reads open no diagnostic connection. This closes a
diagnostic gap; the underlying stall remains unproven. HUB-B2's database-only
GitHub catalog invalidation now replays once on a fresh session when a response
is lost before COMMIT. Unknown COMMIT and answered failures still fail the
webhook, and notifications remain outside replay. Hub only, no migration;
recovery uses a CI-validated beta Hub reverting these changes.

## Unreleased: Placement read timeouts retain origin wait evidence

HUB-B1 exhausted both fresh-connection single-read attempts while resolving a
Page's Space placement. Recovery already existed, but the event could not show
whether the origin was still executing or waiting. Placement reads in flight
for 500 ms now take one bounded live origin sample, sharing the existing lock
diagnostic connection limit. Each attempt uses a temporary SQL marker; failure
evidence retains only fixed state/wait/owner categories and capped ages, never
SQL, parameters, identities or the marker. Missing and unavailable samples do
not establish a transport cause. Real PostgreSQL coverage checks blocked reads,
both attempts, diagnostic failure and fast reads; the Sentry reader checks its
strict projection. Hub only, no migration or native update. Recovery is a
CI-validated beta reverting this diagnostic change; replay boundaries stay intact.

## Unreleased: Welcome text and provider quota recovery agree with the UI

The welcome conversation's stored fallback text now excludes Agents whose
program is reported signed out, matching its live Web card, and reads every
registration page. It remains a one-time historical message; the Web card
continues to reflect registrations arriving later. Provider quota refusal
text identifies the provider account limit and asks the person to choose
another Agent or resend after their provider resets it; unavailable reset
times are not invented. This ships in the Hub and beta Web with no migration.
Recovery is a CI-validated beta reverting the text change.

## Unreleased: Run credentials recover after computer sleep

The daemon now measures its one-minute token reuse window by the wall clock,
and wrappers check wall-clock refresh deadlines at most every 15 seconds.
macOS monotonic timers stop during sleep while the Hub's ten-minute Run
credential continues to expire; a long sleep could therefore reuse an expired
credential and fail relay registration. Initial registration refreshes a
refused Run credential through its existing daemon grant and retries once;
repeat refusal and revoked Run authority still fail. Real local broker and
WebSocket coverage checks recovery and the retry bound. This ships in the CLI
and Desktop seed with no protocol or data migration. Recovery is a CI-validated
beta reverting the client change; existing Runs and grants are preserved.

## Unreleased: Calendar approvals preserve notification and recurrence meaning

Calendar approvals described `externalOnly` as an organization boundary and
discarded week-start and exact-cutoff details while translating recurrence.
Hub validation and Web approval copy now share the protocol's notification
modes; external-only means guests who do not use Google Calendar. Repeat
rules are translated only when every clause is represented, otherwise their
complete original is shown. Unknown modes cannot be approved. Regression
cases reproduce the prior behavior at the projection and browser boundaries.
Hub and beta Web, no migration or native update; recovery is a CI-validated
beta reverting this change. Existing stored approval previews stay readable.

## Unreleased: Each app has one permission

Apps now have one Space-connection setting: Read only, Ask first, or Read and
write. Calendar defaults to direct scheduling; Gmail, Ads, X and Linear default
to Ask first. The same choice applies in every conversation. Per-action and
Channel policies, their command parser and their runtime queries are removed;
legacy API bodies are rejected rather than interpreted as wider authority.
Claude's one-row selector ships with the backend. Migration adds the connection
field and freezes the retired writer after checking the live policy inventory;
contract migration 0227 drops the old table after the new Hub is verified. See the
[retirement procedure](operations/connector-permission-retirement.md). Recovery
uses a CI-validated forward release preserving configured permissions, not an
old Channel-policy executor.

## Unreleased: Page comments continue the existing conversation

The Page comment box showed a live Agent but created a new conversation before
calling its existing Instance. That first message could summon another Agent.
Comments now go directly to the selected Instance's own conversation, addressed
to it with the quoted passage and a link back; bare Agent mentions also reuse
that Instance. With no live Agent, the section's latest unambiguous readable
editing conversation receives the comment. Only a comment with no existing
destination or an explicit request for another Agent starts a new discussion.
An existing destination outside the loaded catalog page is resolved through
the authorized catalog read before sending; a failure or unavailable result
reports an error instead of creating a replacement discussion.
Browser coverage checks the actual message destination and absence of Channel
creation; the existing new-discussion case covers the remaining startup path.
Beta Web only, no API, schema or native change. Recovery is a CI-validated beta
Web release reverting the change; existing conversations and messages remain.

## Unreleased: Google authorization failures retain their cause category

Google's Cloud-session reauthentication subtype was discarded, leaving the
same `invalid_grant` message as an expired or revoked authorization. Google
token requests now retain that typed distinction and identify rejected company
app credentials, using fixed text without arbitrary provider details. Refresh
scheduling, credential persistence and approval remain unchanged. Existing
OAuth boundary coverage reproduces the missing subtype on prior code and
checks refusal without retry or private-detail disclosure. Hub only, no
migration; recovery is a CI-validated beta reverting this diagnostic change.
See [Google grant expiration](operations/google-oauth-grants.md).

## Unreleased: Google Calendar connects separately

Spaces can connect Google Calendar to read calendars, search events in an
explicit time interval and check availability, then create, edit or delete an
event under the app permission (Calendar defaults to write). It uses a separate scoped
Google grant; existing Drive and other Google connections do not gain calendar
access. Approvals resolve the calendar and show the proposed event, guest
notifications and recurring-series impact. Edits/deletion retain the exact
ETag so concurrent changes fail safely; ambiguous writes are not replayed.
Enable Calendar API and consent to its scopes before native acceptance. Hub
and beta Web only, no migration; recovery uses a CI-validated beta reverting
the connector and preserves events already created in Google Calendar.

## Unreleased: The @ menu says once what each row does

Every row of the `@` menu now says one thing: what choosing it does. `auto`
is written as it is typed and says it picks an Agent by what each is good at,
which is where those descriptions are used, so the separate hint line above
the Agents is gone. An Agent with a description shows it; one without
shows **Say what it's good at** in the same place and grey, only to people
who may write it, instead of a second "Choose automatically" that collided
with `auto`. Badges that repeated the section or the row's own name (human,
app, repo, model and the like) are removed; live presence and "offline" stay.
`@co` no longer lists every App, because kind words and descriptions match
from three letters. Conditions after a summon no longer offer `auto`, use the
condition icon, and an Agent condition wears its face. Following the rule that
early screens name no Run, Instance or Harness, the live Agents section is
"In this conversation", the Agent condition reads "Agent", and instance
actions say plainly what they do. `auto` wears the Agent mark rather than a
lightning bolt. The Agents editor uses the same words in English and Chinese.
No migration or native update is needed; recovery is a CI-validated beta Web
release reverting the change.

## Unreleased: Mention keyboard checks address their trigger

The independent invocation timeline browser case presses Enter on the intended
trigger in one locator action. Its former separate focus and global key could
race the previous popup's frame-delayed initial focus, sending Enter to a close
button or the document instead. Controlled delayed-focus evidence reproduces
that misdirected key on the same deployed client; targeting the trigger passes
the original dialog/progress assertions. This changes the fixture only, with
no production behavior, timeout, tolerance or retry-policy change.

## Unreleased: The first sign-in keeps one query lifecycle

The first sign-in keeps both the open page and its QueryClient, so observers
and actions remain on the same cache without re-consuming a one-time callback.
Leaving any signed-in reader advances a separate mount generation and creates
a fresh client, including first sign-in followed by sign-out; using the word
anonymous for both keys could previously skip that reset. Returning to an
earlier account cannot revive its old mounted state. Existing pin/browser and
callback owner cases cover initial sign-in and account changes. No API, schema
or native change is needed; recovery is a CI-validated beta Web reverting it.

## Unreleased: Message catalog checks start after bootstrap refreshes

The unpaged-message browser case now installs its fixed catalog before one
navigation and drains startup's refresh window before injecting arrivals.
Previously a reconnect and the synthetic messages could share one window:
the normal full-refresh path then read the fixture's permanently old catalog
instead of exercising message promotion. The two-message count and the
shared snapshot without viewer read state keep their original assertions.
No product, API, schema, timeout, retry policy or native behavior changes.

## Unreleased: Page link editing checks start at the selected text

The Page link browser case now verifies that closing its discussion returns
focus to the editor, then moves within the selected guide to expose its link
address. Jumping to the document start and counting one visual Down key could
leave the caret in a decorated title, so the case waited for a control outside
its actual caret paragraph. Drag selection, address editing, continued writing
and unsafe-link assertions stay intact, with unchanged timeouts and retries.
This is browser setup only; no product, API, schema or native behavior changes.

## Unreleased: Message Channel lock failures retain their blocker

HUB-AZ timed out while an Agent append waited for a Channel lifecycle lock.
The event had no holder evidence, and console capture lost the database's
named-query diagnostics. The message failure boundary now explicitly reports
the original exception with that bounded evidence once. The existing slow-lock
sampler also covers Channel lifecycle admission locks, retaining waiter and
blocker owner categories, states and transaction ages before PostgreSQL removes
the wait edge. It shares the execution-report sampler's one-connection bound;
fast locks open no diagnostic connection. Lock order, authorization, public
errors, retry policy and unknown-COMMIT reconciliation are unchanged. This is
missing diagnostic coverage, not a confirmed fix for the underlying contention.
No migration; recovery uses a CI-validated beta Hub reverting this change.

## Unreleased: Query observers follow the signed-in identity

Changing the signed-in identity already creates a fresh QueryClient, but its
mounted query observers could still belong to the previous client. A screen
could therefore show an existing pin while its action read an empty current
cache and pinned it again. Key the QueryClientProvider subtree by identity so
observers and mutations move together; an unchanged identity keeps its client
and mounted state. The existing unpin browser case now changes sessions first,
then checks the empty saved pin list. Pending old-session Done responses and
rapid pin/unpin remain covered. No API, schema or native change is needed;
recovery is a CI-validated beta Web reverting this change.

## Unreleased: Channel catalog tests advance on a committed revision

The catalog-notification browser fixture no longer changes its rows after a
second read. Initial hydration or a legitimate refresh could consume that
response before the test sent its revision notification, inventing a new
Channel prematurely. Install the initial snapshot before navigation and replace
it only when simulating the commit, then send the existing notification. The
owning case now holds the old snapshot across an additional refresh and keeps
its original absent-before/present-after assertions. This changes test data
only; no product, schema, retry policy or native artifact changes.

## Unreleased: Successful stops no longer repeat their status as a message

Stops from UI controls lacked a source command, so their successful Machine
result still posted a separate system fact after inline status replaced that
feedback. Routine success now updates state alone; the Web hides historical
typed success notices too. Stop failures, failed-startup cleanup and external
causes such as access withdrawal remain explained. This ships in the Hub and
beta Web, with no data migration or native update. Stored history is preserved;
recovery is a CI-validated beta reverting this change.

## Unreleased: Spaces can store more than 128 secrets

A Space with 128 secrets refused the next credential even when it was needed
for normal work. The Hub removes that storage quota, and catalog, Run value
and approval reads also work beyond the old boundary. Reads use ordered,
bounded SQL pages and per-request byte budgets; alias listings do not fetch
encrypted values. Existing encryption, live Run authorization and admin
approval remain in force. This ships in the Hub without a schema or client
change. Recovery is a CI-validated Hub release reverting this change; keep
stored secrets intact and restore forward support for catalogs above 128
before relying on an older read implementation.

## Unreleased: Page links open with a click or tap

Bare URLs and Markdown links in an editable page now open directly in a new
tab. Before, opening them required Ctrl/⌘, leaving phone readers without that
gesture. Dragging across link text still selects it, and its visible Markdown
destination still opens the address editor. This ships in the beta Web; no
schema or native change is needed. Recovery is a CI-validated beta Web release
reverting the change.

## Unreleased: Explicit activation keeps mention details open

A mention's delayed hover-close can already be queued when Enter or a click
pins its details open. Both invocation and prose-detail cards now reject that
stale hover close after explicit activation. Escape, an outside press, focus
leaving and ordinary hover-only dismissal retain their existing behavior. A
controlled-clock browser regression reproduces the old disappearance without
changing position, timeout or retry tolerances. No API, data or native update
is needed; recovery uses a CI-validated beta Web reverting the change.

## Unreleased: Sending does not wait for summon previews

Pressing Enter or Send with an Agent mention previously waited up to six
seconds for the draft intent preview before the message appeared. Sending
now takes completed readings for the exact current draft immediately;
unfinished previews use the existing post-send intent check. Changed drafts
cannot carry an older reading. This ships in the beta Web, with no API or
data migration. Recovery is a CI-validated beta Web reverting the change.

## Unreleased: Page edits in a Channel fold to a summary with a preview

An Agent message that changed a page drew its first three changed lines in
full under the message, and clicking anywhere on it opened the page. The card
now folds by default: one line names the page, the sections changed and the
lines added and taken out (+3 −3), and two changes preview on one line each,
cut to where the words changed and leading with what the page says now.
Unfolding lists every change by section; Open page is its own button. This
ships in the beta Web; no API or data migration is needed. Recovery is a
CI-validated beta Web reverting the change.

## Unreleased: Automatic Gmail reads use the Hub's Composio key

Live receipts for automatic Gmail reads reported a failure. A stored Composio
grant holds only account ids, and the Hub adds its project key per call; the
notification worker read without it. The automatic read now adds the key the
same way, and a Hub without one fails the read and names Composio. This ships in the Hub.

## Unreleased: Automatic Gmail reads now reach the Channel

The first release of automatic Gmail reads posted no receipt: each one replied
to the notification, and an App's message cannot be a reply target, so the
append was refused. The receipt now follows its notification, and a refused
receipt is logged by failure kind without mail content. This ships in the Hub.
## Unreleased: Share says who reads a page and who changes it

A page's Share now opens just under its button as one glass pane. "Who can
read" names everyone in the Space, with the page's own link beside them, and
"Anyone with the link" as a switch; once a page is public, its public link
stands under that switch with its own Copy. "Who changes it" holds the
Agents-only-suggest and Space-rules switches. Copying confirms on the button,
and a switch that fails says why beneath itself instead of behind the
dialog. Before, Copy link only ever gave the in-app link, and a failed
suggest-only change said nothing. This ships in the beta Web; no API or data
migration is needed. Recovery is a CI-validated beta Web reverting the change.

## Unreleased: New Gmail messages arrive already read

When a new message reaches a mailbox with notifications on, the Gmail
connector now reads it itself, as the mailbox owner, and answers the
notification with a private Gmail read receipt. The owner sees the message
right there in the Web; everyone else in the Channel, and every Agent, sees
only the mask, and Agents read a message with their own `@gmail:read` as
before. Reads also report Gmail's own SPF/DKIM/DMARC results, so a forged
sender is visible. A failed read never holds back the notification, and after
30 messages in an hour a mailbox's notifications skip the read. This ships in
the Hub; no migration is needed. Recovery is a CI-validated Hub reverting the change.

## Unreleased: An App's page leads with the one thing to do

Every App's page is rebuilt around one lead. Its name, what it does and one
status line come first. When the reader has something to do (connect,
reconnect, fix a broken connection) that one step is a tinted sheet with the
page's only solid action; a credentials-only app shows its form there instead
of below twenty command descriptions. A working app shows no call to action.
Below come what it reaches (accounts, mailboxes, logins, groups), the command
that subscribes a channel, recent activity, permissions (its defaults in one
sentence, then each channel rule), settings, the command reference folded,
and Disconnect last. Every part uses the same rows, quiet actions and "add"
row. The Apps list groups what needs attention, what is connected and what
was disconnected, then every other app once under its category.

## Unreleased: Native scrolling stays free while older history settles

After an older history page loads, a layout callback no longer consumes a
wheel or other pending scroll before the browser has moved the timeline.
That race could mistake the subsequent movement for layout drift and pull
the reader back in either direction. The anchor keeps waiting for movement;
its own corrections and compensated virtualizer changes update the pending
baseline without claiming reader input. Existing quiet and maximum lifetimes
still apply. This ships in the beta Web; no API or data migration is needed.
Recovery is a CI-validated beta Web reverting the change.

## Unreleased: Shared pages read as the page does in the app

A published page (`/p/…`) is set with the live editor's styles on the app's
paper: headings, lists and tables come out formatted instead of bare text. A
thin bar carries where the page sits and the xMatrix mark; the title stands
large, with the faces of who keeps the page current and when it last changed
under it; the page's sections are rules at the right edge. In the app and on a
shared page, tables drop their cell grid for hairline rows, columns fit their
content and short cells keep to one line, and a page's reminders read as their
names in ink instead of sky-blue pills. Web only; recovery is a beta Web
reverting this change.

## Unreleased: The iOS swipe back shows its parent once

An iPhone edge swipe now reveals the parent screen directly. The Web page
commits Back synchronously under UIKit's moving snapshot, without starting a
second Web animation of the outgoing conversation. This fixes the appearance
of returning to the current conversation before reaching its channel list.
The existing iOS bridge is unchanged, so the fix reaches current TestFlight
apps through the beta Web; no new native build or migration is required.
Chevron, Android and browser Back keep their Web transitions. Recovery is a
new beta Web reverting this change.

## Unreleased: The iOS swipe back follows the finger again

On iPhone, dragging from the left edge moves the screen with the finger again.
Let go far or fast enough and the screen goes Back to its parent (a
conversation to its channel list, a page to the page list) and slides off;
short of that it settles back. #1027 had replaced WebKit's history swipe with
one that acted only on release and waited behind the page's own scrolling, so
the gesture felt gone. Back still never walks browser history. This ships in
the iOS app (TestFlight); Web and Android are unchanged. Recovery is a new
iOS build reverting this change.

## Unreleased: Machine registry rejections retain their cause

The daemon socket keeps the exact registry fence and legacy compatibility,
but reports a rejected snapshot or successful spawn with a fixed reason,
full/partial snapshot category, advertised capability and bounded client
version. Sentry retains the originating stack and its issue reader exposes
those fields without report payloads, identities, leases or raw epoch/sequence
values. HUB-AX's generic console event could not distinguish stale evidence
from missing or malformed fields; the next event can. This is diagnostic
coverage, not a confirmed repair of its underlying cause. No schema or client
update is needed. Recovery uses a CI-validated beta Hub reverting this change.

## Unreleased: History anchoring regressions fail on the first attempt

The history-prepend reading-position spec overrides shared CI retries and runs
each case once. Frames are read in a task posted after animation-frame work,
without installing a ResizeObserver that changes layout delivery order. Both
scroll directions are covered, and raw frame coordinates are attached to the
result. The downward case stays short of the finite tail and verifies that it
has room to move. A measured jump cannot become a successful stable gate by
passing a retry. Position tolerances and CPU throttling are unchanged; unrelated
Web specs retain their existing retry policy. This tightens the existing test gate
without changing deployment, signing or publication authority. A known reading
regression is repaired on main and verified in a new beta before another stable
request; runner setup failures retain the existing failed-job recovery path.

## Unreleased: Archive the nested Desktop publisher

Archive Release Assets recognizes the exact historical and nested Desktop
publisher names, as it already does for Android. The nested publisher's successful
job previously failed the archive's component proof despite a complete scoped
production receipt. Both names appearing together remain ambiguous and fail;
missing CLI, unrelated jobs, wrong source/attempt/scope and incomplete receipts
remain rejected. This only repairs mirroring of sealed R2 artifacts to GitHub;
deployment, signing and channel publication are unchanged. Migration uses the
existing workflow, and recovery reruns that archive for the same successful
production SHA, run, attempt and scope without rebuilding or moving tags.

## Unreleased: Apple sign-in failures retain native diagnostic evidence

Apple authorization failures keep up to three native error-domain categories
and codes, plus the app version, build and iOS version, across the string-based
iOS bridge. Unknown domains become `other`; descriptions, userInfo values,
account details and tokens are excluded. The Web captures the native call's
source-mapped boundary before exchanging a token with the Hub. Older shells
still supply their existing error text; older Webs accept the diagnostic string.
Cancellation remains silent and authorization is never automatically replayed.
This supplies missing evidence for XMATRIX-WEB-S's unknown Apple error 1000;
it does not establish or fix the underlying authorization failure. No schema
migration is needed. The native diagnostics require the new TestFlight build;
recovery uses a CI-validated beta Web/iOS release reverting this change.

## Unreleased: Keep history anchoring until scrolling and layout settle

An older history page keeps the reader's place while the virtualizer measures
it. The quiet timer now follows scrolling and layout activity, including
measurements that need no correction, instead of treating stable text as a
settled list. Margin/padding swaps that move text without resizing a border box
are also corrected. Pending input movement is credited before those corrections
even when the browser has not delivered its scroll event yet, so anchoring does
not cancel the reader's scroll. The existing quiet-release and ten-second
deadline remain bounded; iPhone momentum still releases the anchor instead of
writing a scroll. No protocol or schema change is needed. Recovery is a
CI-validated beta Web reverting this fix.

## Unreleased: Installer progress emits complete UTF-8 characters

The Unix download bar repeats full Unicode strings rather than passing them
through byte-oriented `tr`. Its spinner indexes complete symbols in a Bash
array, so even a C locale cannot split a multibyte character. This keeps
terminal output and captured install logs valid UTF-8 for both known and
unknown content lengths. Download integrity and installation behavior are
unchanged; a CI-validated beta Web reverting this change is the recovery path.

## Unreleased: Delayed components validate their frozen release

CLI, Desktop, Android and iOS component jobs verify consistent manifests, the
remote annotated tag and its exact SHA, then the clean checkout's tag/version
and main-history or version-stamp proof. The train still enforces ascending
versions when it cuts a new tag, and component channel pointers still move
only forward. A later parallel Hub tag is not a new version floor for a
component that was already authorized.

In 1.11.2-beta.12, Desktop started after CLI publication and a Hub-only beta.13
had been tagged. Its late global version-order check rejected that frozen
release before Desktop published, although Web and CLI had succeeded.
Migration uses the same release workflows with the shared corrected check;
there is no new deployment, signing or authorization path. Immutable old
tags remain untouched. Recovery is a new CI-validated beta containing this
fix and the failed beta's intents; retrying its old immutable script cannot
repair the check. The real-Git regression reproduces that failure and keeps
new-cut downgrades, wrong remote SHAs, tag/version mismatches and dirty
checkouts rejected.

## Unreleased: Starting two-step sign-in over abandons the old app handoff

After signing out, the two-step page replaces the document with the cleaned
sign-in URL before showing another email form. Previously the form could
appear while client navigation still retained the old app continuation.
Other account switches keep their existing request destination. No schema or
native bridge change is needed; recovery is a CI-validated beta Web reverting
the change. The existing browser regression protects the transition.

## Unreleased: Keep standalone Agent launch context within its budget

The shared bootstrap and Channel reporting text uses shorter wording while
retaining identity, access, approach, progress, final-reply and working-mode
requirements. This restores the existing 9,000-byte standalone/old-Hub launch
budget without raising its limit or weakening the contract. Hub-delivered
launches and the CLI's compiled fallback share the same text; no protocol or
schema migration is needed. Recovery is a CI-validated beta reverting the text.

## Unreleased: Binary-only installation and Agent setup boundaries

The Unix and PowerShell installers can install an integrity-verified binary
without changing shell PATH, sign-in, daemon services, tasks or processes.
Use `--binary-only`, `-BinaryOnly` or `XMATRIX_INSTALL_BINARY_ONLY=1`; connection
setup is rejected in this mode. Default interactive installation is unchanged.

Agent Runs now refuse `setup daemon` and `setup install --daemon` before
Profile admission or installation, matching the existing Human-only Profile
registry and DaemonHost-start boundary. The owner completes connection setup
in their terminal; a Run cannot use installation setup to change its own
identity. No schema migration is needed. Recovery uses a CI-validated beta
reverting this change. See [local connection Profiles](operations/local-connection-profiles.md).

## Unreleased: A page's @ to a live Instance says which one and how the call goes

Calling a live Instance with `@` on a page now writes the conversation it was
called in beside its name, so another Instance of the same name (each
conversation has its own `grok:1`) no longer takes it as its own and answers
twice. The `@` menu names each Instance's conversation and marks busy ones,
listing free ones first. On the page the call is one chip, `@grok:1 # Daily
costs`, with the Instance's live presence for every reader. The caller's chip
follows the call: Sent, Queued while the Instance finishes something else,
Working with its time, then Replied (opening the reply), Done or Failed. The
Agent bootstrap says an `@` naming another conversation is not addressed to it.

This is a Web change plus a CLI bootstrap line; older CLIs still receive the
call correctly but lack the hint. No Hub or data migration. Recovery is a
CI-validated beta Web and CLI release reverting the change.

## Unreleased: Agent controls follow native capability data

Claude controls now derive models and effort choices only from native
initialize data. Discovery merges the built-in effort command's declared
workflow modes with each model's own reasoning levels, so Ultracode and
future modes using that grammar are selectable without a per-name patch.
The static alias/effort fallback is removed. Missing discovery leaves controls
unavailable while ordinary work may continue; explicit parameter requests
still fail. Native command inventories, including empty ACP inventories and
Claude overlays, also prevent documentation lists from restoring absent
passthrough commands. That precedence applies before the first discovery as
well, through one shared merge for session controls and presence. Fixed
protocol bindings remain separate from choices.

This needs a CLI/daemon release and restart or reborn of existing Instances;
no Hub, Web or data migration is needed. Older harnesses without native
catalogs lose guessed controls. Recovery uses a CI-validated CLI beta
reverting the change. See the [capability audit](operations/provider-capability-audit.md).

## Unreleased: A release train records the gates it passed

Production Release Request now writes the full-tier CI jobs it passed into
the content ledger, under the tree those jobs tested. The recorder accepts
that workflow only from the default branch, and only a commit the dispatch
SHA may ship: the SHA itself, its beta version stamp, or a stable stamp of a
source that SHA contains. The recorder identifies that request by its workflow
path: the request's run-name replaces `workflow_run.name` with the train
title. The stamp check is the same one the gate runs
before it checks the release commit out. Manual Public Snapshot CI still
does not record. A later train of the same tree skips gates this run already
passed; if the ledger is missing, those gates run in full.

## Unreleased: Bounded body reads reject without waiting for cleanup

Oversized authentication and connector bodies no longer wait for upstream
cancellation to finish before returning their existing error. A cloned stream
can otherwise wait for another reader indefinitely. Authentication/request,
connector, harness registry and Apple JSON readers now use the same protocol
collector; limits and domain errors remain with their owners, and existing
request/deadline signals also cover body reads. Reader locks always release.
No schema, client or UI change is required. Recovery is a CI-validated beta Hub
release reverting the change.

## Unreleased: Exhausted database recovery retains session progress

Feishu lifecycle cleanup already retries a lost pre-COMMIT response once on a
fresh session. HUB-AV lost the cleanup SQL response and then the new BEGIN
response; its event could not show the rest of either session's progress.
Failures now retain bounded stage durations and attempted query/round-trip
counts, and Sentry issue reads display them beside the failure. Old events
remain readable. No SQL, parameters, identities or driver messages are added,
and no extra queries, retries or COMMIT replays are introduced. This diagnoses
repeated loss; it does not establish or fix its underlying transport cause.
No migration or client update is needed. Recovery uses a CI-validated beta Hub
release reverting the change.

## Unreleased: Auth public-key reads recover a lost database response

JWT verification loads public keys with one independent `single_read`, avoiding
the unnecessary BEGIN that failed for HUB-AT. A lost response retries once on
a fresh connection; repeated loss and answered database errors still surface
as failures, distinct from unknown keys. Adjacent independent Auth directory,
profile, session, handle and OAuth application reads use the same recovery.
Signature, issuer, audience, expiry and revocation checks remain in force;
Auth writes and the multi-query admin detail retain their transactions.
No migration or client update is needed. Recovery is a CI-validated beta Hub
release reverting this change; the underlying transport stall is unassigned.

## Unreleased: Page section awareness recovers lost database reads

Page section awareness and the adjacent blame reader use independent
`single_read` statements for access checks, revision metadata and bodies. A
lost response retries once on a fresh connection; repeated loss and answered
database errors still propagate. This closes HUB-AS's unnecessary BEGIN
timeout path without attributing the underlying transport stall. Placement
fences, page access checks, comparison outside the checkout, and purge-safe
transactional cache writes remain in force. No migration or client update is
needed. Recovery is a CI-validated beta Hub release reverting this change.

## Unreleased: A GitHub App merge no longer speaks its bot login

A pull request subscription tells its conversation when someone else merges
or closes it. The GitHub App's own bot used to post
`xmatrix-connector[bot] merged pull request <link>: <title>` directly under
the merge receipt, restating that card in GitHub's notification voice. That
line is now `Merged <link>: <title>`, or `Closed <link>: <title>` when it was
not merged. A person's merge still names them. No migration or client update.
Recovery is a CI-validated beta Hub release reverting the change.

## Unreleased: The mention menu says an agent's strengths can be written

Typing `@` already shows the first sentence of what a harness is for. The Agent
list now says that text can be written, and each harness has a control that
opens its When to pick it editor with the caret in the text. Those words
follow the person's language, English or Chinese. This is a Web change with
no schema or client migration. Recovery is a CI-validated beta Web release
reverting the change.

## Unreleased: Channel detail reads recover lost database responses

Channel details, including the access check for connector approval lists, now
use independent single reads for the authorized Channel, Instance presence and
visible Human members. Each statement keeps its placement fence and retries a
lost response once on a fresh connection; answered failures still propagate.
This removes the unnecessary BEGIN/COMMIT that exposed HUB-AR to a transaction
opening timeout. As in the catalog, these reads have individual snapshots;
mutations retain their transaction contracts. The real PostgreSQL regression
suite now runs the existing catalog read recovery file as well.
No migration or client update is needed. Recovery is a CI-validated beta Hub
release reverting the change; the underlying transport stall remains unassigned.

## Unreleased: Registration quota reads recover a lost database response

Channel quota projections and owner quota refreshes use one independent
`single_read` rather than opening a transaction for their lock-free SELECT.
A lost response retries once on a fresh connection; a second failure still
surfaces. This closes HUB-AQ's recovery gap without attributing the underlying
transport stall. Authorization, quota freshness and observation writes are
unchanged. No migration or client update is needed. Recovery is a CI-validated
beta Hub release reverting the change.

## Unreleased: Migration regressions execute in the PostgreSQL release gate

The Hub release suite now runs the index drift, Machine query plan and online
migration recovery regressions against its isolated PostgreSQL database.
Ordinary Node checks skip database integrations, and these files were missing
from the real database suite's explicit list. This completes the regression
gate for migration 0220; it needs no new production migration. Release and
recovery still use the existing CI-validated beta train.

## Unreleased: Daemon reports and reconnects use their Machine indexes again

Migration 0137 retired `host_id`, and PostgreSQL dropped the two indexes that
contained it. Since then every daemon report scanned all Machine Run routes
and every reconnect scanned all Launches. Expand migration 0220 rebuilds both
concurrently without the column, during the release's normal migration step;
no query, behavior or client changes. A new schema test fails whenever an
index disappears without a migration naming it. Recovery is a CI-validated
beta release; the indexes are inert to older Hubs and need no rollback.

## Unreleased: Channel replies explain the work and wait for presence

The shared Agent reporting contract keeps material findings and decisions in
separate Channel replies, explaining the cause and chosen fix. Routine status
edits keep the approach visible; Codex's compact reminder explicitly says
local commentary does not reach the Channel. This is guidance for new Runs,
not automatic publication of runtime output or a guarantee of model compliance.
Hub deployment supplies the updated text; existing Runs retain their launch
instructions and older daemons retain their compiled fallback.

Message headers no longer declare an Instance offline while the Channel's
presence snapshot is unavailable. An authoritative empty snapshot still
marks a departed sender offline. This is a hosted Web fix with no schema or
native migration. Recovery is a CI-validated beta Hub/Web release reverting
these changes.

## Unreleased: Failed turns show their actual cause and exhausted quota

Turn-failure cards use the program's original error as their title for every
cause, including unknown failures and historical notices. The error passes
through without requiring a category-specific title. The Hub projects
its existing used-up-account classification into additive failure evidence;
the Web uses it for English/Chinese reset-or-handoff steps instead of immediate
retry advice, without replacing the original error. Structured reset times display in UTC;
prose-only reset hints remain as written. HTTP rate limiting stays distinct,
and the existing quota hold and automatic handoff are unchanged.
This needs a beta Hub/Web release, no native update or data migration. Older
clients ignore the added field. Recovery is a CI-validated beta reverting the change.

## Unreleased: Unaddressed evidence commits with its publication

The Human message append now records recipient absence inside its existing
transaction and Channel lock. Post-commit only publishes state: an Agent that
exits after receiving the message cannot turn that delivery into an unaddressed
action. A lost post-commit no longer loses a named/later message's witness.
Expand migration 0222 adds a nullable commit witness flag; prior observations
stay unknown and cannot authorize new choices. Imported history is excluded.
No Web or native update is needed. Recovery uses a CI-validated beta Hub release;
keep the additive flag and never backfill it from current Instance state.

## Unreleased: Unaddressed messages have an explicit Agent choice

Human speech that the Hub positively confirms has no recipient gets a choice
under its original message, including named conversations, later messages and
the welcome conversation. Connecting a computer or reopening the UI does not
launch it. The author explicitly selects an Agent; this claims the existing
per-message launch decision and durable summon lane. Missing tracking remains
unknown. Existing execution failures retain their current notices.

Expand migration 0221 adds unaddressed publication evidence and optional source
snapshots to launch choices. Source edit/recall/delete, current permissions and
Channel stop fence late admission. The invocation response adds optional `asks`;
older clients ignore it and keep the legacy connection reply, whose instructions
mention the Agent with the question so untracked history also has a working path. No native update
is required. Rollback uses a CI-validated beta Hub/Web release reverting the
code; additive schema can remain. See [message asks](architecture/message-asks.md).

## Unreleased: Machine reports and enrollment recover a lost database response

Machine daemon commands, Run lifecycle mutations and execution report storage
retry once in a fresh database session after a connection loss before COMMIT.
The failed session closes first, and locks and authority checks run again;
socket wakes, route publication and notices remain outside the replay.
Unknown COMMIT results keep their existing receipt reconciliation. This fixes
HUB-AN/AP's recovery gap without claiming the transport stall is diagnosed.
Page search also uses independent single reads with the existing membership,
page access and placement checks, recovering HUB-99's lost response without
an unnecessary transaction opening.
No migration or client update is needed. Recovery is a CI-validated beta
release reverting this change.

## Unreleased: Page conversations are easier to find

The page margin uses one quiet line at each edge for conversations above and
below, with an explicit unread count. Its cards stay clear of those lines.
The position rail marks live conversations at their document anchors, turns
unread marks red and outlines the current viewport; clicking a mark jumps
to that passage. The toolbar comment count opens the existing conversation
list with All / Open / Resolved filters, including on phones. This is a Web
change with no data migration. Recovery is a CI-validated beta Web release
reverting the change.

## Unreleased: Page references stay readable in compact previews

Co-writing notices in page margin cards, conversation rows and other compact
previews display current Page titles instead of `page:<id>` locators. Missing
context, unavailable references and truncated locators use generic labels;
message reference chips also stop falling back to raw IDs. References to an
unnamed Channel use a generic label rather than a fragment of its ID. A Web lint rule
rejects direct Page ID text/labels and DOM text assignments, including local
aliases and string formatting. Dynamic preview contents pass through the shared
reference renderer. Routing, stored messages and Agent instructions are unchanged.
This is a hosted Web fix with no data or native migration. Recovery is a
CI-validated beta Web release reverting the change.

## Unreleased: Billing reads recover a lost database response

Billing summaries, including the plan check used by search reranking and Jev
admission, now use independent single reads with the existing Space placement
fence and membership check. A lost response gets one fresh connection attempt;
exhausted recovery still surfaces the database failure. The read no longer
waits for an unnecessary BEGIN or COMMIT. Billing mutations keep their existing
transaction and reconciliation behavior. This repairs HUB-AM's recovery gap,
without claiming the underlying transport stall is diagnosed. No migration is
needed; recovery is a CI-validated beta reverting this change.

## Unreleased: Workspace refresh rejections identify the receiving build

Rejected workspace refreshes retain a fixed validation stage, a known resource
kind and the receiving Worker version in the publisher's existing error report.
They never echo event contents or identities. This distinguishes protocol
rejection from envelope, watermark and recipient failures for HUB-AK; its
original rejection is not reproduced and remains under investigation. Valid
refresh delivery and rejection behavior are unchanged. Recovery is a
CI-validated beta release reverting these diagnostics; no migration is needed.

## Unreleased: Escape closes the focused attachment preview

Markdown and video previews close on Escape even when their own controls have
focus. Their container still keeps keyboard events out of the conversation.
An image opened inside Markdown closes first; a second Escape closes the
Markdown preview. This is a hosted Web fix with no data or native migration.

## Unreleased: Repository completion loads once per Space

Entering a Space preloads its launch candidates once and shares the result
across composers and repeated `@` picks. There is no repository polling timer.
GitHub connection changes and signed repository/installation events invalidate
the affected Space's query; socket reconnection recovers missed notifications.
GitHub catalog events advance the connection version used by edge caches, so
an older regional cache write cannot undo an invalidation. Reconfirming an
existing installation also advances that version, even when its linker stays
the same. Existing clients
ignore the new resource notification; the hosted beta Web consumes it.

Cold catalog reads avoid redundant personal-owner permission requests using
GitHub's current stable owner id, and keep eight permission workers occupied
without batch barriers. The actual repository credential mint retains its live
permission checks. App webhook subscriptions determine which provider changes
arrive; missed events may leave suggestions stale until reconnect or Retry.
No schema migration is needed. Recovery is a CI-validated beta release reverting
the change; candidate queries then return to loading on completion.

## Unreleased: A remembered session cannot skip a login's second factor

An app's provider sign-in that asks for an authenticator or backup code stays
on that step until this visit verifies it, even when the sign-in browser already
has a website session. The same pending step holds webpage redirects and device
approval. Starting over abandons that app handoff and signs out before offering
another login. Successful login handlers now feed one signed-in exit, preserving
the app's finish address and a new account's welcome path without competing
navigations.

This is a hosted Web change; no native shell or CLI update is needed. Recovery
uses a CI-validated beta Web release reverting the change and restores the
previous remembered-session behavior; there is no data migration.

## Unreleased: Search timeouts retain recovery diagnostics

The common Hub PostgreSQL outage response reports the original exception and
both failed database attempts in one Sentry event. Failed message searches add
filter categories and pagination progress, without search text, cursor values,
identities or SQL. The issue reader exposes this bounded evidence so repeated
slow queries can be distinguished from transport stalls. Recovery remains one
fresh connection attempt and exhausted requests remain retryable HTTP 503s.
This adds diagnostics; the cause of HUB-AG's two read timeouts is not yet known.

## Unreleased: Authentication request bodies are bounded before validation

The Hub refuses authentication bodies larger than 64 KiB with HTTP 413 and
`request_too_large`, before JSON decoding or Better Auth schema validation.
It counts actual streamed bytes and cancels oversized input, even with a
misleading Content-Length. Login, passkey and OAuth requests within that bound
keep their existing formats; attachment uploads retain their separate limit.
This mitigates oversized unbounded collections in the current authentication
schemas; a Zod version bump alone does not bound those collections.
Rollback is a beta release of a CI-validated revision reverting this limit;
it reopens the larger validation-input boundary and needs no data migration.

## Unreleased: CLI resource limits compile across supported Rust versions

The acknowledged Page-output queue and live trace-read limit share a checked
atomic reservation loop. This preserves their capacity limits on both Rust
1.96 and current stable Rust, where `fetch_update` was renamed. Recover the
failed beta.6 CLI build through a new CI-validated main revision and Release
Intent; its immutable tag and already deployed Hub/Web stay unchanged.

## Unreleased: The Hub writes each message an Agent reads

Each Channel message an Agent receives now comes with the Hub's rendering of
it: the header with its Channel, ids, delivery time and sender, the message it
replies to, its body and attachments. The runtime uses that text as the turn
and adds only where it saved attachments on the machine, so the wording of a
turn changes with a Hub deploy. Older CLIs, and terminal (PTY) harnesses, still
write the message themselves.

## Unreleased: The Hub handles streamed page writing

Page-writing markers in conversation replies and answers to “write together”
now use one acknowledged output path. The Host forwards assistant text and
resolves local attachment references; the Hub interprets writing instructions,
checks current Page access and confirms text only after applying it. A lost
reply can be retried without writing twice, and rate-limited text stays on the
Host until the Page accepts it. Human edits, undo and suggestion-only policy
keep their existing Page semantics. Cancelled or disconnected answers cannot
be adopted by a new co-writing session. Unclassified Codex raw events remain
diagnostics and cannot enter this writing path.

This needs the new CLI once. After that, Page parsing and writing policy can
change with a Hub deploy. Older Hubs keep the previous transport. If a live
writer's state is lost, the runtime reports an unconfirmed write and stops that
output instead of replaying the model's task. This does not promise exactly-once
model execution or a fixed model response time; first visible text is measured
separately in the end-to-end release verification.

## Unreleased: Some xmatrix commands now come from the Hub

`xmatrix automation …` is now defined by the Hub: the CLI passes the command
line on and prints the answer, so its options, help and output change with a
Hub deploy. `xmatrix commands` lists every command defined this way, and
`xmatrix --help` points to it. The commands behave as before. Commands that
work on the machine itself stay in the CLI. This needs the new CLI once; older
CLIs keep their built-in `automation` command.

## Unreleased: Machines take the harness list from the Hub

The list of supported harnesses, with how to find, install, update and sign in
to each, now comes from the Hub when a Machine connects, instead of only from
the copy built into its CLI. Adding a harness that speaks a protocol xMatrix
already supports, or fixing an install command, reaches every Machine with a
Hub deploy. A Machine resends nothing when its list is already current. This
needs the new CLI once; older CLIs keep their built-in list.

## Unreleased: Official runtime texts can change with the Hub

The Hub can now send the runtime further official texts by name, beside the
launch prompts it already sends. The words a resumed session starts with are
the first: they are now edited in the repository and reach the next Run with a
Hub deploy. Moving another fixed runtime text this way needs no protocol
change. This needs the new CLI once; older CLIs keep their built-in copies.

## Unreleased: The Hub writes what a new Agent reads first

The conversation a newly launched Agent reads before its first turn is now
chosen and worded by the Hub in one request. Changing that text, its order or
its size limit no longer needs every Machine to update its CLI. Long
conversations read only their newest part instead of every message, and the
conversation's About is fetched only when the transcript had to be cut, which
removes a directory read from most launches. This needs the new CLI once; older
CLIs keep reading history as before.

## Unreleased: Live updates reach each person in their own Runtime cell

Every product socket has lived in its owner's own Runtime cell since 1.0.0, but
deliveries were still routed through a directory that listed a person's cell
only for the conversation they were viewing. A Space's catalog changes and
workspace lists went to a cell that held no socket at all, and a message in a
conversation nobody was viewing reached only the owners of its live Agents. A
new conversation therefore appeared in its creator's list only once an Agent
replied.

- **Addressing.** The authority names who a delivery is for as it commits it:
  the people who may read it and, for a message, the owners of the Channel's
  active Runs. The publisher sends each of their cells one request saying what
  that cell serves, within a bounded budget, and serves its own cell locally.
  An Agent receives a message once however many people read the Channel.
- **Admission.** A cell admits only its owner's sockets. A connect is checked
  as soon as its credential names the account, before it claims, counts or
  announces anything, and a socket back from hibernation before it is restored.
  A socket that names no owner is told to upgrade.
- **Presence.** An Agent's status report asks who may read the Channel at every
  report; a remembered audience no longer decides. A Channel snapshot built from
  Agent presence says it speaks for the Agents alone (`presenceCoverage`), and
  only clients that declare `presence_coverage_v1` receive it. A person who
  opens a Channel is sent each of its Agents' cards as they are now (branch,
  goal, model catalog, commands, offline while its machine is), read from the
  cells that hold them; before, only the owner's own Agents were shown this way.
- **Web.** A resolve asked after a message or a create never takes the answer
  of one asked before it, and a conversation joins its creator's list as soon as
  the Hub confirms it.
- **Retired.** The Runtime route directory and Channel fanout objects stay
  bound as 410 shells, and `XMATRIX_RUNTIME_CELL_MODE` is gone.

## Unreleased: Co-writing starts with the document

A newly launched page co-writer receives the current document and its writing
protocol in the same first model turn as the invitation. Its words stream
straight into that page, avoiding a separate ordinary task that could spend
minutes reading commands or waiting for the person to stop typing while the
live request queued behind it. The original message and execution attribution
remain. A ten-second startup deadline preserves late requests through the
ordinary run loop. This is a CLI update for every harness; the Hub protocol
and older runtime behavior are unchanged.

## Unreleased: Pages have no claims and no owed updates

Coordination on pages is lock-free, so nothing on a page is claimed and no
section owes an update. `xmatrix page claim`, `claims`, `release` and `done`
are gone, with the Hub routes behind them, the competition setting, the notice
that names others on the same section, the GitHub write-back request on a
merge and the `owed` Automation trigger. `xmatrix page read` shows who is on
each section and which Agents work in its conversations, and the Run whose
work changes a page writes it back. A member's pull request that names a
section is still pre-reviewed there, and a merged one still makes its
participant author a contributor. The unused Space action claims API
(`/api/spaces/:spaceId/claims`) is removed as well.

Compatibility: the stable Web reads a section's `owed` only when it is present
and never reads `claims`, so it keeps working against this Hub. A CLI released
before this change reads page awareness without `claims` and `owed`, which
default when missing. Its `page claim`, `claims`, `release` and `done` reach
routes that answer 410 `page_claims_removed`, saying there is nothing to claim,
release or settle. Those routes stay until the stable CLI carries this change.
The GitHub App publishes no `xmatrix/claim` check; a repository that still
lists it among its required checks should drop it, or its pull requests wait
on a check that never arrives.

Migration evidence: contract migration `0215_contract_drop_page_claims` drops
`data.page_claims`, `data.page_block_competitions` and
`data.space_action_claims`, once the deployed Hub no longer names them (the
contract-readers gate checks it). Between that deploy and the drop the Space
and Conversation purges leave their rows, and the drop takes them. The one
Automation with an `owed` trigger was edited before the release, so no stored
trigger names it.

## Unreleased: Releases deploy concurrently by component dependency

Production Releases deploy side by side unless one has to wait for another
(`scripts/release-dependencies.mjs`). This replaces the two fixed lanes (service
and clients) of the previous change. A release waits for an active one when it
ships a component that release also ships, or when that release ships a
component it depends on. One component deploys in version order, because a later
deploy that finished first would be overwritten and channel pointers only move
forward. The dependencies are:

- the Web, CLI, Desktop, Android and iOS depend on the Hub: the Web is built for
  its train's Hub, and a client is admitted by that Hub and published against it;
- the Desktop, Android and iOS apps also depend on the Web: they are shells
  around the live Web of their channel and publish after it, as they do inside
  one release (client-readiness);
- Desktop also depends on the CLI, which it bundles.

Everything else runs at once: a Web beside a CLI, Android beside iOS, a Hub
beside any client. From 2026-10-22 to 2026-10-24, 17 of 92 Hub- or Web-only
release requests waited behind a 13–16 minute client release, 231 minutes in
total.

- **Dispatch.** A train still runs one at a time and still waits before tagging,
  but only for the active releases its scope waits for, and for any PostgreSQL
  contract migration or lifecycle cleanup, as before. Each release's scope is
  read from its tag annotation, and one that cannot be read waits and is waited
  for. GitHub can keep serving one response for one URL, even across trains, so
  every read of the run lists now names a new URL. A list frozen before the
  previous train dispatched would otherwise show no earlier release, and this
  release would deploy beside it.
- **Planning.** A beta train that ships an intent waiting for an active release
  holds the train until that release finishes: its gates run meanwhile, but no
  later train can plan. It does so only when that release is expected to finish
  within eight minutes, judged from each component's recent p90 duration and how
  long the release has run. An intent behind a longer release stays open, and
  that release wakes the train when it finishes (Release Train Next). Planning
  reads each run the list shows running again by its ID. A stale "running"
  would leave such intents open after the release that would wake the train had
  already finished.
- **Concurrency.** A release holds the group of its first component in
  dependency order: `production-release-train` for every release with the Hub,
  then `production-release-web`, `-cli`, `-android`, `-ios`. Two releases share
  a group only when they share that component, so each waits for the other and
  the train never dispatches them side by side; the group backs that wait up.
  A test evaluates the workflow's group for every pair of scopes against the
  rule. Run names carry the tag and scope.

Migration evidence: releases dispatched from earlier tags keep the group they
were dispatched with (`production-release-train`, or `production-release-clients`
for a client-only release). A new release that the train dispatches beside one
of them either holds another group, or shares `production-release-train` with an
earlier service release that it does not wait for; there it waits pending, as
every release did before, and no second release can join that wait.
Publication order is unchanged for each component. A release published after a
newer one of other components keeps its own preflight and its notes baseline,
which is the highest published version below it.

Recovery evidence: Production Release Recovery applies only to the
preflight-success/PostgreSQL-readiness-waiting shape, which only a Hub release
has. Every Hub release holds `production-release-train`, the group the recovery
`unlock` job acquires, so the proof and the unlock are unchanged. A release
without the Hub never takes that shape. A failed one is recovered as before, by
re-running its failed jobs. A release without the Hub that hangs before its first
mutation still holds back the releases that wait for it until their three-hour
dispatch deadline, as before.

## Unreleased: Retry transient CI ledger evidence reads

The CI ledger now shares the release train's bounded GitHub read transport:
network errors and HTTP 5xx receive at most five attempts, with a ten-second
deadline per attempt and increasing backoff. The deadline also covers JSON
and artifact bodies. Client errors and malformed JSON still fail closed;
only the original verified run, tested commit and successful jobs can earn
ledger entries. An unavailable ledger still makes later gates run in full.

Hub releases apply and read back an exact-host `/mcp` Browser Integrity Check
exception with the existing protected deployment credential, then require an
anonymous Python-style client to reach the Hub's 401 OAuth challenge. Other
security products and paths remain protected. Creation, retry and retirement
are documented in [MCP edge compatibility](design/mcp-server.md#cloudflare-edge-compatibility).

Exact-tag PostgreSQL expand migrations support bounded concurrent index builds
with durable, checksum-bound name reservations and the existing migration
ledger. Interrupted builds recover only their own indexes; unknown names and
changed definitions fail closed. See [online index migrations](operations/postgres-online-index-migrations.md).

xMatrix has one global source version. The root `version.json` file is the canonical
version source for a release train. An on-demand train publishes only its
selected components; existing versions of other components remain live and the
receipt records the exact scope. Keep source
manifests synchronized with:

```bash
pnpm version:check
```

A release no longer needs a version change on `main`. The Production Release
Request stamps the requested version onto the frozen `main` SHA as a single
release commit (`scripts/release-commit.mjs`): every manifest carries that
version in the released artifacts, and `main`'s own `version.json` may lag the
newest tag. `pnpm version:set <version>` (which updates `version.json` first and
syncs the package manifests, Rust crate metadata, and native release metadata)
is what the request runs; use it on a branch only to make local builds report a
specific version.

## Beta and stable channels

A release is a beta `X.Y.Z-beta.N` or a stable `X.Y.Z`, and the version alone
decides its channel (`releaseChannel` in `scripts/release-version-order.mjs`).
All releases form one ascending SemVer line:
`X.Y.Z-beta.1 < … < X.Y.Z-beta.N < X.Y.Z < X.Y.(Z+1)-beta.1`.

- **Beta.** Any Agent requests one after merging, as before:
  `gh workflow run production-release-intent.yml --ref main -f release_components=<list>`.
  The train freezes `main`, ships the union of the open betas it contains, and
  versions the release as a beta of the patch after the last stable (or of a
  higher `X.Y.Z` that `main`'s `version.json` or an earlier beta already names).
  The Hub and the beta Web (`beta.xmatrix.sh`) deploy to production; CLI,
  Desktop and Android publish to their dev channel; iOS goes to TestFlight
  only. Its GitHub Release is a prerelease.
- **Stable.** Only the stable release Agent requests one, naming a beta it
  verified and the bump its changes call for:
  `gh workflow run production-release-intent.yml --ref main -f channel=stable -f candidate=xmatrix-vX.Y.Z-beta.N -f bump=patch|minor|major -f release_components=web,cli,desktop,android,ios`.
  The version is the last stable raised by `bump`; it must reach the
  candidate's `X.Y.Z` and exceed every release. The intent and the train check
  that the candidate is an immutable beta tag whose Production Release
  succeeded and shipped every component asked for, and that its source contains
  the last stable's source, so no stable moves back. The train then rebuilds
  exactly that source at the stable version, deploys the stable Web
  (`xmatrix.sh`) when it names `web`, and publishes the named clients to their
  stable channel; iOS is also submitted to App Review. The Hub is not part of a
  stable: it runs every beta, and keeps serving the stable Web until the next
  stable ships a newer one. A stable train ships alone, and wakes the train
  again for the betas it left open.
- **Failure.** A beta whose gates or production run failed reopens for the next
  train. A stable that failed before tagging closes: nothing changed. A stable
  whose production run failed stays in flight under
  `refs/release-inflight/<tag>/`, pending recovery by re-running that run's
  failed jobs, until it succeeds or a later successful stable ships every
  component it names. No train retries a stable on its own.
- **Gates.** A train runs the CI gates for what it ships on its release
  commit. The Hub suite gates each beta that ships the Hub; the Web suites and
  client suites (Rust on Linux and Windows, Desktop, Android, the iOS
  simulator) gate the stable that ships them. Every train runs CodeQL on its
  source for Hub, Web and Desktop JavaScript and TypeScript, and for the
  workflows it releases, before anything deploys. Rust, Kotlin and Swift
  CodeQL run on the stable train that ships that client, beside those client
  suites (`docs/operations/ci-lint-and-public-runners.md`).
- **Evidence.** Each tag's annotation records the `scope`, `source` and
  `channel` later trains read back. The request's authorization job is named
  `authorize <scope> production <tag>`, and stable preflight accepts only the
  release commit of a revision the request's `main` contains
  (`release-commit.mjs verify-cut`).
- **Clients.** Every build machine checks the artifact it built runs as exactly
  the release version before uploading it: the CLI's `--version` on each
  platform, the Desktop app's `app.asar` (`scripts/desktop-app-version.mjs`),
  the Android APK through `aapt2`. A CLI or Desktop build picks its update feed
  from its own version, so a beta follows dev and a stable follows stable. The
  CLI installs only a newer release (`--force` reinstalls the same version), and
  refuses a download that does not report the version its feed named; the
  Windows Supervisor runs a verified candidate to prove its version and never
  stages one that precedes the committed release. R2 refuses a beta on stable
  and a stable on dev, and the Web download API refuses a stable pointer or
  GitHub fallback that names a beta. iOS ships `X.Y.Z` with the Production
  Release run ID as its build number.

The synthetic Human reconnect smoke carries the exact source `version.json`
version in its WebSocket URL and handshake. Its assertions compare those wire
values with that manifest for both beta and stable builds, rather than requiring
a stable-only version shape.

## Release notes

The stable release Agent also authors the release's user-facing changes since
the previous stable, following [Authoring release notes](releases/README.md).
Commit `docs/releases/<version>.md` through a PR before building and verifying
the final beta candidate. The stable intent and train reject a candidate whose
source lacks valid notes for the resulting stable version. This preserves the
unchanged-beta-source contract: notes on newer main cannot be attached later.

The production receipt publishes the authored stable notes, or GitHub's exact
tag change list for a beta, before its deployment evidence on the GitHub Release.
Users open `/releases/<version>` from Desktop updates, Machine versions or the
CLI's update output, and download cards resolve their component and channel to
the same exact-version page. iOS stable submissions populate App Store What's
New from the authored notes, with a bounded preview and link to the full text.
Manifests add an optional `releaseNotesUrl`; existing
consumers can ignore it and the native IPC shape stays unchanged. After release,
verify that the exact version's public page and update links work. Old releases
without user-facing notes show an explicit unavailable message.

Beta note generation bypasses cached release-list responses before choosing its
explicit preceding published version. Reads retain the existing three-attempt,
15-second-request bound; the note length and release-control-marker validators
remain unchanged. In 1.5.1-beta.11, an outdated baseline expanded the generated
notes beyond their bound after the Web deployment had succeeded. Re-running
only that Production Release's failed receipt job published the correct small
change list. Preserve immutable tags and use the same-run failed-job recovery;
do not edit an already published body's notes to repair a failed receipt.

Migration: existing immutable releases are untouched. New stable candidates
must include notes in their source, so an older beta must be superseded by a
newly verified one containing the document. Receipt failures retain the existing
same-run recovery path; no version, tag, signing or update-feed authority changes.

## Scope evidence without job step metadata

Production request authorization is the completed successful job named
`authorize <canonical scope> production`, which depends on the frozen plan and
all selected gates. The dispatcher depends on this job. Production preflight
and the independent Hub/Web reuse checks require exactly one such job, its
completed/success conclusion, successful plan/gates, the authorizing workflow
identity, and the same verified main/release SHA. A caller-supplied scope or a
successful dispatcher alone cannot authorize a deployment. Step logs and an
empty `steps` array supply no authorization evidence.

Deployment receipt jobs similarly carry their scope in
`deployment receipt (<canonical scope>)`. Archival requires the completed
successful exact-scope job plus its existing exact run/SHA/attempt, selected
component results and finalizer checks. Historical immutable tags retain their
old receipt label and exact successful step marker; archival still accepts that
historical proof only when no new scoped receipt exists. Missing step metadata
never authorizes an old tag, and a failed/ambiguous new receipt cannot fall back.

Migration evidence: v1.0.367's production request and its plan/gates/dispatcher
succeeded, but the jobs and per-job APIs returned `steps: []`. Production
preflight failed on the missing marker in three attempts; every build/deploy
job was skipped and the live Web build stayed unchanged. The writer and all
request-proof readers migrate together in a new reviewed main revision. The
scope-specific job preserves the former marker's exact selection while using
job conclusion evidence that remained available. Runtime workflow tests cover
empty steps, missing/wrong/duplicate scope, failed/skipped/cancelled/incomplete
jobs, selected-gate failures, different SHA and delayed evidence.

Recovery: keep the failed immutable v1.0.367 tag unchanged. After the fix passes
CI and merges, request a new Release Intent. The train reopens the failed train's
intent and chooses a higher immutable version containing both the performance
change and this fix. No provider mutation, manual tag move, direct deployment or
credential expansion is needed. Existing production serialization and recovery
conditions remain in force.

### Delayed job conclusions

Before production mutation, preflight reads the request's plan, aggregate gates
and exact tag/scope authorization together. It retries missing or incomplete
conclusions within a ten-minute window, at most 120 reads five seconds apart,
with uncached requests and a ten-second request timeout. The full preflight
job has a 20-minute timeout. A
reported failure or duplicate authorization still stops immediately; exhausting
the bound still refuses deployment. Successful authorization without reported
gate success is insufficient.

Migration evidence: 1.5.1-beta.2 and beta.3 passed their request gates but failed
production preflight because GitHub's Jobs API had not reported those successes
within the former one-minute window. No build or deployment ran. Completed job
logs were available while the API still reported pending jobs for several
minutes. This changes only the bounded evidence read, retaining the same exact
source, workflow, tag, scope and successful-job requirements.

Recovery: preserve failed tags and use a new beta from the CI-validated main
revision containing this fix and its authored stable notes. Verify its successful
production run and live Web before requesting stable. The normal same-run
failed-job recovery remains available when GitHub accepts it; no direct deploy,
manual tag move or substitute authorization is introduced.

### Delayed candidate run discovery

Train GitHub reads bypass caches and have a ten-second request timeout. An empty
Production Release list is re-read at most 120 times, five seconds apart within
a ten-minute evidence window. A reported active run remains active; the newest
completed run must succeed, so an older success cannot hide a newer failure.
If a checked stable intent's candidate evidence is still missing, active or
unreadable, planning fails with that intent preserved. It cannot discard the
stable decision or fall through to a beta on unavailable evidence. A definitive
candidate rejection retains the existing refusal behavior.

Migration evidence: the 1.5.1-beta.6 Production Release succeeded and its stable
intent passed, but the following train received an empty candidate run list,
deleted the checked intent and selected a beta instead. No stable tag was cut.
Recovery: after the reviewed fix merges, re-run the affected planning job when
the intent still exists. An intent the old planner already deleted must be
requested again by the stable release Agent through Production Release Intent.
No manual ref restoration, moved tag, new deployment path or weaker success
requirement is introduced. Existing immutable releases are unchanged.

Production preflight also re-reads an omitted current Production Release run
before deciding which exact-SHA run is authoritative. Own-run discovery and
request-job conclusions share one ten-minute window, with uncached reads and
ten-second request timeouts. A known earlier same-SHA run still refuses a
duplicate immediately; a missing current run or an exhausted window never
authorizes deployment. The 1.5.1-beta.9 preflight exposed this second empty-list
case before production mutation and recovered through the same run's failed-job
retry once its record became visible. New immutable releases contain the
bounded discovery; historical tags retain their existing same-run recovery.

## Shared release workflow definitions

The immutable Production Release train calls `server-release.yml` with an explicit `hub`, `web-build`, or `web` target. The former `hub-deploy.yml`, `web-build.yml`, and `web-deploy.yml` had no other callers. Their original steps now live in separate target-selected jobs in the shared workflow. Hub and Web retain independent production concurrency groups, exact-request authorization, read-only GitHub permissions, the same production environments, and unchanged credential bindings. The build job explicitly keeps `contents: read` only. Web still builds beside Hub after PostgreSQL readiness; only Web deployment waits for Hub and the verified build handoff. Selected jobs keep the historical `hub / deploy`, `web-build / build`, and `web / deploy` evidence names; inactive jobs have distinct names. Unknown targets select no production job.

The Hub Worker version tag carries the authorized `deploy_sha`. Its post-deploy
smoke requires the live health metadata to report that exact SHA and a nonempty
provider version ID, alongside the existing health and compatibility checks.
Missing or mismatched revision evidence fails the release gate.

CLI, Desktop and Android build machines upload their verified files straight into the immutable R2 release `releases/<component>-v<version>/parts/<part>/<run>-<attempt>/`. `client-publish.yml` moves no artifact: it seals the release manifest that names the newest complete attempt of each part and points the channel its version names at it: `channels/<component>/dev.json` for a beta, `stable.json` for a stable (see "Beta and stable channels"). A channel never moves back to an older release. Hub and Web deploy to production with every beta.

Migration evidence: before consolidation, the effective YAML definitions were saved and compared with the selected shared jobs. Every original step, environment, runner selector, timeout, credential binding, and component lock matched; release-policy tests validate the new caller bindings and authorization order. Historical immutable tags continue to contain and use their previous workflow definitions. Android's new nested publication evidence is `android / release / release`; archival accepts that name or historical `android / release`, rejects multiple matching records, and still verifies exact train SHA, attempt, scope marker, PostgreSQL readiness, and finalizer outcome.

Recovery remains the established Production Release Recovery workflow: it may cancel only the exact preflight-success/PostgreSQL-readiness-waiting shape before any build or deploy job materializes, then resume the same authorized replacement run. The parent graph and that proof are unchanged. A consolidation failure must be fixed through a new CI-validated main revision and Release Intent; do not modify immutable tags, publish unverified assets, or bypass train authorization. The existing CLI manifest/envelope `workflow: "cli-release.yml"` value remains the compatibility label expected by installed Rust update and Windows continuity consumers; relocating the reusable publisher does not rewrite that wire field. Signing helpers retain the original Developer ID leaf/team checks, pinned Apple intermediate, private keychain isolation, and cleanup; no signing identity or artifact format changed.


## Unreleased: Web per release channel

Every beta deploys the beta Web (`xmatrix-web-beta`, `https://beta.xmatrix.sh`,
no workers.dev or preview hosts, not indexed); only a stable deploys the stable
Web (`xmatrix-web`, `https://xmatrix.sh`), rebuilt from the verified beta's
source. `server-release.yml` picks the target from the tagged version
(`node scripts/version.mjs channel`) and `deploy-config.mjs` renders it
(`web` or `web-beta`). A stable train may name `web`; it still never names
`hub`. Deployment receipts record the channel's Web, and the receipt reader
requires `xmatrix.sh` for betas before `1.3.1-beta.7` and `beta.xmatrix.sh`
from that first split train onward. Before a train deploys
the Hub, preflight reads the live stable Web's build (`/api/web-build`) back to
its release and refuses a Hub whose client policy would answer it with 426: a
different protocol version or a higher minimum Web version
(`scripts/stable-web-compatibility.mjs`).

The native shells load and trust the Web of their own channel. A beta desktop,
Android or iOS build opens `https://beta.xmatrix.sh/app` and a stable one
`https://xmatrix.sh/app`. Each lets only that exact https origin navigate in
place and call its bridge (the stable Web also under `www.xmatrix.sh`), never
the other channel's Web or another host under `xmatrix.sh`. Desktop and Android
read the channel from the app's own version. iOS cannot, because its App Store
version drops `-beta.N`; `scripts/ios-testflight.sh` sets its Web
(`XMATRIX_WEB_URL`, read back as `XMatrixWebURL`) from the release version when
it archives. Android's packaged offline Web is served under the build's own Web
origin. On every shell, the in-place sign-in opens only the Hub
(`xmatrix-hub.xmatrix.sh`), no longer any `xmatrix.sh` host. Beta users sign in
once more on the beta Web, because the session cookies the Web sets for native
shells belong to `xmatrix.sh` alone.

Migration evidence: the first beta train after this change creates the beta
Worker and its custom domain on its Web deploy; `xmatrix.sh` keeps the last
beta it served until the first stable that names `web` replaces it. The Hub
already trusts the beta origin (APP_BETA_URL). Native builds released before
the shells chose by channel keep loading `xmatrix.sh`. Clients that choose by
channel ship only once `beta.xmatrix.sh` serves: their first beta follows the
first beta Web deploy, or names `web` itself.

Recovery: a failed beta Web deploy is re-run on the same Production Release
run, like any job; it touches neither the Hub nor `xmatrix.sh`. Beta native
builds load nothing while the beta Web is down, so that re-run restores them
too. Undoing the split is a revert of this change and of the shells choosing
by channel: betas then deploy `xmatrix.sh` again, later native betas load it,
and the idle beta Worker can be deleted.

## Unreleased: Repository tokens are bound to the Run

The Hub mints an Agent's GitHub repository token only for the repository the
Hub admitted for that live Run on the calling machine, and asks GitHub only for
contents and metadata access (no pull requests, issues, Actions, workflows or
secrets). A repository outside the Space's connected installations is refused
with a precise reason (`github_installation_not_linked_to_space`,
`github_repository_not_installed`), and a probed installation token is accepted
only when it covers exactly that repository. Daemons that predate the Run
binding keep working while `GITHUB_REPOSITORY_TOKEN_LEGACY_UNBOUND_ENABLED` is
on.

## 1.0.0: first source-available release

1.0.0 is the first release built from the public repository `LambdaLabsHQ/xmatrix` under FSL-1.1-ALv2. The source is published; self-hosting is not documented or supported, and external pull requests are closed in favour of the Prompt request issue template. The version moves from the 0.16 train to 1.0.0 with no protocol, storage, or update-channel break: `scripts/release-train.mjs` takes `version.json` because it is above the newest tag, the Windows continuity sequence orders 1.0.0 above every 0.x release, and installed CLI, desktop, and iOS clients update through the same channels.

Since 0.16.854 this release adds:

- GitHub: Agent repository tokens are bound to their Run and Git permissions; private repository events stay out of public channels; the `xmatrix/claim` check verifies the Space's installation; a second App install merges into the Space connection; the pre-review verdict lands only on the reviewed head commit.
- Web: workspace lists update by push instead of polling; declined summons show on their card instead of a Channel notice; the summon panel shows Jev's input and answers; a Machine tag and its hover card open the Machine's page; message rhythm and composer alignment follow the avatar column; square jump highlight and reply quote card.
- Runtime: crowded channels fan out across owner cells and sockets carry their owner; Cursor quota headroom follows the bucket of the selected model.
- Reliability: Windows tree cleanup skips an unterminable older process on a recycled parent edge; expected Stripe, notice, and expired-credential conflicts are classified instead of reported as Hub errors.

## Unreleased: Summon tags show the routed machine

A summon chip shows the choices behind the launch. Jev fills repository, model,
effort, and harness. Routing fills `machine:<owner name>`. A hostname stays
the popover subtitle and is not that tag. Fields the author already wrote are
not repeated, and the message body stays unchanged. Whether a
machine is a laptop is that machine's own reported form, not a Jev choice, so
there is no `placement:` tag. Headroom picks among every environment that can
run the chosen work, laptop or not. An owner who turns auto-assign off keeps
that machine out of automatic assignment. Evidence from
`registration-parameters-v7` may still record a placement choice;
`registration-parameters-v8` does not ask one.

## Unreleased: Workspace search reads pages, attachments, and members

Ctrl+F searches page titles and committed section text, attachment filenames,
and Space members, and keeps scanning older messages until the readable history
is proven or the result list is full. A hit inside a page opens that section.
Restricted pages stay hidden, and uncommitted page edits are not in the index.

## Unreleased: Shared Agent execution symptoms

The Channel work dock shows connection retries, failed turns, and prolonged
absence of runtime progress through one per-Instance observer used by every
Agent harness. Progress and completion clear transient symptoms, failed turns
remain visible until new work, and reconnect replays the current summary.
Declared waits and open tool calls suppress the five-minute silence signal.
Optional ACP v1 Session Notices appear separately from execution failures;
an error notice does not fail a turn. Public presence carries only typed
symptoms and timestamps; supplied diagnostics remain in the host Trace.
Older clients and runtimes retain their existing display and behavior.

## Unreleased: Work dock island is a wood plank

On wood, the work-dock capsule is a plank in the rail's paint rather than a
glass capsule, with no edge lines. The avatar on its leading end is clear
liquid glass that bends the grain, and the words and timer ring are lightly
cut into the wood in dark ink.

## Unreleased: Work dock island matches the avatar

The work-dock capsule grows straight out of the circular Instance avatar at
the avatar's own size. The grey ring outside the face is gone. The presence
mark stays on the disc: a solid orange dot while the Instance is working, a
hollow orange ring while it waits. The timer ring and elapsed time stay at
the trailing end.

## Unreleased: Machine tag load excludes disk capacity

Machine tags use the higher of processor and memory usage for their fill and
colour. Disk capacity, including a nearly full disk, is excluded from the tag's
load. Hover details show processor, memory and disk readings; disk capacity
remains visible without affecting the tag's fill or colour.

## Unreleased: Registered launch reliability and diagnostics

Jev selects a summon model from the runtime-reported catalog. A registration that
only names its harness does not send that name as a model. When the runtime has
not reported a catalog, the launch omits the model parameter. Repository and
directory locations stay separate choices; repositories come from the Space
GitHub connector, and an unspecified location prefers a repository worktree.
Composite Space summons now retain a specific preflight rejection when an explicit
machine, harness, model, effort, repository, or directory has no authorized
registered match. Provider authentication, verification, rate limits, timeout,
invalid answers, and evaluation failures identify whether Jev was choosing an
environment or its launch parameters. The Channel invocation card and
`xmatrix diagnose` show the same bounded cause without adding provider text,
private paths, or credentials to the rejection. A failed preflight never allocates a Run.

Repository startup admission now verifies the repository against the authorized
Run instead of looking it up as a local Workspace. Disabled or model-ineligible
registrations no longer reach Jev. CLI diagnostics accept registration launches
without legacy Profile IDs. Editing a default model and pausing a registration
preserve unrelated configuration and policy resources, using their independent
revisions. An immutable maintenance receipt restores the one connector-authorized
repository omitted from the affected migrated registration. The existing
production maintenance workflow runs its dry-run and version-fenced write;
the original summon is covered by an end-to-end regression through admission
and Channel reply.

A daemon-started Agent Run reaches the daemon's own `xmatrix`: its directory
comes first on the Run's PATH and `XMATRIX_BIN` names the exact executable. A
stale `xmatrix` elsewhere on the profile PATH no longer reads newer subcommands
such as `page` as a runtime to wrap. A nested command that names a runtime
other than its Run's is refused before it touches the Run's status file, so it
can no longer mark the live Run `wrapper_startup_failed`.

## 0.16.342: Exact mention messages and stable Channel view selection

`@auto` remains syntax inside one Channel message. Routing uses the published
message and Channel context without sending a second body to launch authority or
comparing its hash. Jev receives a bounded privacy-safe view of the message;
transient gateway failures get one bounded retry without choosing an Agent on
the server's behalf. The old routing plan and dispatch endpoints return 410;
send a Channel message with `@auto` or a harness mention instead.
The Web Channel view keeps a Human's Tree or Flat selection in the active tab
when a preference write returns an older view, reports the unconfirmed save,
and rechecks the write once before accepting it.
## 0.16.341: Publish launch failure diagnostics in Hub and Web

This Hub/Web train ships the 0.16.340 source changes that identify the failed
Jev question and validation issue, show retained failure causes in invocation
cards, and label unread quota as unknown. The separate 0.16.340 production
request selected Hub and CLI, so Web requires this new immutable release scope.
The 0.16.340 Hub deploy stopped during bundle verification because the clean
checkout had not built `@xmatrix/protocol`; this train builds it before the
exact-SHA dry run and retains the failed tag's recovery evidence.

## 0.16.340: Explain launch parameter failures

Auto summon failures now report a safe provider or validation cause before launch
allocation. Invalid Jev answers identify the question key from the actual decision
request and the validation issue, so new parameters receive the same diagnostic
without a fixed display list. The invocation card surfaces retained failure evidence
for older generic failures, keeps candidate observations behind a disclosure, and
labels unread quota as unknown instead of showing a measured 100% balance.

## 0.16.339: On-demand component publication and Web completion

Production requests now select any supported subset of Hub, Web, CLI, Desktop,
Android, and iOS. Node checks and the selected component suites run on one
frozen SHA before the immutable tag is created. Tagged deployment verifies the
exact scope authorization, publishes only selected components, and records the
actual scope in R2 and GitHub receipts. Desktop requires CLI in the same train;
selected client publication checks live Hub admission of its exact version.
This release can publish Web alone after Hub 0.16.338, making the compact
`machine:<uuid>` completion available in the Channel Composer.

## 0.16.338: Channel control and Hub-only production scope

Stop commands now finish their Hub dispatch and visible receipt before the
message response. `/kill all` describes unconfirmed queued stops as pending
instead of failed. Existing live Agents receive a new `@auto` summon as context;
the allocated Run alone receives it as its initial message. A candidate without a
current model catalog can explicitly select its harness default without sending
a fabricated model ID or effort override. Summon decision evidence retries one
idempotent storage step after a transient failure, and Auto publishes its exact
prepared batch immediately before arming the durable recovery coordinator.
The updated Web source inserts `machine:<uuid>` instead of
`machine:machine:<uuid>`, while the Hub accepts both spellings as the same exact
machine identity. The completion change reaches users only when a reviewed Web
release follows this Hub-only train.

The production train for this version applies its PostgreSQL checks and deploys
Hub only. Web, CLI, Desktop, Android, and iOS remain at their previously
published versions. The full test matrix, immutable tag, Hub source checks,
post-deploy verification, and scoped deployment receipt remain required.

## 0.16.317: retire the :new and :once launch suffixes

Legacy `:new` and `:once` message launches are rejected with a tag-syntax
migration notice; they are not translated or executed. Use
`@auto repo:owner/repo mode:persistent <message>` or `mode:once`, replacing `repo:`
with `pwd:"<registered/directory>"` for a registered directory. Start-action
completion and Agent/Automation guidance use tags. Existing instance addresses,
stop, reborn and handoff retain their lifecycle semantics. Stored Automation
expressions are not silently rewritten; owners must replace retired launch
suffixes before their next successful invocation.

## 0.16.316: correct routing snapshots and report launch failures

Auto and harness invocation exceptions now produce a source-bound Channel
notice instead of only a server log. Direct harness requests also distinguish
candidate-query, eligibility and allocation failures. A failure after possible
allocation or wake delivery is explicitly unconfirmed, not proof that no Agent
started; reporting it never retries the request or falls through to another
launcher. Private exception details remain out of Channel notices.

Routing now orders quota snapshots by validated provider observation time,
not Instance heartbeat time. An old positive snapshot cannot replace newer
exhaustion simply because its Instance updated later. Agent unregister also
carries its authenticated connection version, fencing stale connections;
daemon-launched Runs leave completed/failed terminality to their exit report.

Among eligible candidates, deterministic routing compares exact fresh remaining
quota before load/latency rather than treating every positive reading equally.
Invalid percentages do not gain preference. Auto receives exact quota and
freshness facts plus explicit requirements, while request suitability can override
quota preference. Auto's v7 decision path separately assesses access, platform
and continuity before quota-aware selection, within a shared 10-second budget
and at most two concurrent prerequisite batches. Rejected candidates cannot be
resurrected by selection, and all-rejected or failed evaluations never allocate.
The architecture evaluation record preserves earlier unsuccessful experiments
and distinguishes model outcomes from service failures and deployment evidence.

Focused tests cover exhausted candidates, service failures, successful dispatch,
wake exceptions and notice-service failures. A fresh-PostgreSQL reproduction
and an isolated Hub/daemon fixture cover snapshot ordering, real child startup,
Channel replies, exhausted-candidate exclusion and Agent-requested stop. The local
fixture controls both external model boundaries. These checks do not establish the
cause of the production 315 canaries without replies; a real launch, reply and
Agent-requested stop still require post-deployment acceptance.

## 0.16.315: preserve provider quota exhaustion during routing

Read the actual `resetAt` quota wire field, including Unix-second timestamps.
Evaluate quota windows independently so a short reset cannot erase an exhausted
weekly window. Persisted exhaustion with a known reset remains exclusion evidence
until that reset, capped at 31 days; positive or reset-unknown observations keep
the 15-minute freshness bound. Fresh provider recovery replaces older evidence.
Unknown quota is not unlimited: deterministic routing prefers observed positive
quota, and Auto's v5 rubric uses the same preference among candidates equally suitable for the request.

Protocol and Hub regressions cover both Auto and direct harness selection. The
production 314 canary did launch but failed at the provider's usage limit; these
changes do not claim that canary completed or automatically replay an accepted
execution. Post-deployment launch, reply and Agent-requested stop remain required.

## 0.16.314: route ordinary requests without custom environment descriptions

Auto's v4 suitability rubric treats a coding harness as capable of ordinary
repository work even when its owner has not entered a custom routing description.
Brief requests are routed for the Agent to clarify instead of being rejected by
the selector. Explicit unsupported specialized requirements still abstain;
authorization, eligibility and allocation checks are unchanged.

Remove retired main-to-test dispatchers from the reusable CI graph so the
production request can validate it under read-only permissions. Conditional
skipping alone does not satisfy GitHub's reusable-workflow permission ceiling.
No caller permission is expanded and Next's push-only deployment is preserved.

Live synthetic Jev checks on 2026-09-21 selected an environment for README
inspection and a brief request, and abstained for an undeclared proprietary
Windows application. These checks verify rubric behavior, not completed Agent
launches or a production accuracy benchmark. Real Channel launch acceptance
must be verified after deployment.

## 0.16.313: Auto availability and selection errors

Remove Jev account allowlisting from Auto, routing and evaluation. Existing
authentication, Channel access and environment eligibility remain enforced;
the provider key stays inside the Worker. Routing accepts a valid highest-ranked
candidate above abstention without treating relative choice probability as
calibrated confidence. Auto distinguishes unavailable selection services,
semantic non-selection and an empty eligible set.

Legacy launch-suffix retirement and Agent registration composite-key migration
are separate changes and are not included in this release.

## 0.16.312: keyboard-first Auto launches

The composer offers Auto and launch conditions through one `@` search. Selecting
a repository, model or machine creates removable tags without requiring users
to learn parameter syntax. Arrow keys and Tab/Enter select conditions; ordinary
typing continues the message. Existing harness entry points and IME remain intact.
Portable `@auto key:value` summons route through Jev with server-enforced constraints,
replay recovery and exact-directory fallback. Authenticated Agents can invoke
Auto and harness shouts using their owner-bound Channel authority, alongside
existing peer lifecycle and stop commands. Explicit effort requires a daemon
advertising `machine_routing_effort_v1`.

## 0.16.311: production freeze of the @codex:new launch chip

0.16.310 froze one commit earlier than the hotfix that binds a shared `@codex:new`
mention to its routed launch and cools a machine that just failed to spawn. This
train is that hotfix on current main.

## 0.16.310: @codex:new shows the routed launch and skips a machine that just failed to spawn

`@codex:new:owner/repo` already binds a harness to one environment. When several
Codex Profiles share a Space, the written `@codex` stayed plain text, so a
routed launch that then failed to spawn looked like the mention did nothing.
The message's launch now names that chip. A non-retryable daemon spawn failure
cools that Profile for an hour so the next shout can pick another machine.

## 0.16.309: @codex:new routes with repo or CWD

`@codex:new:owner/repo` is a harness summon, not a unique Profile. Hub binds
the repository to one environment through routing (Jev when configured, with
quota as a tie-break). `@codex:new:/absolute/path` matches the registered
working directory. An empty routing model is idempotent, so plan/dispatch no
longer fail after the first parse.

## 0.16.308: paged catalog activity and post-0.16.307 fixes

0.16.307 never froze a candidate tag: the version-bump push's main `CI` run was
cancelled by later merges before it could dispatch the candidate `Test Release`,
and the following same-version pushes could not freeze it. This train re-bumps
from current `main`, so the candidate contains every change since 0.16.306.

The paged PostgreSQL Channel catalog now serializes a Channel's newest message
time as `updatedAt`. A Channel that keeps receiving messages advanced
`activity_at` but not `updated_at`, so chat-list flat views ranked it by its
last config write and pushed it to the bottom of every loaded page, where
infinite scroll never reached it. It now matches the legacy `list-channels`
read, which already folded the newest message into `updatedAt`.

## 0.16.307: production freeze of 0.16.306

0.16.306 landed on main but its Test Release did not freeze a candidate tag,
because a later same-version push compared equal and skipped tagging. This
train freezes the same product: one Agent name in completion, shared status
chips for owner/machine, and shouts that do not send the harness as a model id.

## 0.16.306: one Agent name in completion

Composer `@` completion offers one row per Agent display name in a Space.
`@codex` and `@grok` are harness shouts; routing picks the machine. `:new` and
`:once` still complete GitHub repos and registered working directories.
Duplicate Human names stay distinct. A shout no longer sends the harness name
as the runtime model id, so ChatGPT Codex uses its configured default.

## 0.16.305: @codex shout selects a startable machine

A `@codex` shout now plans only among matching machines, and only requires a
registered default working directory when one exists. 0.16.304 could pick a
busier machine without a workspace, then fail closed when dispatch required a
workspace. Registration-launch errors no longer skip shout routing.

## 0.16.304: @codex auto-route

A bare `@codex` shout is a harness capability, not a unique handle. The composer
inserts the display name, message commit no longer rejects repeated Agent names
as ambiguous, and Hub routes the shout to an eligible machine. Duplicate Human
names still fail closed. The composer has no separate auto-route form: mention
syntax is the product surface. Composite registration launch and owner controls
ship with this train; Space `data.agent_registration_authority` stays off, so
this release does not cut identity over or broaden Agent permissions.

## 0.16.303: mobile startup

The first Channel-list page loads before background workspace and Agent data,
while direct Channel links retain message-history priority. Client admission no
longer restarts initial private reads when the account query client changes.
Hash-named Web scripts and styles use immutable caching. The iOS shell creates
only the current tab at startup, preserves visited tabs, and retires hidden pages
when the active account changes. Older clients tolerate the additive bridge
metadata.

## 0.16.300: composite registration migration preparation

Defines owner/machine/harness registration keys and Space-scoped configuration
keys without a new Agent UUID. Adds inactive composite-key tables and a bounded,
read-only inventory operation for the reviewed Space registrations. Existing
profile authority and runtime addressing remain in place until verified bindings,
conflicting configurations and dependent references are migrated. This release
does not claim the identity cutover or broaden Agent permissions.

## 0.16.299: approval preflight and Agent recovery

Includes the sandboxed Agent reply and owned Instance recovery fixes from 0.16.298.
Approval validates required secret availability before committing the decision, so a
missing value leaves the request pending and can be retried after saving. Missing-secret
errors explain that action without exposing private catalog details.

## 0.16.298: sandboxed Agent replies and owned Instance recovery

Agent child CLI commands use their inherited Run routing and scoped brokers without
opening the Human profile registry. macOS isolation permits only the non-secret
lineage discovery needed by the owner-execution guard; credentials, approval tickets,
and marker writes remain blocked. Owners can request exact-Run Instance recovery
through an authenticated control endpoint without posting a Channel message.

## 0.16.297: readable exact-Profile summons

Agent mentions addressed by a complete Profile ID display the resolved name and
original lifecycle/repository tail, without exposing fragments of the ID as
command text. Pending summons preserve the same exact identity as member
mentions. Repeated display names remain ambiguous instead of adopting the first
pending Agent's receipt.

## 0.16.296: validated Windows update recovery release

Includes the Windows automatic update recovery fix from 0.16.295. Shared recipient
identity and Channel preference test fixtures remove duplicate-code failures on main
without changing message delivery or preference behavior.

## 0.16.295: Windows automatic update recovery

Windows daemon self-update now retains its restart obligation after the old process exits.
Failed updates restore and verify the previous daemon before reporting rollback success.
Cleanup excludes Agent wrappers and commands that merely mention `daemon`, including when
they share the stable CLI executable. CLI-only updates preserve an intentionally stopped task.

## 0.16.294: reproducible maintenance preflight

The protected PostgreSQL maintenance preflight now installs pinned Node, pnpm,
and workspace dependencies after verifying immutable release authority. Fresh
runners can execute the bounded operator checks without relying on a previous
job's PATH. Production credentials remain exclusive to the subsequent maintenance
job. The authorized Space rename, its fixed manifest and restore path are unchanged.

## 0.16.293: Agent presence survives catalog refresh

- Channel pagination, route resolution, and realtime updates now share the
  hydrated Channel merge instead of replacing live Agent cards with sparse rows.
- One instance merge retains omitted tags, rejects older nonterminal status,
  accepts current idle/offline reports, and isolates replacement instances.
- Browser coverage verifies model, effort, sandbox, and branch visibility after
  catalog refresh and the subsequent busy-to-idle transition.

## 0.16.292: disconnect and reborn recovery

- Historical reborn lookup accepts the current display label, retained address,
  or exact Profile ID and still rejects ambiguous names.
- Agent replies now retain exact Run authority across transport-only disconnects,
  while terminal, replacement, deletion and handoff fences remain enforced.
- Peer presence broadcasts no longer await recipient inbound queues, preventing
  reciprocal concurrent broadcasts from deadlocking.
- PostgreSQL reborn intents retain stop-to-spawn continuity across delayed
  acknowledgements and coordinator restarts; migration 0058 is additive and
  existing daemon stop/spawn contracts are unchanged. See
  [Runtime reborn recovery](operations/runtime-reborn-recovery.md).

## 0.16.290: repeated Agent display names

Agent Profiles can share a display name such as `codex`. Owner and machine
labels appear in the picker, message headers, and the Channel details rail.
Selecting a repeated name uses the exact
Profile ID for startup and Instance controls. Ambiguous typed names do not pick
an arbitrary Agent. Registration no longer adds host names or numeric suffixes.

Migration 0057 adds a non-unique display label while retaining historical
addresses for existing invocations and automations. Existing Profiles are not
renamed or enabled for routing by deployment; those remain authorized owner or
Space administrator operations.

## 0.16.289: Space environment routing

Users can request a model without choosing a machine. Automatic routing selects
among explicitly owner-registered environments in the current Space, including
different harnesses. Declarations describe capabilities and unattended
availability; fresh presence, startup latency, provider quota and active Run
counts inform eligibility and ordering. Optional Jev matching can abstain.

PostgreSQL serializes startup fallback with a unique accepted Instance, rejecting
late superseded startups. Registration names are optional and identity labels
show owner, machine and harness. Desktop users can explicitly install supported
runtimes without automatic sign-in or enrollment. Migration 0056 and a daemon
advertising model forwarding are required. See
[Space agent routing](architecture/space-agent-routing.md) for boundaries,
verification and rollout prerequisites.

## 0.16.287: generic Jev evaluation

The Hub exposes authenticated `POST /api/ai/jev/evaluate` for shared state and
Boolean, Choice, or Score questions. The provider key stays in a Worker secret;
a deployment-owned Human/Run-owner allowlist gates access. Requests are bounded,
time out after 15 seconds, and return structured answers with sanitized errors.
The local `pnpm jev:evaluate` command uses the same client. This entry point does
not change routing or Agent dispatch. See [Jev evaluation](operations/jev-evaluation.md).

## 0.16.283: persist offline when reverse delivery evicts the last owner

Evicting a half-open Machine Daemon socket used `remove()` before `close`, so
the late close callback never unregistered the catalog row. A last-owner
`failedDeliver` eviction now persists offline. Catalog `online` cannot survive
a dead reverse-delivery session.

## 0.16.282: hollow-online daemon notices

When a Machine Daemon catalog row is `online` but reverse delivery returns
`delivered=0`, the start notice says the daemon has no live control session
and will start on reconnect. It no longer claims the daemon "is online".

## 0.16.281: Agent send keeps the Run token

If the daemon request-broker journal path returns `unauthorized` for this Run,
`xmatrix send` submits the same body with the already-resolved Agent Run token.
It does not fall back to the launching Human's session.

## 0.16.248: optional catalog configuration

Production deployments no longer require `XMATRIX_SECRET_CATALOG_KEY` to ship
Channel transfers and secretless Workstation approvals. An absent value is omitted
from the deployment secret payload, preserving existing Worker secrets. A supplied
value still requires validation and post-deploy binding verification. Managed
Secret recovery remains separate; this release neither generates nor rotates keys.

## Manifests

- `/api/releases/latest` returns the current web/root train as `version` and `trainVersion`, plus the latest CLI, Desktop, and Android release manifests.
- `/api/cli/releases/latest`, `/api/desktop/releases/latest`, and `/api/android/releases/latest` expose the newest
  immutable stable release for that target (reviewed R2 channel first, GitHub fallback where supported). Their
  `version` and `releaseVersion` fields describe the downloadable release, and `trainVersion` preserves the current
  web/root train for diagnostics. R2-backed CLI assets also carry exact size, SHA-256, workflow, Git SHA, and run
  provenance; Windows continuity refuses manifests without those fields.
- Target release manifests resolve the newest published release whose tag uses the target prefix, such as `cli-v*`, `desktop-v*`, and `android-v*`. Desktop stable feeds must also require the platform-specific updater asset set before serving a release: macOS feeds require `latest-mac.yml` plus DMG/ZIP blockmap assets, while Windows feeds require `latest.yml` plus EXE blockmap assets. Do not let a draft or missing current-train target release break installed-client update feeds, and do not let one desktop platform's missing assets block the other platform's updater feed.
- CLI and daemon update checks prefer the manifest `version` before falling back to the release tag, so that value must match the downloadable target release version.

## Client Behavior

- Cross-Space Channel moves require a durable proposal and two separate Human
  admin acknowledgments. Web/native shells and CLI share that protocol; Agent
  drafts retain their existing Space scope and cannot acknowledge. Same-Space
  reparenting is unchanged. Tree, message and attachment scope commit together.
- Workstation approval cards distinguish queued delivery from locally recorded
  decisions and process completion. Exact Machine/host routing, durable terminal
  receipts and idempotent local execution keep retries from repeating commands.
  Owner-approved host commands use a clean environment and one-shot executor
  tickets without gaining Human Hub credentials.
- Production Hub deployment requires the protected catalog encryption key before
  deploying and verifies its binding afterward. Secret-free once approval remains
  independent of catalog availability. Recover existing keys before configuring
  this binding when retained encrypted data exists.

- Production releases apply the exact tag's pending PostgreSQL expand migrations
  on both existing shards before readiness and deployment. The runner rejects
  empty ledgers, changed history, pending contract migrations, and incorrect shard
  identities; transactional receipts make failed-job retries resumable. This
  restores the routine migration step missing from the 0.16.238 train.
- PostgreSQL message acknowledgments accept an omitted sequence without failing
  request hashing. When a summon parks its cursor by message ID, the transaction
  resolves that exact message within the authorized Channel and Space; later
  messages remain unread. A missing target or conflicting sequence fails closed,
  and replay preserves the original cursor result.
- Daemon-spawned Claude stream processes use the reviewed Agent Profile runtime
  from `XMATRIX_SPAWN_RUNTIME`, never the launcher/agent-type identifier. Spawn
  failures now include the exact executable name in diagnostics.
- Reborn reads the predecessor Instance's current authority version after the
  daemon confirms its stop. PostgreSQL no longer rejects cleanup with
  `expectedVersion is invalid`, and stale cleanup cannot terminalize an
  Instance that was rebound to another Run.
- Post-retirement Space authority routes are re-registered in the active route
  inventory before channel creation. This repairs a lost registry write even
  when the immutable retirement manifest already contains the Space route.
- Existing Space capacity routes receive the same active-registry repair before
  a new root channel is registered with its authoritative family.
- Brand surfaces that provide their own canvas use the transparent logo source:
  browser icons, in-app brand marks, and the Android adaptive foreground.
  Desktop and iOS app icons, Apple touch icons, PWA install icons, and social
  previews remain opaque because those consumers require or render a full
  background more reliably.
- A production version train runs CLI, Desktop, Android, and iOS publication
  from the immutable `xmatrix-v*` tag. Candidate checks retain job evidence,
  while production handoffs and downloadable assets use the reviewed R2
  release store instead of GitHub Actions Artifacts.
- Linux release orchestration bootstraps Node from the upstream `tar.gz`
  archive so minimal self-hosted runners do not need an external `xz` binary.
- Release-storage uploads uniformly reuse the existing S3 streaming uploader
  and `R2_RELEASE_*` credentials for every object size, including manifests,
  channel pointers, and receipts. There is no small-file Wrangler PUT fallback.
  Independent download/readback verification streams S3 GET responses with
  the same scoped credentials and a deadline covering headers and the full
  body. Partial reads are removed, and complete size/SHA-256 checks still gate
  publication. Read-only callers without S3 credentials retain the bounded
  workspace Wrangler path; configured S3 failures cannot switch transports.
- Native artifact handoff downloads verify the internal R2 manifest and every
  declared object before removing that transport-only manifest from the exact
  directory passed to strict CLI and Desktop content verification.
- Windows Desktop handoff uploads use native PowerShell environment access, so
  the staged release directory cannot be lost through Bash-style variable
  expansion under the Windows runner's default shell.
- Test Release reconnect smoke recovers the exact synthetic Channel when a
  transient create response is lost after commit. It accepts either an
  exhausted retryable response or a name conflict, waits for the committed
  winner to appear in the catalog, then continues through ordinary cleanup.
- Post-retirement Space and private-Space creation repairs an authoritative
  route whose active-registry publication was interrupted, so the first root
  Channel can finish its family registration instead of returning an opaque
  server error after commit.
- **0.16.0 Web migration notice:** the first authenticated browser/Web launch
  replaces its rebuildable local history replica and resynchronizes it from Hub
  authority. The browser must be online while that rebuild completes. Channel
  history is not deleted from the Hub; an interrupted rebuild restarts safely
  on the next launch instead of exposing a partial local history. This does not
  migrate the independent Rust or Desktop-native replica formats. Preserve
  this scope and notice in the `0.16.0` client release descriptions.
- The CLI can be updated manually with `xmatrix update` on macOS, Linux, and Windows. The Windows
  installer still rewrites any historical WScript/generation Scheduled Task to the exact stable
  `xmatrix.exe daemon` action and verifies that process before succeeding.
- A Windows in-place update must keep live Agent wrappers. The updater stops only `xmatrix.exe daemon`,
  renames the locked previous CLI aside when `File.Replace` cannot open the running image, writes the
  new stable binary, and starts the existing Scheduled Task. It must not stop `xmatrix-daemon` and must
  not require generation pointer activation on the official direct-task install.
- The daemon checks for updates periodically on every platform and uses the manager-specific atomic
  replacement and rollback path for that OS.
- Windows Agent broker proxies resolve the captured Profile's current loopback broker before
  forwarding requests, including when an old daemon port has been reused. They retain the original
  upstream Run capability, return a retryable 503 during replacement, and never replay a written
  request. Explicit adoption disables legacy discovery. Already-running older wrappers require an ordinary instance
  Reborn recovery into the fixed CLI; a daemon-only update cannot patch those processes.
- macOS CLI releases publish `xmatrix-macos-arm64` and `xmatrix-macos-x64`; hosted builds use Apple Silicon and Intel respectively, and sign both with the same Developer ID identity. The self-hosted Apple Silicon runner still cross-compiles Intel. Both artifacts must execute their exact-version probe before publication. `install.sh` installs the native arm64 binary when its shell runs under Rosetta.
- The macOS Desktop release builds one app per architecture (`arm64` and `x64`, never universal), each carrying its own architecture's CLI seed. One `latest-mac.yml` lists both; electron-updater picks the `arm64` files on Apple Silicon and the others on Intel, and its legacy top-level `path` stays on the arm64 ZIP.
- A Windows CLI release publishes the single portable `xmatrix-windows-x64.exe` artifact through the same reviewed,
  immutable R2 handoff as the other CLI platforms. The release manifest records the exact workflow provenance, size,
  and SHA-256; a Windows code-signing certificate is not required.
- The macOS and Windows desktop apps use the Electron updater feed, download updates in the background, and install downloaded updates on app restart. Automatic checks do not interrupt the user with a dialog; manual checks still report the result.
- macOS release builds fail closed unless both the built app and packaged updater ZIP satisfy the established Developer ID requirement: bundle ID `net.madebyrobot.xmatrix`, Apple Developer ID certificate chain, and Team ID `VWN9V9V56Z`. Adhoc, unsigned, invalid, or identity-drifted artifacts must never reach the stable or dev updater feeds because Squirrel.Mac cannot migrate installed clients across that boundary.
- The self-hosted macOS release runner downloads Electron and electron-builder binaries through their checksum-aware npmmirror endpoints and retains the binary caches and PNPM store between runs. CLI and Desktop installs share `.github/actions/macos-pnpm-install`, preserving the runner's proxy environment and registry selection with bounded fetch timeouts and retries. On the M1 release host, sing-box routes domestic mirrors directly using local DNS while other proxied requests retain the Singapore Alibaba Cloud route. Release and manual disk-cleanup jobs remove only validated current-checkout outputs; shared-store pruning requires an operator to drain all runners on that host first. See [macOS runner network and cache maintenance](operations/xmatrix-release-deployment-guide.md#macos-runner-network-and-cache-maintenance).
- Every Linux release job runs on the US machines: release validation on its own `xmatrix-release-test` runners, apart from PR CI, everything else — planning, builds, Hub and Web deploys, CLI and Desktop finalizers, post-CD archival, Test/Production brokers — on `xmatrix-us-release`. Do not retarget them to `local-linux-x64`: domestic Linux runners stall on `uploads.github.com` and R2. The former always-on `postgres-integration` CI partition is not a release gate.
- A user-initiated update failure remains user-visible through an actionable recovery dialog and application-menu manual download entry. In particular, preserve the manual-update context until Squirrel.Mac completes its asynchronous post-download signature validation; do not turn that failure into a silent return to “Check for Updates.”

When changing release behavior, update the relevant workflow, script, and this document together.

## Unreleased: Leaving a newly made Page preserves its first edits

A new Page's creation snapshot can contain only its first character. Leaving
once creation returns, before the first live sync, now keeps that session
alive for the same bounded 15-second handoff already used while creation is
pending. Its response to the server's state vector includes the rest of the
local document before closing; repeated disposal cannot cut that handoff
short. Ordinary established sessions and unseeded creation keep their existing
behavior. No schema or native change is needed. Recovery uses a CI-validated
beta Web release reverting the change. Browser/process termination or a sync
that cannot complete within that bound retains its existing limitation.

## Unreleased: The Agent picker keeps one complete selection

The strengths editor control stays independently clickable while the Agent
choice keeps its full inset selection surface. A hidden, inaccessible copy of
the same responsive label reserves its width; the actual control is a sibling,
so buttons are never nested. Hovering that control uses the row's existing
selection fill. This restores the established mention geometry contract without
changing keyboard selection, routing or profile permissions. No migration or
native update is needed; recovery is a CI-validated beta Web release reverting
the change.

## Unreleased: Execution report lock failures retain their blocker

HUB-AY lost a Run-lock response, then its one fresh-session replay hit a lock
timeout. The event did not identify the holder. A slow execution-owner query
now takes one bounded, independent read of the live PostgreSQL wait edge,
before a lock timeout erases it. Failures retain waiter and blocker state,
transaction age and fixed owner categories; SQL, parameters, backend ids and
user identities stay out of the event and Sentry issue reader. Fast queries
open no extra connection, and each isolate permits only one concurrent sample.
Unavailable diagnostics preserve the original error. Existing replay and
unknown-COMMIT boundaries are unchanged. This is missing diagnostic coverage,
not a confirmed repair of the underlying contention. Hub only, no migration;
recovery is a CI-validated beta Hub reverting the change.


## Unreleased: Agent catalog reads recover one lost response

HUB-B4 exposed an Agent catalog read that held a member lock and failed after
a lost PostgreSQL response. Membership, visibility and pagination now share
one placed single read; machine and quota enrichment uses its own directory
single read. Each retries a lost response once on a fresh connection, while
a second failure remains visible. Nonmember rejection, private projections,
mutation locks and unknown-COMMIT reconciliation are unchanged. Hub only, no
migration or native update; recovery is a CI-validated beta Hub reverting
this change. See [PostgreSQL recovery](operations/postgres-hyperdrive-origin.md).

## Unreleased: A skipped check cannot announce that CI passed

A pull request with a merge conflict did not start CI, but its skipped
external-PR closer alone made the conversation hear "CI passed". The GitHub
check reader now requires a check that actually concluded success before
announcing a passing verdict. All-skipped or all-neutral checks stay pending;
failures still report, and success beside skipped jobs still passes. Hub only;
no schema or client migration. Recovery is a CI-validated beta Hub release
reverting this verdict change.

## Unreleased: The Intel CLI builds on an Intel runner

GitHub's ARM64 runner capacity shortage cancelled both macOS CLI jobs before
assigning them a machine. The Intel target now uses the standard
`macos-26-intel` pool; ARM64 keeps `macos-26` and its native executable probe.
Desktop also stays on Apple Silicon to retain its signed ARM app startup
check. Target architectures, pinned Rust, Developer ID identity and R2 byte
verification retain their existing gates. Qualification is a complete beta
with both native CLI version probes and publication verified. Historical tags
retain their original workflow; recovery is a CI-validated forward release
restoring the Intel build host if needed. No client or schema migration.


## Unreleased: Sentry event claims reconcile an unknown COMMIT

HUB-BY lost the response to a Sentry recovery claim's COMMIT, leaving its jobs
leased until expiry. Claims now assign independent lease nonces before their
transaction. After an unknown COMMIT, one lock-free read returns only this
invocation's committed, unexpired leases and live receipts. It never repeats
the claim; absent results retain minute/expiry recovery, and read failures
remain visible with the original commit evidence. Current grant checks also
recover one lost read on a fresh connection. Capacity, grant and lease fences,
and delivery idempotency stay intact. Hub only, no migration or client change;
recovery is a CI-validated beta Hub release reverting this change. This repairs
the recovery gap without attributing the underlying connection termination.

## Unreleased: Agent binding refusals identify the failed comparison

HUB-C1/C2 duplicated one handshake refusal without identifying which binding
comparison failed. The Hub now reports one event with a fixed comparison source
and field, available through the Sentry issue reader and correlated with the
socket's diagnostic reference. Credentials, names, routing ids and compared
values are excluded. This supplies missing diagnosis, without attributing the
original mismatch. Existing refusal codes, retry policy, failed-handshake close,
connection claims and strict authority checks remain unchanged. Hub only; no
schema or native change. Recovery is a CI-validated beta Hub reverting the change.
