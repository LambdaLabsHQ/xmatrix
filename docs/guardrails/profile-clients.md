Part of the descriptive project profile. Not policy. The index is `project-profile.md`. The ten guardrails in `project-guardrails.md` override this file.

## CLI Configuration Diagnostics

`xmatrix config` displays session metadata with `token` and `refreshToken`
replaced by `[redacted]`. Selecting either key uses the same redacted view;
other keys and missing-key diagnostics retain their existing behavior. Reading
configuration never modifies the stored credentials. Consumers must use the
authorized session APIs rather than parse diagnostic output for credentials.

## SQL Syntax Validation

The ordinary `@xmatrix/db check` runs PostgreSQL 17 syntax validation through the
pinned `libpg-query` WASM parser. It checks static named SQL, migration statements,
and assembled Channel capability predicates, CTEs, single-Channel gates, and
catalog query variants. It needs no PostgreSQL server or credentials. Existing
behavioral tests cover authorization semantics; parser checks do not validate
relation names, column types, query plans, or SQL inside quoted procedure bodies.

### Native Web startup

The shared list shell loads the ProseMirror document editor only when a document
opens. Foreground restoration refreshes authorized Channel catalogs and selected
history independently of an apparently OPEN socket; recent resume events are
coalesced. Flat catalog activity refreshes also cover Channels outside the loaded
page. See [Channel startup performance](../performance/channel-startup.md) for
verification and the limits of browser measurements versus iOS process restart.

Desktop automatic Channel selection now keeps background reads behind initial
history, with the existing bounded escape hatch; mobile list-only startup remains
catalog-driven. Catalog pages bound optional Runtime presence to 250 ms and omit
unavailable presence instead of clearing a hydrated roster. Web displays unknown
Human presence without an offline claim. These are presentation and scheduling
changes, not permission or durable-authority changes. See
[Channel startup performance](../performance/channel-startup.md).

The shared Web shell prioritizes the first Channel-list page as well as direct
Channel history before loading background workspace/Agent/machine data. Admission
observers remain independent of account-query replacement, while private queries
remain account scoped. The Web asset boundary supplies immutable caching for
hash-named JS/CSS only. See [Channel startup performance](../performance/channel-startup.md).

The iOS shell is one WKWebView. Native tab taps switch the web shell's mounted
dock panes, so tabs never reload or rebuild. See the [iOS shell](../../apps/ios/README.md).

The shared shell subscribes to live Channel presence by Channel key; catalog
and message-reference snapshots stay stable across presence-only changes.
Ordered Instance/card/snapshot batches share member/global Instance routing
and publish once before message, history and control barriers. Completed runs
publish small live replacement batches, retaining immutable full commits for
catalog and ordering changes, without a second full collection reconciliation.
Routing and Channel positions pass only to the exact next published snapshot;
a sealed producer cannot change it again. The work dock selects only its rendered
presentation; activity-only reports do not commit its cards. Trace and lifecycle
actions resolve the exact current Instance key when executed, including a second
confirmation press. A Run's
presentation stays in its own Channel while account quota remains shared.
See [live Instance load](../performance/channel-startup.md#live-instance-load).

### Markdown autolinks

Web message bodies, Markdown attachments and page previews use the same GFM
renderer extensions. Bare HTTP(S) and `www` links end at CJK prose punctuation,
so a closing parenthesis or following sentence does not become part of the
destination. Explicit Markdown links, reference links, angle-bracket autolinks
and code retain their authored content. Unicode paths and percent-encoded
punctuation remain supported; an intentional URL containing literal CJK
punctuation can use an explicit link. This is a Web rendering correction;
stored message and page bodies and protocol schemas do not change. Regression
coverage is in `apps/web/src/lib/markdown-plugins.test.cjs`.

### Timeline media playback

The shared timeline plays video and audio attachments using native HTML media
controls, backed by Chromium in Electron. Generic MIME attachments use known
media filename extensions for presentation; specific MIME metadata takes
precedence. Existing immutable references and authenticated media loading are
unchanged. HTTPS links to direct audio/video files offer a reader-initiated
preview; external media is not contacted before that click. Playback failure
keeps a download or original link available. Codec support depends on the host
browser; playback does not add DRM, streaming manifests, or third-party
website embeds. Coverage is in `multimedia-attachments.spec.ts` and
`attachment-media-type.test.cjs`.

The shared Web composer compresses videos above 1 MB before upload using native
WebCodecs through a lazily loaded Mediabunny converter. It fits the longest edge
within 1280 pixels and targets 2.5 Mbps, preferring H.264 MP4 with a WebM fallback.
Audio and video track counts and packet presence are checked in the result;
unsupported codecs, missing/empty result tracks, failures, a two-minute
deadline, or a result that is no smaller retain the original. Removing a pending
attachment cancels conversion. Metadata describes the uploaded result.
Removed draft attachments and cancelled uploads release their local preview URLs,
including while awaiting
video metadata or an earlier file in the same batch.
Each image and video preview has its own **Original** checkbox once preparation
finishes. Checking it prepares the retained local source without compression;
unchecking it restores automatic compression. Choices are independent and stay
with the in-memory Channel draft. Originals retain their bytes, filename and
MIME type, subject to the existing 64 MiB attachment limit. Images otherwise keep
the 1 MB compression target. A quality change blocks sending until it finishes,
preserves attachment order and restores the previous file on failure or cancel.
Local source files remain browser-only and are excluded from send snapshots and
message bindings. Failed image compression still permits choosing Original on
that preview.

### Registration-backed Channel presence

Channel catalog presence uses the Instance actor for registration-backed Runs,
matching Runtime presence and message sender identity; every Run is registration-backed.
Registration launch selectors are not Channel presence keys;
using them would duplicate an Instance when the live overlay arrives. The change
is a Hub projection correction with no persisted identity migration or protocol
schema change; refreshed Channel snapshots replace the old projection. Regression
coverage combines database catalog output with live updates and disconnects.

### Ordinary Run page context (2026-09-30)

Ordinary Runs consume linked pages through `xmatrix page linked` and refresh specific
pages with `page read`; they no longer receive an automatically materialized page
mirror. This removes idle 15-second requests and file rewrites without adding push
subscriptions or mandatory launch reads. The Machine Daemon pages endpoint remains
compatible with older daemons; savings require the new CLI/daemon to be installed.

### Workspace search

The Web shell uses Cmd/Ctrl+F for search in the current Space. In a conversation,
the shortcut starts with an `in:` filter; search buttons start across the Space.
Desktop conversation headers place actions beside the title and a borderless
search icon at the right edge of the same row. A docked conversation uses that
header entry too. Other destinations retain their global search entry and mobile keeps
its top-bar icon. Cmd/Ctrl+P quick-open is removed.

The dialog combines name navigation with server-backed message and page search.
Enter opens `/app/:spaceId/search` with the query and `in:`/`from:` filters in the
URL. Message hits include sender, timestamp and a link to the original message;
continued scans use the server resume token. Message-search failures are shown
explicitly, without local cached message results. Hub accepts optional Channel
and sender filters behind the existing authorized Space search boundary. These
additive fields support coordinated Hub and Web deployment.
