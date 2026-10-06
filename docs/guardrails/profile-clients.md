Part of the descriptive project profile. Not policy. The index is `project-profile.md`. The ten guardrails in `project-guardrails.md` override this file.

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
browser; this does not add transcoding, DRM, streaming manifests, or third-party
website embeds. Coverage is in `multimedia-attachments.spec.ts` and
`attachment-media-type.test.cjs`.

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
