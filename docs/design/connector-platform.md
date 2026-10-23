# Connector Platform

Google Ads advertising configuration, selected-customer scoping, activation
budget checks and stable native acceptance are specified in
[Google Ads connector](../connectors/google-ads.md). Its separate `adwords`
grant reuses the company Google client; API access is held by that Cloud project,
not by a retired developer token. Both advertising write actions default to ask.

Status: implemented platform. Each provider's registration, production release
and native acceptance are tracked separately; availability in the registry does
not imply a passed native acceptance test.

X uses one company OAuth application with up to four separately owned user
grants per Space. Stable account ID and authorization generation bind every
approved publication; account refresh uses durable credential-store leases.
Video commands persist frozen input and encrypted outcomes in PostgreSQL; a
scoped Durable Object alarm stores scheduling references only and performs the
transfer independently of the submitting HTTP/CLI connection. Started jobs
never replay uncertain provider writes; result delivery uses a stable Channel
append identity. See the [alarm lifecycle](https://developers.cloudflare.com/durable-objects/api/alarms/)
and [invocation limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
The consent, Channel visibility, ownership and native acceptance contract is in
[X connector](../connectors/x.md). Quote posting requires X Enterprise API access.

## 1. Goal

The Google Cloud operations provider is documented in
[GCP connector](../connectors/gcp.md), including its separate OAuth grant,
bounded resource/cost reads, direct App Optimize reports, SKU attribution, daily or credential/method API usage, secret-free key metadata, bounded audit-principal summaries and explicit IAM-checked quota projects, BigQuery charge bounds and task resume, explicit
temporary report/API enablement writes, Monitoring authentication and native acceptance.

Turn the GitHub-only App connector into a provider-neutral platform. Then use
that platform to connect every provider we can reach without per-provider
special cases in the Hub.

xMatrix does not try to win on connector count; MCP and plugin markets cover
the long tail of "an agent calls an API". A connector exists only for what an
agent cannot do alone:

1. **Inbound events.** External events reach a Channel or fire a page
   Automation. This needs an always-on Hub endpoint.
2. **Credential custody.** The Space holds the credential, and each Channel
   grants actions separately. Tokens never enter an agent environment
   (guardrail 2).
3. **Visible approval and audit.** Every write is a Channel-visible execution
   that a human can see and approve.

Non-goals: a general iPaaS, user-authored provider code, or storing provider
tokens anywhere except the connector credential store.

## 2. Current implementation

The shared platform registers providers through protocol manifests and Hub-side
modules. GitHub retains its typed repository authority adapter; other providers
use the connector registry. The later sections define provider-specific bounds.

| Layer | Owner | Current contract |
| --- | --- | --- |
| Manifest | `APP_CONNECTOR_PROVIDER_MANIFESTS` in `@xmatrix/protocol` | Provider IDs, OAuth, credential fields, action effects/usage and default policies are shared with clients |
| Executor | `ConnectorProvider` and `platform-providers.ts` | Provider-owned parse/prepare/execute, authenticated Check and bounded outbound HTTP |
| Commands | `connector-commands.ts`, `connectors/usage.ts` | A command runs only from a committed Channel message, whoever wrote it; Agents read what they can send with `xmatrix connector list` |
| Policy and approval | Scoped connector repositories and approval routes | Channel allow/ask/disallow, frozen per-request approval and fresh authorization before writes; Agents cannot change policy |
| Credentials | Encrypted connector credential repository | Per-Space provider grants; company app secrets remain Hub-held, and OAuth refresh failures do not become wider grants |
| Inbound | Generic event ingress plus provider-specific native routes | Authenticated deliveries normalize to typed source/event identities and route through explicit subscriptions |
| Automations | Provider event triggers | Normalized connector events can wake linked page Automations; a scheduled report is not a native provider webhook |
| Google Ads | Separate `googleads` grant and selected advertiser | Bounded reads, atomic advertising configuration, validation-only calls and explicit, policy-controlled activation |

Connection records and execution receipts contain metadata and bounded outcome
evidence, not raw credentials. Production changes follow the normal immutable
release train. Provider registration, Check, actual writes, revocation and
native event/serving evidence remain distinct acceptance requirements.

## 3. Architecture

```text
             ┌────────── Provider module (one per provider, hub/src/connectors/<id>/) ─────────┐
             │ manifest · auth adapter · actions{schema, execute} · events{verify, normalize}  │
             └──────────────────────────────────────────────────────────────────────────────────┘
inbound:  provider webhook ─► Ingress route ─► verify ─► normalize ─► ConnectorEvent
                                                   ├─► relation routing ─► Channel message (app author)
                                                   └─► Automation trigger {kind:"event"}
outbound: Channel message "@provider:action text" (a person, or an Agent's `xmatrix send`)
            ─► parse ─► policy(channel×action) ─► allow ─► execute ─► execution record + receipt replying to the message
                                                  ├─► ask ─► approval card ─► execute
                                                  └─► disallow
```

### 3.1 Provider module contract

```ts
interface ConnectorProvider {
  manifest: AppConnectorProviderManifest;           // data, shared with web via @xmatrix/protocol
  auth: ConnectorAuthAdapter;                       // github-app | oauth2 | api-token | webhook-only
  actions: Record<string, ConnectorAction>;         // empty for event-only providers
  events?: ConnectorEventSource;                    // absent for action-only providers
  completion?: ConnectorCompletionSource;
}
interface ConnectorAction<I = unknown> {
  input: JsonSchema;                // bounded
  effect: "read" | "write";         // sets the default policy
  parseCommand(text: string, ctx): I | ParseError;   // `@provider:action …` → input
  execute(ctx: ConnectorActionContext, input: I): Promise<ConnectorActionResult>;
}
interface ConnectorEventSource {
  verify(request: Request, rawBody: string, secret: ConnectorCredential): Promise<boolean>;
  normalize(rawBody: string, headers: Headers): ConnectorEvent[];   // pure, unit-testable
}
interface ConnectorEvent {
  eventId: string;          // provider delivery id, used for dedupe
  sourceRef: string;        // e.g. sentry:project:acme/web, linear:team:ENG
  feature: string;          // manifest-declared event vocabulary, e.g. "issue.created"
  summary: string;          // one line
  body: string;             // bounded markdown posted to the Channel
  url?: string;
  attributes: Record<string, string>;  // bounded, used by trigger filters
}
```

The Hub keeps one registry, `CONNECTOR_PROVIDERS: Map<id, ConnectorProvider>`.
Generic code (command dispatch, ingress, policy, execution records, Automations)
never branches on a provider id. GitHub becomes the first module. Its
App-installation auth and app-wide webhook stay special inside its own module.

### 3.2 Connections and credentials

Platform OAuth application credentials are GitHub `production` environment
secrets named `CONNECTOR_<ID>_CLIENT_ID` and `CONNECTOR_<ID>_CLIENT_SECRET`.
The tagged Hub deploy injects configured pairs with its protected secrets file;
missing pairs preserve existing Worker settings, while partial pairs, whitespace,
and pasted authorization URLs fail before deployment. Registering or rotating an
application requires the normal Production Release Intent and release train.
Space connection tokens remain separate encrypted connection credentials.

One-click connects verify current owner/admin membership in the target Space
before signing state or creating a Composio account. The signed, expiring state
binds the provider, Space and initiating admin. The provider's redirect to `/api/connectors/oauth/callback`
carries no xMatrix session, so the Hub only checks the state there and hands the
grant to the app's `/connect/oauth` page. That page completes it with
`POST /api/connectors/oauth/complete` as the signed-in user, and the Hub
exchanges the code only when that user is the admin named in the state and
still holds owner/admin authority in that active Space. The credential write
checks that authority again after the provider request. A
connect link sent to someone else therefore cannot store their provider account
in the sender's Space.

GitHub App authorization uses the same authenticated completion page and POST,
after its separate `/api/auth/callback/github` redirect verifies `xmgh.` state.
That anonymous callback exchanges no code and links no installation. Completion
checks the initiating Human and current target-Space admin role before GitHub
installation discovery. Discovery names only installations that person
administers on GitHub: their own account's, or an organization's whose every
covered repository they administer. Reaching an installation through one
repository is membership, not authority to hand all of it to a Space.
Installation-selection grants use purpose `github-grant:v4` and carry the
GitHub user id `/user` returned; earlier grants require fresh consent. Linking
records that user (`app_github_installation_links`), and every later use of a
repository through the installation requires them to administer it then.

Google Docs & Drive uses one `google` connection and the canonical platform pair
`CONNECTOR_GOOGLE_CLIENT_ID` / `CONNECTOR_GOOGLE_CLIENT_SECRET`. The web-server
authorization-code flow requests only `drive.file`, offline access and consent;
the Hub requires a provider-confirmed per-file scope, refresh token and bounded
expiry. Tokens stay in encrypted Space credentials. Refresh errors stop before
actions, and the existing credential-version CAS prevents a refresh from
overwriting a concurrent reauthorization. Check reads Drive `about` with only
`user(permissionId)` and does not persist the account response.

`@google:read_doc:<id or Docs URL>` reads a bounded plain-text body excerpt
across tabs and tables; images, formatting, headers and footnotes are omitted,
and truncation is explicit. An optional `#tab=<id>` selects a tab.
`@google:list_files:*` lists at most 20 app-authorized Drive files.
`@google:create_doc:new <title>` creates a blank Doc, and
`@google:append_doc:<id>[#tab=<id>] <text>` appends at the tab's end (first tab
by default). Both writes use the Channel's existing action policy and are never
automatically replayed. A denied file id or URL cannot widen the Google grant;
provider errors stop the operation. Retrieved text remains untrusted content.

Per-file access covers app-created files and files explicitly opened with the
app. OAuth alone does not authorize arbitrary existing documents. The Google
Picker flow in Apps lets a Human Space admin authorize a separate browser-owned
`drive.file` token through Google Identity Services, select a Google Doc or Sheet, and
confirm it with the Space's server-held grant. The browser sends only the file
id to Hub. Hub verifies current owner/admin membership, configured connection,
Google's file identity/type/app-authorization, and that the credential version
still matches after the provider call. A stale or different-account selection
fails closed. No Space OAuth token or client secret is exported; the temporary
selection token remains in browser memory/Google's Picker and is discarded when
the selection ends, times out, or the component leaves the Space. Cancellation
does not revoke the app-wide grant or replay a write. Confirmation returns only
the selected file's id/name/type and canonical Docs/Sheets URL; it does not store a
second file-access authority or automatically post document contents.

Enable Docs, Drive and Picker APIs on the company's registered Google project.
The public browser Picker key must be restricted to Picker/Drive APIs and the
`https://xmatrix.sh/*` and `https://docs.google.com/*` referrers. Configure the
canonical `CONNECTOR_GOOGLE_PICKER_API_KEY` / `CONNECTOR_GOOGLE_PICKER_APP_ID`
pair (project number) alongside the OAuth pair through the formal release path.
External Testing status and real selection/OAuth/read/write acceptance remain
separate from implementation and require actual Google verification.
See [Drive per-file scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[Docs tabs](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get),
and [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).
The browser flow follows [Google's Picker sample](https://developers.google.com/workspace/drive/picker/guides/web-picker-sample)
with incremental scope union disabled and [Picker disposal](https://developers.google.com/workspace/drive/picker/reference/picker.picker.dispose).

Google Search Console is a separate `googlesearchconsole` connection with its
own token. It signs in with the same company Google OAuth client
(`CONNECTOR_GOOGLE_CLIENT_ID` / `CONNECTOR_GOOGLE_CLIENT_SECRET`) but requests
`webmasters` and `siteverification`, offline access and consent. New connections
require both provider-confirmed scopes; existing webmasters-only grants remain
refreshable and retain Search Console access. Verification actions require the
provider-confirmed managed `oauthScopes` field and tell older connections to
reconnect. A refresh never upgrades a grant. The signed state names the provider,
so a Docs state cannot complete a Search Console connect.

The connector covers all Search Console API methods: property list/get/add/delete,
sitemap list/get/submit/delete, Search Analytics query, and URL inspection. Adding
a property does not verify ownership. Site Verification covers token retrieval,
verification, resource list/get, owner-list replacement, and removal of the
connected account's ownership. Domain properties use DNS_TXT or DNS_CNAME; URL
properties use FILE, META, ANALYTICS or TAG_MANAGER. Token retrieval returns only
the public verification record. Publishing that record is a separate DNS or
website operation; this connector never follows provider-supplied links or writes
to a website. Resource ids are opaque encoded path segments. Owner replacement
explicitly replaces the entire list; Google protects the caller's ownership and
requires removed owners' tokens to be removed beforehand.

`query` retains concise defaults `by=query days=28 limit=25 type=web` and also
accepts validated API JSON with explicit dates, all supported dimensions,
dimension filters, startRow, aggregationType and dataState (including hourly_all).
Dates use Pacific calendar days. Calls return at most 250 rows within the shared
response-size bound; paginate explicitly with startRow. Google returns top rows,
not a guaranteed complete export. URL inspection includes the bounded full
inspection result, including rich results and referring URLs.

All actions follow the existing Channel policy: an explicit deny blocks execution.
Page/sitemap URLs must belong to the exact property before any provider call.
Search Console has no webhooks; schedule a page Automation for recurring reports.
Enable both Search Console and Site Verification APIs on the company Google
project and configure both scopes in its consent screen. External use beyond
Testing users must meet Google's verification requirements.
See [Search Console API](https://developers.google.com/webmaster-tools/v1/api_reference_index)
and [Site Verification API](https://developers.google.com/site-verification/v1).

Google Analytics is a separate `googleanalytics` connection on the same
company Google client, holding only
`https://www.googleapis.com/auth/analytics.readonly`; like Search Console, the
Hub requires exactly that scope on exchange and refresh. Check reads one
account summary without storing it. Reads: `list_properties:*` (Admin API
account summaries) and `report:<property id> [by=<up to three of date,month,page,channel,source,medium,country,device>|none] [days=1-1095] [limit=1-250] [channel=organic|direct|referral|social|paid|email]`
(Data API `runReport`; sessions, users, engaged sessions, engagement rate and
key events; defaults `by=date days=28 limit=50`). `channel=organic` filters on
the session default channel group "Organic Search", so a report lines up with
Search Console clicks. There are no inbound events and no writes. Enable the
Google Analytics Admin and Data APIs on the company Google project and add the
scope to its consent screen; it is a sensitive scope like `webmasters`.

Google AdSense is a separate `googleadsense` connection on the same company
Google client, holding only `https://www.googleapis.com/auth/adsense.readonly`.
It reads accounts, sites, ad units, reports, payments, alerts and policy issues
through the AdSense Management API v2 and has no writes or inbound events. The
contract, including what the API cannot read, is in
[the AdSense connector document](../connectors/google-adsense.md).

Bing Webmaster Tools (`bingwebmaster`) saves the account's API key (Settings →
API access); Bing accepts it only as the `apikey` query parameter of its JSON
API, so the Hub never echoes a request URL into a summary or error. A site is
the exact URL Bing lists (`https://example.com/`). Reads: `list_sites:*`,
`traffic:<site>` (daily clicks and impressions), `queries:<site>` and
`pages:<site>` (top 50 by clicks), `crawl_stats:<site>`. Writes, under the
Channel's action policy: `submit_urls:<site> <url …>` (at most 100, all inside
the site; the reply carries the remaining quota), `submit_sitemap:<site> <url>`
and `indexnow:<site> <url …>`. IndexNow needs no account: the connection keeps
the site's own IndexNow key, which the site publishes at `/<key>.txt`; the
Hub posts the URLs to `api.indexnow.org`, which shares them with Bing, Yandex,
Naver, Seznam and the other participating engines. Either credential may be
saved alone; Check reads the site list when an API key is saved. Bing also
offers OAuth for Webmaster Tools, but a company app needs its own registration;
the API key keeps the connection per account without one.

App Store Connect (`appstoreconnect`) saves an App Store Connect API key: its
Key ID, the team's Issuer ID (none for an individual key) and the `.p8` private
key, pasted as text with or without its line breaks. The Hub signs a ten-minute
ES256 token per action and calls only `api.appstoreconnect.apple.com`; a
pagination link to any other origin is refused. An app is its bundle ID and a
version its version string (`1.2.0`, or `macos/1.2.0` off iOS). Reads:
`list_apps:*`, `status:<app>`, `builds:<app> [version]`,
`read_version:<app> <version>` and `reviews:<app> [unanswered]`. Writes take an
uploaded build to the store, each step reading Apple's state first so a repeat
changes nothing: `create_version` (or renames the one version still open for
editing, never downward), `set_metadata` (one language's listing text, checked
against Apple's limits before any call), `set_build` (only the exact processed
build, read back after binding), `submit`, `cancel_submission`, `release`
(only from Pending Developer Release; `phased` enables a 7-day rollout first,
then `pause_phased_release`, `resume_phased_release` and
`complete_phased_release`; Apple cannot undo the release) and
`reply_review`. `submit` reuses an open draft submission with whatever else
the team put in it, and refuses while another submission is with App Review or
waits for an answer. App Review contact and sign-in details never pass through
a Channel: `create_version` copies them from the app's previous version, Apple
to Apple, read actions do not request the password or notes, and calls that
carry them report only Apple's error code. Events: subscribing a Channel to a
bundle ID makes that app have one webhook named `xMatrix · <Space id>` pointing
at the connection's ingress with the generated secret, and the Space's last
unsubscribe deletes it; webhooks with other names are never touched. Apple
signs each delivery as `x-apple-signature: hmacsha256=<hex>`. A payload names
a version or build and never the app, so the registered URL carries
`?app=<bundle id>`; `*` routes webhooks the team configured itself. What a
new app needs once before its first submission is kept per app: `read_app`
prints names and privacy policy per language, categories, age rating answers,
content rights, price and availability in the shape the writes take back.
`set_app_info`, `set_age_rating`, `set_price` and `set_review_contact` write
them; app info and the age rating go to the app info that is not live. Age
rating answers are the developer's declarations to Apple, so each is checked
against Apple's vocabulary and none is defaulted. `set_review_contact`
refuses a sign-in password, which is entered in App Store Connect, and its
receipt names the fields it set and never their values. Out of reach of the
API and left to a person: creating the app record, the App Privacy answers,
agreements, and replying to App Review; Apple's specification (4.5.1) has no
resource for them.

App Review's messages are read through the App Store Connect website's own
`iris` endpoints, which take a signed-in web session instead of an API key.
The connection keeps that session as one optional credential, `webSession`:
the Cookie header of a signed-in appstoreconnect.apple.com page. Every request
goes from the Hub, so no machine has to stay on, and only to Apple's website
origin under `/iris/v1/` or `/olympus/v1/`, without following redirects, which
mean Apple wants a new sign-in. Cookies Apple rotates during a call are saved
back into the same credential once, as the Hub's own write through the action
context's `saveCredentials`. The session never goes to the public API, and the
API key's token never goes to the website. `review_messages` reads the newest
thread's rejection reasons (section, description, code) and messages as plain
text, fenced as untrusted; `web_session` says whose session it is.
`create_app` sends the website's own app-record creation (the record, its app
info and first version with their localizations, as fastlane's `produce`
does) after the API key confirms the bundle ID is registered and has no app;
`set_privacy` deletes the app's App Privacy answers, sends one per data type,
purpose and protection, and publishes them, after checking the ids against
the website's current lists; `privacy` reads them back. Writes carry the
website's `x-csrf-itc` header, are sent once and never retried, and a
`set_privacy` cut short says how far it got. A refusal comes back in Apple's
words; a 401, a redirect or a bare 403 means the session lapsed. The Apple
ID password never reaches xMatrix: the desktop app signs in on Apple's own page
in a window with a profile of its own (`signIn` on the credential field,
`apps/desktop/src/sign-in-services.ts`) and hands the page the cookies that
window then holds for appstoreconnect.apple.com; the page saves them like any
typed credential. Apple keeps the session from a day to a month, and signing in
again is the only renewal. These endpoints are not a published contract and
can change without notice.

Files reach Apple in three steps, so the bytes never pass through the Hub and
the machine that has the file needs no API key: a reservation
(`upload_build`, `upload_screenshot`), whose receipt lists each part's method,
URL, byte range and headers; the upload itself, straight to Apple's storage;
and `commit_upload`. The part URLs are Apple's own time-limited capability for
that one file. They are shown byte for byte as Apple signed them, after the
Hub has checked that each is https on a public host with plain header lines;
`read_upload` lists them again and pages a long plan, and `delete_upload`
removes a reservation that will not be used. An upload is named by one id
throughout: the build upload's or the library image's. `upload_build` uses the
Build Uploads resource, which needs no `altool` or Transporter, and
`build_uploads` reads Apple's processing verdict with the errors it would
otherwise only email. `declare_encryption` answers export compliance for one
build, explicitly. Screenshots use the App Asset Library, which API 4.5.1 made
the replacement for the deprecated screenshot sets: an image is uploaded once
into the app's library and `set_screenshots` makes one language and placement
group of a version show exactly the named images in order, deleting placements
before creating so a full group has room. Placement groups and their exact
sizes are read from Apple's reference data (`screenshot_specs`) and never
written down, because Apple adds device families without an API change.
`set_availability` creates a first availability in one request that names
every territory, and changes an existing one territory by territory, at most
25 per statement. `submit` on a submission App Review rejected marks its
rejected items resolved and sends it back, which is what Resubmit does in App
Store Connect; `cancel_submission` followed by `submit` starts over instead.

Signing for distribution needs no Apple ID on the build machine. The machine
makes a private key and a certificate signing request; only the request is
pasted to `create_certificate`, and Apple's certificate comes back through
`read_certificate`. `create_profile` ties a certificate to a bundle ID for the
App Store, and `read_profile` returns it. Certificates and profiles are public
documents; the private key never leaves the machine that made it.
`create_certificate` makes one call and never retries, because a team holds
only a few distribution certificates, and nothing here revokes a certificate or
deletes a profile. `register_bundle_id` and `enable_capability` complete the
setup, and `signing` shows all of it; Apple's bundle ID filter also matches
longer identifiers, so the exact one is picked here. TestFlight: `testflight`
shows tester groups and each build's testing state, `add_to_group`,
`submit_beta_review` and `set_test_notes` distribute a build, and `feedback`
and `crash_log` read what testers sent after a `feedback` event. Tester
comments and crash logs are fenced and bounded, feedback image links are shown
only when plain https on a public host, and a tester's email address and name
are never requested.

Google Business Profile (`googlebusinessprofile`) is another connection on the
company Google client, holding only `https://www.googleapis.com/auth/business.manage`
(Google offers no read-only scope for these APIs). Reads: `list_accounts:*`,
`list_locations:<accounts/1>`, `performance:<accounts/1/locations/2> [days=1-540]`
(Performance API daily metrics summed over a range ending three days ago, since
Google's figures lag) and `reviews:<location>` (My Business v4, still the only
reviews API; newest 50). The write `reply_review:<…/reviews/<id>> <text>` puts
the owner's public reply under the Channel's action policy. Check lists one
account. Google must approve the company Cloud project for Business Profile
API access (a request form, separate from OAuth verification) and the
Account Management, Business Information and Performance APIs must be enabled;
until then every call returns Google's 403.

PageSpeed Insights (`pagespeed`) has no OAuth: the connection saves one Google
Cloud API key with the PageSpeed Insights and Chrome UX Report APIs enabled,
sent only in the `x-goog-api-key` header. `audit:<page url> [strategy=mobile|desktop]`
asks PageSpeed Insights for a Lighthouse run; it reports category scores, lab
metrics, the worst 15 failing audits and the page's field data. Google rejects
a `fields` mask inside the audits map, so the audits come whole (typically
300–400 KB; only the full-page screenshot is masked out), and a run takes up to
a minute. This one call therefore waits up to 60 seconds and accepts up to
2 MB (`providerJson`'s `timeoutMs` and `maxBytes`, capped at 60 seconds and
4 MB); every other call keeps 10 seconds and 256 KB. Provider errors in Google's
`{"error":{"message":…}}` shape are reported with that message. `field:<page url or origin>`
reads the Chrome UX Report's 28-day p75 and good/needs-improvement/poor shares;
a bare origin, or `scope=origin`, reads the whole origin, and too little Chrome
traffic is reported as no data rather than an error. Check reads the Chrome UX
Report for a well-known origin. Google fetches the page, not the Hub.

Google report dimensions, Analytics channel aliases and CrUX form factors are
explicit vocabularies. `google-report.ts` resolves their bounded, distinct names
through `mappedChoices`; only own entries count as choices, and mapping happens
after validation. Each connector retains its vocabulary, defaults and usage
message, including dimension-free reports and the all-device CrUX form.

Yandex Webmaster (`yandexwebmaster`) saves an OAuth token of the Yandex
account (`webmaster:hostinfo`, plus `webmaster:verify` for recrawl), sent as
`Authorization: OAuth <token>`; a company Yandex app for one-click Connect is
not registered yet. Every call first reads the token's user id from `/user`,
which Check also does. A host is Yandex's id, `https:example.com:443`. Reads:
`list_hosts:*`, `summary:<host>` (SQI, pages in search, excluded pages, site
problems by severity), `queries:<host>` (top 50 popular queries by clicks).
The write `recrawl:<host> <page url>` queues one page of that exact scheme,
host and port, under the Channel's action policy.

Gmail content access signs in through Composio rather than the company Google client.
Composio's managed Google app is approved by Google only for its default
Gmail scope, the full `https://mail.google.com/` grant; requesting the
narrower `gmail.readonly` on it is what Google's app-blocked screen refuses
([Composio Gmail FAQ](https://docs.composio.dev/toolkits/gmail)). The auth
config therefore requests `https://mail.google.com/` alone, without the
default profile and contacts scopes, and the Hub is the boundary the grant
is not: every user-invoked Gmail action passes an endpoint list in `actions/gmail.ts`
(GET profile, message list and one message; POST messages/send) and any
other endpoint is refused before Composio is called. The only write, POST
messages/send, belongs to `send` and `reply`, whose manifest
`defaultPolicy: "ask"` stages an immutable email for a Space admin to approve
once in that Channel (§3.5). A read-only grant would need the company's own
Google app verified for `gmail.readonly` (OAuth verification and CASA).
One Gmail connection holds any number of mailboxes. Its only credential,
`mailboxes`, lists each mailbox's Composio account, address and owner: a
Space member (`user:<id>`) or an Agent registration
(`agent:<owner>/<machine>/<harness>`, each part URI-encoded). A member's
mailbox serves that member and their Agents' Runs; an Agent's serves only
Runs of that registration, resolved from the calling Instance through its
Run's admission, never from the Instance id. Every Connect adds a mailbox
owned by the connecting admin; connecting an address again replaces its
Composio account (the old one is deleted) and keeps its owner. Space admins
reassign or remove mailboxes in Apps → Gmail
(`/api/spaces/:spaceId/app-connections/gmail/mailboxes`); removing one deletes
its Composio account, and Disconnect deletes every one. Like X accounts and
Cloudflare logins, the list is one encrypted field that moves under the
connection's version check (`packages/hub/src/connectors/account-list.ts`):
entries are not counted, the field is stored up to 256 KiB, and a Connect that
would not fit is refused and its new Composio account deleted. Actions see only the
caller's mailboxes: `search:*` searches each (labelled by mailbox when there
are several) and `search:<address>` one; `read` and `reply` find the message
among them; `send` takes `from:<address>` when the caller has more than one.
Check reads every mailbox's profile. The `gmail` manifest uses `oauth.flow: "composio"`;
`CONNECTOR_GMAIL_CLIENT_ID` is the Composio auth config (Composio-managed
Gmail auth requesting only `https://mail.google.com/`) and the shared
`CONNECTOR_COMPOSIO_API_KEY` is the Composio project API key. Connect creates a Composio Connect Link for the
user id `xmatrix:<space>:<state nonce>` with the Hub callback carrying the
signed state; completion ignores redirect parameters and adds the single
ACTIVE account that per-attempt user id holds under that auth config to the
`mailboxes` credential. The API key never enters the
credential store; the Hub adds it when it resolves the connection. Every
Gmail call goes through Composio's proxy and names one stored account, never
the project default. Reads: `search:* [Gmail search]` returns the ten newest
matching messages (id, received time, sender, subject, snippet) and
`read:<message id>` returns the headers, the text body (plain text, else HTML
reduced to text, truncated at 8,000 characters) and every distinct http(s)
link the message contains, fenced as untrusted content.

Gmail `search` and `read` answer like every other action: the receipt that
replies to the command's message carries what they found, and the execution
record keeps its bounded excerpt. Whoever can read the Channel reads the mail,
so read mail in a Channel only the people who may see it are in. Search is
`@gmail:search:* <Gmail query>`, or a connected mailbox address in place of `*`.

This is not a secret-ingestion capability. Search snippets, headers and links
can themselves contain login credentials, before a full-message read. There is
no Gmail action that extracts a code into a Space secret without first publishing
the read result. Do not use search/read for credentials that must stay out of
messages; a closed Channel still stores messages and does not satisfy that rule.
Piping a published receipt into `secret set` cannot undo the disclosure.

The existing separate secret flow is a Run's `secret-add` request card, answered
by a current Human Space admin, then `secret exec` injection into a process that
does not expose the value. An Agent can also create a fresh secret from an
already-authorized local value through `secret set --value-stdin`; this supplies
no way to fetch mail privately and cannot overwrite an existing alias. An
automated Gmail-to-secret transfer is not implemented. Adding one would require
an explicit typed capability and secret-authority checks while keeping the
command and value-free outcome visible; a hidden connector MCP is not a fallback.
See the [operations guidance](../operations/app-connectors.md#qa-login-codes).

Inline
`multipart/mixed` body segments retain their order, choosing plain text or
rendered HTML for each segment without duplicating alternative versions.
Attachment parts and their descendants are excluded. Reads visit at most
200 MIME parts and report incomplete content when that limit is reached or
an inline text body is stored externally; they do not fetch attachments.
The Hub never
requests a link found in mail; an Agent that needs to confirm a sign-up opens
the link itself. `send:<address> <subject>\n<body>` sends one plain-text
message to one recipient, and `reply:<message id> <body>` answers the
message's Reply-To (else From) in its thread with In-Reply-To and References
set; header values are single-line and non-ASCII ones RFC 2047 encoded. There
is no label, delete, draft or settings action. Notifications are described below. Composio is a subprocessor for connected mailboxes.

Disconnect reads the grant through the credential authority's live Space
owner/admin check before any provider deletion. Member-visible connection
metadata is not authorization for that effect. Composio retirement happens
before clearing the stored grant, so a provider failure remains retryable;
the clear compares the credential version, connection version and generation
read before the provider request,
preserving a grant installed by a concurrent reconnect. Google disconnects
use the same authorized read and version comparison. The Hub-only credential
read remains for independently authorized executions and verified ingress.
See [Gmail API](https://developers.google.com/workspace/gmail/api/reference/rest).

#### Gmail notification signals

The default notification setup uses the existing company Google client and
registered connector callback, with a separate encrypted `gmail.labels` grant
plus basic OpenID/email identity access. Google userinfo verifies the selected
mailbox; existing Composio content tokens are not replaced. Minute cron checks
four INBOX counts. Changes durably wake confirmation through that same owned
Composio account's `/history` endpoint, restricted to inbox `messageAdded` IDs.
The Composio `/profile` endpoint supplies the initial cursor and expired-cursor
recovery. No message bodies are fetched. An independent incremental check is
due every 15 minutes after the last completed scan, even if counts stay equal.
Counter cancellation and provider delays are accepted best-effort limits;
zero-loss delivery and maximum delay are not promised. A pass claims at most
20 jobs and processes four concurrently. Cached access tokens remain encrypted
and are refreshed near expiry; revocation and stop erase them with the grant.

Optional native notifications use a separate Google OAuth client requesting
only `gmail.metadata`. They do not replace the Composio content grant or its
send/reply approval contract. Apps → Gmail lets a Human mailbox owner who is
also a Space admin turn notifications on for each of their mailboxes, which
authorizes notification access; it does not pick a destination. Like any
connector event, a conversation receives a mailbox's notifications after it runs
`@gmail:subscribe:<mailbox>` (or `*` for all of the member's mailboxes). Only the
mailbox's member and their Agents may subscribe it, and delivery takes only
subscriptions whose authority root is that member. Gmail events are produced by
the Hub, so the manifest declares `events.ingress: false` and no ingress URL is
minted. Agent-owned mailboxes are not supported by this first notification flow.
No Gmail forwarding configuration is needed.

Google watch publishes an email address and history ID to Pub/Sub; the Hub
checks Google's RS256 signature, issuer, configured audience, verified service
account and exact subscription before durably recording a wake. Only after an
event does it query Gmail history for inbox `messageAdded` identities. It never
queries the inbox on a timer. Daily watch renewal and retries of already accepted
work use the same bounded scheduled drain.
Renewal does not overwrite the consumed history cursor. Google does not provide
a seconds-level delivery SLA; notification gaps may require a later event, and
an expired history cursor establishes a fresh baseline and reports the gap.
Old mail is not replayed as new work.

The primary App authority stores the native refresh token and pending PKCE
verifier in an encrypted notification envelope bound to the route identity.
Configuration fingerprints, captured connection generation, credential version,
mailbox ownership and current Space admin fence work; each append is checked
against its subscribing member's conversation capability.
Mailbox removal, reconnection or ownership changes retire that mailbox's
notification rows and encrypted grants. Unchanged account/address/owner tuples
survive another mailbox's addition or edit only when all shared credentials are
also unchanged. The credential transaction advances retained rows to the new
credential version and clears old worker leases, preserving cursors and pending
IDs. A Channel move removes its subscriptions like any other source relation.
A shared credential replacement, disconnect, account erasure
or Space erasure retires all affected grants. Stop clears one local grant immediately;
it does not revoke a Google grant another Space might still use. Abandoned
OAuth attempts expire after ten minutes and bounded maintenance removes them.

Durable Gmail-ID receipts coalesce duplicate signals and make conversation
append idempotent. Notifications contain only a mail ID reference, never sender,
subject, snippet or body. Reading one is an ordinary `@gmail:read:<id>` command.
Page Automations use `gmail:message.received:<mailbox>`; only Automations whose
authority root is the mailbox owner fire. Credentials must be supplied
as an atomic optional group; partial configuration fails closed. Provisioning,
Google verification and production activation are separate operator steps in
[Gmail notifications](../operations/gmail-notifications.md).


Google Sheets uses the same per-file Google connection and `drive.file` grant.
`read_sheet:<spreadsheet id> <A1 range>` returns an explicit rectangle (up to
50 rows by 20 columns) as untrusted JSON, with formula text and formatted dates;
text above 12,000 characters is marked as truncated. `update_sheet` takes JSON
`{"range":"Sheet1!A1:B2","values":[["name","count"],["result",1]]}`; its matrix
must exactly cover that rectangle. Only scalar strings, finite numbers and
booleans are accepted, with no null/skipped cells. It writes `RAW`: formula-like
strings remain literal text. `create_sheet:new <title>` creates a blank
app-authorized spreadsheet. Writes have separate Channel policies, are sent
once, and require exact update receipts; ambiguous receipts ask the user to
check before retrying. Enable Sheets API on the same registered company project.
Picker now includes Docs and Sheets, returning a file kind so Apps offers the
appropriate read command. An older Docs-only Picker reply without a kind
continues to show a document read command; no access authority is inferred from
this UI field. Existing spreadsheets still need actual selection and live
provider acceptance; the action code does not grant arbitrary Drive access.
See [Sheets scopes](https://developers.google.com/workspace/sheets/api/scopes),
[values.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get)
and [values.update](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update).

Linear `read_issue:ENG-42` reads a single explicit issue's title, description,
state and first provider page of up to 20 comments. GitLab `read_issue:group/project#5`
and `read_merge_request:group/project!5` read the selected task plus up to 20
newest notes (including system notes). GitLab requests one extra note only to
detect that more were omitted; no subsequent pages are fetched. The excerpt
is capped at 12,000 characters, fenced as untrusted, and marks omitted text or
comments. Neither follows attachments/links or copies author/assignee profiles
into its result. Merge request code diffs are not included in this context read.

Jira `read_issue:ENG-9` uses the currently authorized Cloud site and one explicit
issue key. It reads title/state and a bounded plain-text ADF description, then
the newest provider page of up to 20 comments (21 requested to detect omissions).
The OAuth path confirms the connected `cloudId` and `read:jira-work` scope through
accessible resources before calling the fixed Atlassian API gateway; stale
manually supplied tenant URLs do not select OAuth scope. API-token reads require
the canonical `https://<tenant>.atlassian.net` origin. Redirects and arbitrary
hosts receive no credentials. ADF traversal is limited to 1,000 nodes, depth 12
and 12,000 text characters across the description/comments; omitted rich content
and text are marked. Account profile fields and ADF mention attributes are not
copied, and account mentions become anonymous `@user`. Free text remains customer
content; this does not claim a universal exemption from personal-data obligations.
The existing Channel read/deny policy applies, independently of write approvals.
See [Jira issue reads](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-get),
[comment permissions and pagination](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/#api-rest-api-3-issue-issueidorkey-comment-get)
and [ADF structure](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/).
PagerDuty `read_incident:Q1ABC2DEF` reads one explicit incident id, its title,
status and urgency, then at most 20 notes in provider order. It uses the existing
REST API key or Scoped OAuth against the fixed US/EU REST endpoint in two bounded GET requests;
no `From` identity is needed for this read. Numeric incident-number aliases are
not accepted. The returned incident id/type/status and its PagerDuty receipt
link must match before notes are fetched. Notes are returned by the provider
as one array; the bounded transport and a 1,000-entry shape limit fail closed,
and no paging, account profiles, arbitrary body details or linked resources
are fetched or copied. The 12,000-character untrusted excerpt marks omitted
notes/text. Existing acknowledge/resolve/note writes keep their independent
policy. Manual API-key writes require `From`; OAuth writes act as the consenting
user without a caller-supplied acting email. Native acceptance still requires
a company account and explicit test incident.
See [PagerDuty's official REST schema](https://github.com/PagerDuty/api-schema/blob/main/reference/REST/openapiv3.json).

Sentry `read_issue:WEB-1A` (or a numeric group id) reads one issue and its latest
event from the configured organization. Short ids require one lookup; numeric
ids use two GETs. The excerpt includes title/status/culprit/platform, occurrence
count and first/last-seen UTC times when valid, event UTC
time, release version, component/environment, SDK and browser/runtime name/version,
and whether the browser defect endpoint captured it. Its action is included only
when it is one of protocol's closed `ClientDefectAction` set, the same set the web
types its failure actions with; dynamic names and unknown action text are omitted. The excerpt also includes at most
three exceptions, each with the last 20 stack frames (module, function, filename
and line/column only). Exception `type` and `value` are included when they are
strings (including Sentry's annotated truncated-string form); a missing type or
value does not fail the read, and frames still copy. Each exception also includes
its mechanism type and handled/synthetic flags when present. Only these bounded
diagnostic fields are copied. When mapped frames exist, up to eight terminal
generated asset locations and line/column positions are retained separately so
the deployed script can still be identified. URL credentials, query strings,
fragments and inline script schemes are excluded from these generated locations.
A missing or empty mapped stack falls back to raw file locations and positions
with the same filtering. Arbitrary tags, contexts and mechanism data remain
private. Incomplete exception values
or frames are omitted. It is fenced as untrusted and capped at 12,000 characters;
omissions are explicit. Request bodies/headers, local variables, source context,
breadcrumbs, account profiles, attachments and linked URLs are not fetched or
copied. Missing events, revoked access and mismatched issue/event identities
fail the read. The Channel read/deny policy does not authorize status writes.
The registered OAuth app always uses `sentry.io` and its OAuth token, ignoring
stale manual URL/token fields for reads, writes and Check; manual tokens retain
their configured self-hosted origin. Malformed short-id lookup responses cannot
be used for a status write.

The Public Integration provider adapter exchanges the installation UUID's
one-use code at its fixed SaaS authorization endpoint, validates the complete
camelCase token pair, eight-hour provider expiry (bounded to one day) and exact
`event:read event:write org:read project:read` scope set, then GETs the installation before
marking a pending install `installed`. Both responses must match the configured
app UUID/slug, selected installation and explicitly reviewed organization; its
numeric organization id is retained with the managed grant. Check requires that
same installation to remain installed. Sentry's native Issue Read & Write permission
includes both event scopes; issue/event reads require `event:read`, while status
writes require `event:write`. The three-scope native grant is rejected, as are
extra or duplicate scopes; the legacy user-OAuth scope contract is unchanged.
Native reads and writes use this managed
organization, never a mutable manual field. Refresh uses the installation's
authorization endpoint and saves the complete rotated pair with credential
version CAS before another provider request. Missing context, changed app
identity, failed rotation and CAS loss stop execution; writes are not replayed.

`CONNECTOR_SENTRY_APP_UUID` and `CONNECTOR_SENTRY_APP_SLUG` are an optional pair
that also requires the canonical client id/secret. The formal deployment rejects
partial native identities before emitting its secret payload. A configured
Public Integration cannot use the legacy user-OAuth Connect button. Legacy
user OAuth and internal/manual tokens remain separate bounded paths. The native
Connect button opens Sentry's fixed external-install URL for the configured app.
Its callback is `/connect/sentry`; unsigned callback metadata never selects or
authorizes a Space. The native callback supplies `code`, `installationId` and
`orgSlug`. The old `sentryOrgSlug` spelling is accepted only without duplicate
or conflicting identities; the server still verifies the installation's actual
organization before connecting it. The page immediately removes the query, keeps the one-use
code only in memory, and requires a signed-in Human to select an owner/admin
Space and explicitly confirm replacement. A signed-out Human signs in in a
separate tab with a code-free URL. Confirmation makes one bounded POST to
`/api/spaces/:spaceId/app-connections/sentry/install`; uncertainty consumes the
local request and requires a fresh provider installation, never an automatic retry.

The PostgreSQL credential authority supports a verified-installation
write: a live Human owner/admin is rechecked, the original connection and encrypted
credential versions and immutable creation sequence are compared under row
locks, then the replacement grant,
installation/app binding, configured status and checked time commit together.
Human credential edits advance the connection revision too, fencing an empty
grant that was written and cleared during code exchange. Server refreshes keep
that connection revision and advance the binding with the credential version.
`initializeOnly: true` on a connection upsert prepares a missing row without
disconnecting or editing an existing grant; ordinary upserts remain unchanged.
Migration 0143 adds minimal installation lifecycle records, keyed by configured
client, app UUID and installation UUID. A server-only single-use attempt is
bound to its Human-selected Space for one minute, with provider token expiry
checked against the database clock (live and at most one day). Signature-verified
uninstall and completion serialize on that record. Uninstall clears attempts,
retires the exact installation, deletes its matching encrypted grants and
bindings, and disconnects at most 50 connections atomically. Overflow or failed
commit returns failure before mutation; repeated uninstall is idempotent and an
old UUID cannot disconnect a replacement. Native binding creation also enforces
the 50-Space ceiling before consuming a provider code.

`POST /api/connectors/sentry/events` authenticates the raw body with the app's
client-secret HMAC. Lifecycle identity/action come from the signed body, never
the unsigned resource, timestamp or request-id headers. Created lifecycle events
are acknowledged without persisting provider code or actor data; deleted events
are acknowledged only after retirement commits. Records contain no raw payload,
authorization code, token or actor profile. Attempts expire after one minute;
idle records expire after one day and retirement records after seven days.
Each lifecycle write removes at most 50 expired records for its configured app.
Cleanup cannot restore an old nonce: completion requires its original live
attempt, while a new attempt requires new provider installation proof.

Signed issue/alert app deliveries return 503 until durable ingress is implemented;
they are not acknowledged and discarded. Legacy per-Space webhooks remain
separate. Company Public Integration registration, general distribution and
native installation/uninstall acceptance remain unverified.
See [issue details](https://docs.sentry.io/api/events/retrieve-an-issue/),
[issue events](https://docs.sentry.io/api/events/retrieve-an-issue-event/)
and [Sentry's Public Integration installation example](https://github.com/getsentry/integration-platform-example/blob/main/docs/installation.md).

Requests use the connection's provider grant, verify returned task identity,
and obey the current Channel read/deny policy; existing comment/create/merge
writes still require their own policy. This enables explicit task context →
work → comment workflows without granting a write or selecting a whole project.
See [Linear issue queries](https://linear.app/developers/graphql),
[Linear pagination](https://linear.app/developers/pagination),
[GitLab issues](https://docs.gitlab.com/api/issues/),
[merge requests](https://docs.gitlab.com/api/merge_requests/) and
[notes](https://docs.gitlab.com/api/notes/).

Notion also exposes `read_page:<page id or official Notion URL>`. It reads the
page title and a depth-first plain-text body excerpt (nested blocks and table
cells), with hard limits of 12,000 characters, 300 blocks, nine provider calls
including page metadata, and eight nested levels. It follows only Notion block
ids and bounded API pagination, never external URLs or child-page/database
contents. Unsupported non-text blocks are marked as omitted; limit exhaustion
is reported as truncation. Retrieved content is fenced and untrusted. Current
Channel read/deny policy and the Space connection's provider grant still apply;
append/create remain separately governed writes. See [Notion block children](https://developers.notion.com/reference/get-block-children).

Notion's OAuth access and refresh tokens are stored together in the encrypted
connection credential row. A provider-supplied expiry is respected, but no expiry
is inferred when Notion omits one. Before using an OAuth connection, the Hub makes
an authenticated read of `/v1/users/me`. Its 401 permits one HTTP Basic/JSON refresh
and a second verification read; permission errors, timeouts, malformed pairs and
rejected refreshed credentials stop before a write. Both rotated tokens are
required and saved atomically with the credential version observed before the
refresh, so concurrent reauthorization cannot be overwritten. Append/create-page
requests are never automatically replayed. Existing connections that predate
refresh-token retention must authorize again to obtain a pair; manual integration
tokens retain their existing path. See [Notion authorization](https://developers.notion.com/guides/get-started/authorization).

Telegram Check calls `getMe` and requires a confirmed bot identity. It does not send a message or change webhook configuration; real inbound/outbound acceptance remains separate.

For API-backed connections, Check makes a read-only authenticated provider call:
Slack `auth.test`, Linear `viewer { id }`, GitLab `/api/v4/user`, Jira OAuth
`accessible-resources` (must include the connected cloud id), and Sentry's
organization list. Provider-level errors inside HTTP 200 responses and malformed
identity payloads fail the check. Returned account profiles are not persisted.
Secret-only event connections still require a real signed ingress delivery for
end-to-end acceptance; a stored signing secret alone proves no external setup.

Netlify uses the authorization-code flow with its registered platform application.
The Hub stores the returned token only in the encrypted Space connection and
checks it with `GET https://api.netlify.com/api/v1/user`. Existing webhook-only
connections continue to use their JWS secret; authorizing an account does not
itself provision a site's outgoing notification hook. API setup follows the
[Netlify API guide](https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/).


Vercel uses an external Integration installation initiated from the Space's
Connect button. The registered `xmatrix` slug receives signed Space/admin state;
the Hub exchanges the code using the server-held application credentials and
checks the returned installation with Vercel's configuration API. Configuration,
application and team scope come from the authenticated provider response, rather
than editable `teamId` fields. A callback completes only when its configuration
and team match that grant and its `next` URL has the exact `https://vercel.com`
origin. Disabled or removed configurations fail Check. Redeploy uses the OAuth
token and verified team; legacy manual tokens and signed webhook deliveries
remain supported. Unsigned Marketplace-initiated callbacks are rejected until
an authenticated Space-selection flow exists. Personal installations also retain
the provider-confirmed user id, checked against the current configuration.
Protocol references:
[Vercel's API integration guide](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations),
[external installation flow](https://vercel.com/docs/integrations/create-integration/submit-integration),
and [configuration API](https://vercel.com/docs/rest-api/integrations/retrieve-an-integration-configuration).

Discord validates the stored bot token with its current-user endpoint and
requires a bot identity. PagerDuty validates REST keys with the abilities
endpoint, which supports account-level keys without fetching a user profile.
Feishu/Lark validates an app pair by obtaining a tenant token without sending a
message. Both validation and sending restrict the API base to the official
Feishu or Lark origin; arbitrary custom API bases now fail before receiving any
app credentials. Webhook-only PagerDuty and event-only Feishu configurations
continue to rely on their real signed ingress acceptance tests.
References: [Discord current user](https://docs.discord.com/developers/resources/user#get-current-user),
[PagerDuty API schema](https://github.com/PagerDuty/api-schema/blob/main/reference/REST/openapiv3.json),
[Feishu tenant token](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal).


- Keep `data.app_connector_connections` and its `${spaceId}:${providerId}` id
  (one connection per provider per Space in v1).
- Widen `auth_mode` to `github-app | oauth | api-token | webhook-only`.
- New `data.app_connector_credentials (connection_id PK, kind, encrypted_value_json, value_digest, version, updated_at)`:
  - Encrypted with the existing secret-value material
    (`XMATRIX_SECRET_CATALOG_KEY`, same envelope as `data.space_secrets`).
  - Holds API tokens, OAuth access/refresh tokens and the per-connection
    webhook signing secret.
  - Write-only from every API. Only a provider executor, running in the Hub,
    decrypts it. Connection reads return `credentialConfigured: boolean`, never
    the value.
  - Deleting a connection deletes its credential row in the same transaction.
- OAuth providers whose platform app is not registered yet fall back to
  `api-token`. The manifest declares both, and the UI offers whichever is
  configured.

### 3.3 Inbound events

Per-connection webhook ingress reads the exact-source and wildcard subscriptions
concurrently, retaining each query's current connection checks and route bound.
Both lookups must succeed before any Channel append. Exact-source subscriptions
take precedence when a Channel also subscribes to the wildcard. A successful
response waits for every selected Channel append to commit; a failed append
fails the request before Automation dispatch. Providers retry using the same
event/message identities, so already committed appends deduplicate. Events with
no matching subscriptions remain accepted with zero Channel deliveries.

Slack and Linear public applications use one signed callback per application:
`POST /api/connectors/{slack|linear}/events`. The application signing secret is
configured through the protected production deploy (`CONNECTOR_SLACK_SIGNING_SECRET`
or `CONNECTOR_LINEAR_SIGNING_SECRET`). The Hub verifies the raw-body signature
and request freshness before it trusts Slack's `team_id` or Linear's
`organizationId`. Slack URL-verification challenges need no Space connection.

The App policy PostgreSQL authority owns `app_connector_oauth_installations`.
Only the server OAuth code exchange establishes a binding: Slack's token response
confirms the workspace; a token-authenticated Linear organization query confirms
the organization. The app client id and installation id are committed with the
encrypted credential version, never accepted from connection metadata. Routing
requires a configured connection and matching current credential version, and
rechecks the binding when reading subscriptions and before firing automations.
It permits at most 50 authorized Spaces per installation; overflow fails before
any delivery. Channel appends use the existing event/channel deduplication key;
an append failure returns 503 for provider retry without duplicating successful appends.

Proving membership of a workspace is not authority over everything the app
sees there, so each provider narrows delivery to what one Space may read:

- **Slack: one Space per workspace.** Slack issues one bot per workspace and
  sends the messages of every channel it was invited into. A binding is
  claimed under a per-workspace advisory lock and the claim
  (`app_slack_workspace_claims`) names one Space: a Connect from any other
  Space is refused (`workspace_connected_elsewhere`, shown as "already
  connected to another xMatrix Space"). The bot stays in every channel it was
  invited into until the app is uninstalled from the workspace, so the claim
  outlives a disconnect in xMatrix, a failed check, a revoked token and the
  Space's deletion; the claiming Space may connect again, which renews it.
  Only a signature-verified `app_uninstalled` dated (Slack's `event_time`)
  after the claim releases it; that event, or `tokens_revoked` naming bot
  tokens, disconnects the bindings made before it (credentials kept). A
  Connect after the event is not retired by a delayed or replayed delivery,
  and a delivery without `event_time` retires nothing. The claim, not the
  number of current bindings, decides use: only the claiming Space's binding
  resolves the bot for actions and receives events, and an event is delivered
  only when Slack's signed `event_time` is at or after the claim (routing, each
  subscription route, the final append and Automations all check it), so
  content from before an uninstall never reaches the next claimant. A binding
  of an unclaimed workspace is no Space's. Existing bindings were backfilled:
  a workspace one Space held is claimed by it; one that two Spaces' older
  bindings share is contested (a claim naming no Space), so neither uses it,
  receives its events or can claim it until Slack's uninstall releases it. The Slack app must subscribe
  to both events.
  The bot belongs to its binding, not to the stored credentials: regenerating a
  Hub-minted field (the ingress key) keeps the binding, so a shared workspace
  stays refused; any other manual edit unbinds the grant and drops its values
  (the bot token among them), keeping only Hub-minted fields and what the admin
  wrote.
- **Linear: each Space's own grant.** OAuth grants act as the connecting
  user. Before an event reaches a Space, the Hub reads its subject (issue,
  comment, project, project update or cycle) by id with that Space's token;
  only a Space whose user can read it receives it, so private teams stay
  private. The answer holds only for the grant that read it: routes, the final
  append and Automations are fenced to that credential version, so a Connect in
  between withholds the delivery and Linear's retry asks the new grant. An
  object that can no longer be read (deleted) is not delivered; a Linear outage
  answers 503 so Linear retries.

Existing OAuth installs reconnect to establish this evidence; no backfill guesses
workspace ownership. Human credential edits invalidate the binding until another
OAuth grant, while server refreshes preserve it and require the credential version
they originally read (a concurrent reconnect cannot receive an old token).
Disconnect excludes the connection, and deleting it cascades the binding. OAuth
callbacks also initialize missing per-connection ingress keys and generated
webhook secrets under the credential lock, preserving existing URLs on reconnect.
The per-connection ingress below remains for manual webhook setups. Organization-wide
Slack Enterprise Grid grants are rejected until their separate installation
contract is supported. Application authorization alone does not prove event setup;
acceptance requires a real provider delivery reaching the subscribed Channel.

Vercel uses `POST /api/connectors/vercel/events` for an Integration webhook,
authenticated with HMAC-SHA1 over the raw body using the Integration Client
Secret. Signed team/user scope selects at most 50 server-established installation
bindings. Every delivery checks the current configuration's app, owner scope,
active state and `projectSelection`/`projects` before routing: two installations
in the same team may authorize different projects. The original credential
version fences both subscription reads and Automation dispatch after the API
call. A provider outage or failed Channel/Automation delivery asks Vercel to retry;
the existing delivery identities deduplicate successful appends.

Migration `0141_expand_vercel_event_scope.sql` adds a nullable scope and atomically
widens the installation constraint. Old Slack/Linear writers may omit that column.
Existing Vercel installs reconnect; metadata, manual tokens and old grants cannot
create a binding. Signed removal or team-transfer events disconnect only the exact
current app/configuration/old-scope binding under the credential/connection locks.
Retirement fails before mutation if its bounded lookup overflows, increments the
connection version, and retains encrypted credential evidence until an admin
reconnects or deletes the connection. An ambiguous transfer scope cannot retire
another grant. Team transfer requires a new OAuth authorization at the destination.
The per-Space webhook path remains available with its independently configured
secret. Registering the Integration webhook and proving native delivery are separate
acceptance steps. See [Vercel webhook verification and payloads](https://vercel.com/docs/webhooks/webhooks-api).


- Per-connection ingress: `POST /api/connectors/:providerId/events/:spaceId/:ingressKey`.
  - `ingressKey` is a random 192-bit opaque key stored in the connection's
    encrypted credentials. With the Space id it names exactly one connection,
    and it is never derived from ids.
  - Rotating the key or the signing secret invalidates old deliveries.
- GitHub keeps `/api/apps/github/webhook` (App-wide) and routes through the
  same pipeline after its own installation lookup.
- Pipeline:
  1. verify the signature;
  2. normalize;
  3. dedupe on `(connectionId, eventId)`;
  4. route to Channels through `app_source_relations`. Every provider's
     collection-level source (a Sentry project, a Linear team, a webhook
     source) is stored with the existing `repository` source kind, and its
     `source_ref` is namespaced as `<provider>:<source>`. This means no schema
     change to the CHECK;
  5. append the message as the provider app author, with an idempotent
     `messageId = app:<provider>:<eventId>:<channelId>`;
  6. fire Automations.
- Subscriptions use one command for every provider:
  `@<provider>:subscribe:<source> <features…>`. GitHub's existing syntax is
  already this shape. GitHub's `subscribe` is a `read` action, so a Channel
  `deny` refuses it; `unsubscribe` is never refused.
- A private GitHub repository's events (and any whose payload does not state
  `private: false`) are delivered only into a closed Channel or an open one in
  a Space not open to participants; a pull request's pre-review conversation
  for such a repository is opened closed there, and its diff is not posted
  into a conversation that participants can read. A failed Channel or
  governance read counts as public.

### 3.4 Automation triggers

Add `{ kind: "event"; provider; source; feature; filter?: Record<string,string> }`
to `AutomationTrigger`. The CLI spelling is `--on <provider>:<feature>[:<source>]`.

`merged` and `ci-failed` remain accepted and are stored unchanged, so existing
Automations keep working (guardrail 7). The Hub evaluates both forms, and new
GitHub triggers may use either spelling.

### 3.5 Outbound actions and policy

- Per-Channel action policy has three values: `allow` executes immediately,
  `ask` stages each request for a Human Space admin, and `disallow` refuses it.
  The legacy command/API spelling `deny` remains a restrictive `disallow` alias.
  Only current Space owners/admins change a policy or decide a request; an Agent
  Run cannot approve its own call.
- No override uses the manifest default: Gmail `send`/`reply` and Google Ads
  `mutate`/`set_campaign_status` default to `ask`, while other actions retain
  `allow`. Existing explicit allow/deny rows keep
  their meaning. GitHub's specialized dispatcher retains allow/disallow; it
  rejects ask instead of suggesting that an unsupported approval will appear.
- The existing policy row stays the sole authority. The additive `ask_version`
  column identifies ask only when it equals that row's version and its legacy
  mode is deny. Old executors therefore fail closed; old writers advance the
  version and invalidate ask. This avoids rewriting rows or relaxing constraints.
- `data.app_connector_action_requests` owns encrypted, immutable request input
  and its 24-hour expiry, account generation and credential version. Channel
  commands from people and Agents stage the same flow. The Pending approvals card fetches
  previews through a current Human admin session and displays Gmail's actual
  from/to/subject/body, including a reply's resolved recipient and headers.
  None of that private payload enters the approval receipt or caller metadata.
- A Human decision atomically changes pending to executing before provider I/O;
  only the winning claim dispatches. Concurrent clicks, repeated decisions,
  denial and terminal outcomes cannot send again. Account changes, expiry,
  removed Channel access, current disallow, and lost admin/mailbox ownership
  refuse execution. Approval covers the frozen request only, never the next call.
  Gmail rechecks authorization immediately before messages/send. A crash or
  uncertain write keeps its consumed state and must not be retried automatically.
  Settling clears the encrypted payload; each new request also clears at most
  50 expired payloads in its Space while retaining outcome evidence; removing the connection or moving or
  purging its Channel/Space removes the associated requests.
- Hub API: `GET /api/channels/:channelId/connector-action-requests` lists at most
  50 unexpired pending previews for a current admin. `POST .../:requestId` accepts
  only `{decision: "allow"|"disallow"}`; content is read from the frozen request,
  never from the decision body. Both require current Channel access and return
  private/no-store. Web proxies use the corresponding `/api/xmatrix` routes.
- Migration: each `*WriteChannelId` metadata value becomes one
  `(connection, channel, action, allow)` row.
  - The migration is idempotent and bounded per connection.
  - The old fields are read as a fallback for one release, then dropped.
- Agents act the way people do: every connector command is a Channel message,
  parsed after it commits, so nothing calls a provider out of the Channel's
  sight. An Agent sends one with `xmatrix send`; its identity, Channel and
  Space are those of any message it sends.
  - The launch prompt names the Space's connected apps (`connectedApps` on the
    spawn, names only). `xmatrix connector list` reads
    `GET /api/connectors/usage` with the Run's credential: each configured
    provider of the Run's Channel's Space and the commands its manifest
    declares. The listing grants nothing; execution checks Channel access,
    credentials and live policy again.
  - The generic Channel command handler admits only manifest-declared actions
    with an own executor whose read/write effect matches the declaration;
    prototype properties and undeclared executors are unknown actions. GitHub
    keeps its specialized command handler for the same `@github:` commands.
  - The receipt replies to the command's message. Hub-only metadata records
    the authenticated calling Instance, separately from the stable Agent id;
    approvals and durable execution retain that exact caller. Live delivery
    and catch-up queue work only for that Instance, without interrupting its
    active turn. Other Instances and receipts without a retained Agent caller
    receive context. Older receipts without that metadata remain context.
  - Subscribed native events queue work for the Channel's existing Instances.
    App receipt/event text is external data, never mention or lifecycle syntax.
    After commit the existing bounded wake authority resumes sleeping or
    interrupted recipients; a receipt restricts that query to its caller.
    Stopped Instances stay stopped and no new Agent identity is allocated.
- Staging ask writes one request and a Channel receipt. The approved dispatch
  writes the normal `app_connector_executions` row and a separate terminal receipt.
  Denial clears the encrypted input and its original command reference. Its
  terminal system notice therefore names the request without a reply target;
  repeated decisions reuse the same notice identity and never dispatch.

## 4. Providers

Wave 1 needs no platform OAuth app registration. The Space admin pastes a token
or generates a webhook secret in the Apps view.

| Provider | Auth (v1) | Inbound events | Actions |
| --- | --- | --- | --- |
| Generic Webhook | webhook-only (HMAC-SHA256 or bearer) | any JSON → summarised message | — |
| Sentry | internal-integration token + client secret; Public installation lifecycle pending | issue created/resolved/regressed, metric alert | read issue/latest exception context; resolve/unresolve/ignore |
| Linear | API key + webhook signing secret | issue/comment/project updates | create/update/comment issue |
| PagerDuty | Scoped user OAuth or REST API key; separate v3 webhook secret | incident triggered/acknowledged/resolved | ack/resolve/note incident |
| GitLab | project/group access token + webhook token | MR, push, pipeline, issue, note | comment, merge MR, retry pipeline |
| Slack | Space-owned Slack app bot token + signing secret | message/reaction in linked channel | post message, reply in thread |
| Jira Cloud | email + API token, webhook secret | issue created/updated/commented | create/transition/comment issue |
| Notion | internal integration token | — (polling deferred) | read page, append block, create page |
| Vercel | access token + webhook secret | deployment created/succeeded/error | redeploy |
| Cloudflare | Any number of OAuth logins in one encrypted `logins` credential (each Connect adds one), or an API token; Hub-registered destination secret | notifications fired/resolved by alert type, `<account id>/<alert type>` for accounts other than the default; subscriptions own each account's `xMatrix ·` policies | list accounts, query logs, list deployments, list D1 databases, read-only D1 query (read); rollback — each may name its account |
| App Store Connect | API key (Key ID, Issuer ID, `.p8`); Hub-registered webhook secret | version state, build upload, TestFlight review and feedback; subscriptions own the app's `xMatrix ·` webhook | status, builds, version, app record and reviews (read); create version, set listing, attach build, submit, cancel, release, reply to review; set app info, age rating, price, availability and review contact; upload builds and screenshots; signing certificates and profiles; TestFlight groups, beta review and tester feedback |
| Discord | bot token | — | post message |
| Feishu/Lark | custom app id/secret + verification token | message in linked chat | send message |

- **Wave 2:** register platform OAuth apps (Linear, Slack, Sentry, GitLab,
  Atlassian, Notion) for one-click connect. This needs humans to create the apps
  and add Worker secrets.
- **Wave 3: OpenConnector for the long tail (decided 2026-10-02).**
  - **What OpenConnector offers.** OOMOL OpenConnector (Apache-2.0) has 1,500+
    providers and 10,000+ actions. It runs only as a runtime with its own
    credential store: actions are `POST /v1/actions/<service.action>` against
    connections it holds, its executors are not a library, and per-request
    credentials are not supported.
  - **Rejected: embedding or hosting it inside xMatrix.** That would make a
    second store of xMatrix-held provider credentials, which conflicts with a
    single credential authority (guardrails 1 and 2).
  - **Chosen: a gateway provider, `openconnector`.**
    - A Space connects *its own* OpenConnector runtime. This can be
      self-hosted or OOMOL-hosted, so it is an external system, like any SaaS.
    - xMatrix stores only the runtime URL and runtime token in its encrypted
      credential store.
    - `@openconnector:search:<service>` (read) lists a service's actions.
    - `@openconnector:run:<service.action>[@alias] <json>` (write) runs one
      action. It goes through the same channel policy, execution record and
      receipt.
    - The result preview is bounded, and mentions in it are shielded.
    - Check authenticates `/v1/health` and confirms `oomol-connect` health;
      provider connections and action availability need separate evidence.
      A random invalid-token health probe must receive 401; configure runtime
      authentication to remain enabled after revocation of its last token.
      Search requires the runtime token and validated service-qualified IDs.
      Run accepts only explicit success with an exact action ID, execution ID
      and persisted audit confirmation. Untrusted output is fenced and limited
      to 800 characters. Invalid or uncertain receipts never imply safe retry.
    - Policy is per channel for all OpenConnector actions together; a Space
      admin's `@openconnector:policy:run deny` turns them off there.

## 5. Delivery plan (one PR each)

1. **Registry refactor.** Introduce `ConnectorProvider` and the registry, and
   move GitHub into `hub/src/connectors/github/`. Generic command dispatch
   replaces `leadingGitHubMention`. No behavior change.
2. **Action policy.** Add the policy table and migration, run every action
   through the policy, and wire the five unreachable GitHub actions.
3. **Credential store and ingress.** Add the credential table, the
   `ingressKey`, the ingress route, the normalized event pipeline, the
   generalized relations and the `event` Automation trigger.
4. **Generic Webhook provider.** This proves the pipeline end to end.
5. **Providers.** Then Sentry, Linear, PagerDuty, GitLab, Slack, Jira, Vercel,
   Cloudflare, Notion, Discord and Feishu, in that order.
6. **Agent access.** Connected app names in the launch prompt and `xmatrix connector list`.
7. **Web Apps view.** A generic connect form driven by the manifest (token
   fields, webhook URL and secret display, per-Channel policy editor).

## 6. Compatibility and safety

- **Unchanged contracts.** `@github:` syntax, the GitHub webhook URL, stored
  `merged`/`ci-failed` triggers and the connection ids all stay as they are.
- **Credentials (guardrail 2).** Credentials never appear in messages, logs,
  executions or read APIs, and provider error text is bounded and redacted
  before it is stored.
- **Untrusted input.** Webhook bodies are untrusted. They become a bounded
  message and never an instruction, and they cannot widen policy.
- **Policy authority (guardrail 1).** Policy is evaluated in the Hub at
  execution time from current rows. A missing connection, credential or policy
  fails closed.
- **Validation (guardrail 8).** Each provider ships pure `normalize` /
  `parseCommand` unit tests from recorded fixtures, plus signature negative
  tests, plus an ingress e2e against the local Hub.

### Grafana event identity

Grafana grouped alert deliveries use a SHA-256 id over the complete receiver,
group key, overall status, and every alert's fingerprint, start time and status.
Alert ordering does not affect the id; the five-alert display preview does not
truncate identity. Resolution and a later firing lifecycle are distinct events,
while a retry of the same delivery deduplicates. This replaces the truncated
identity after deployment without rewriting historical messages; a retry that
crosses that deployment may produce one extra message under the new id.

### Bitbucket Cloud review context

Bitbucket consumer OAuth uses the existing Space/admin signed state, Basic-form
code exchange and encrypted credential-version CAS for rotated refresh grants.
Consumer scopes `account pullrequest` are fixed in Bitbucket and cannot be
narrowed by a smaller authorize parameter. All Bearer API requests remain on
api.bitbucket.org; Check reads only the current UUID without persisting it.

The explicit `workspace/repo!id` review flow reads one PR and one comment page,
returns a bounded untrusted excerpt, and writes a single comment only under the
Channel write policy. Account fields and structured mentions are omitted; linked
resources and pagination are inert. Legacy signed repository webhooks retain
their per-Space setup and do not gain a fabricated global installation binding.
Registered company credentials, formal release and native acceptance are
separate requirements; implementation tests do not prove them complete.

See the [Bitbucket OAuth guide](https://support.atlassian.com/bitbucket-cloud/docs/use-oauth-on-bitbucket-cloud/)
and [PR resource reference](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/).


### PagerDuty Scoped OAuth

The confidential user-code grant requests only `abilities.read incidents.read
incidents.write`, with S256 PKCE. The verifier is derived using a domain-separated
HMAC from a random flow nonce, client secret, client id, callback, Space and admin;
only its challenge and signed public claims enter the browser. Exchange revalidates
the ten-minute state and callback before sending the proof to the fixed identity
endpoint. No client-credentials grant or Classic blanket read/write fallback is used.

Both initial and refresh responses must confirm the full requested scope set
(with optional automatic `openid`), Bearer type, an expiry at most one day, and a
complete rotating token pair. Initial ID tokens require RS256 verification with
fresh keys from the fixed PagerDuty JWKS endpoint, the fixed issuer advertised
by current discovery, client audience/authorized party, expiry and access-token
hash. Exactly one signed US/EU API audience chooses the region. Only the account
id, subdomain, client id, scopes and region are retained in managed encrypted
fields; ID tokens and user/profile claims are discarded. Refresh ID tokens, if
returned, must preserve that context. Missing managed grant evidence or a changed/
missing configured app stops actions, including when the saved token has not expired.
A due rotation is version-CAS persisted before subsequent API calls; a conflict,
failed rotation, or write 401 does not replay a write or fall back to a manual key.
OAuth incident receipts must match the managed account subdomain and region.

API-key setup remains explicit (`apiRegion` is `us`, default, or `eu`). OAuth
ignores this manual metadata. A webhook-only connection still requires its signing
secret; an empty setup fails verification. OAuth does not install or authorize
webhooks: per-Space Generic Webhook v3 and Channel subscriptions remain separate.
Scoped apps work first on their own account; other accounts require provider
publication and administrator installation, separately from our code release.

Sources: [OAuth and PKCE](https://docs.pagerduty.com/developer/oauth-functionality),
[ID-token claims](https://docs.pagerduty.com/developer/pagerduty-openid-token), and
[current OIDC discovery](https://identity.pagerduty.com/global/oauth/anonymous/.well-known/openid-configuration).
As checked on 2026-10-04 UTC, discovery reports issuer `https://app.pagerduty.com/global/oauth/anonymous`
and JWKS `https://identity.pagerduty.com/global/oauth/anonymous/jwks`; the prose
ID-token guide's different issuer is not accepted as a compatibility fallback.

### Sentry native event receipts and recovery

The global Public Integration ingress discriminates the signed `data.issue`,
`data.event`, or `data.metric_alert` shape. Resource, request-id and timestamp
headers do not authenticate identity. Unsupported or ambiguous shapes fail
closed. The provider's one-second response target keeps the ingress
free of provider calls and Channel fanout. Admission has 200ms connection and
statement bounds, a 600ms transaction bound, and a 50ms lock bound. A 204 follows the primary App
PostgreSQL receipt commit, never an uncommitted background task. Database
unavailability, unbound installations, or exhausted capacity return 503 for
provider retry. Signed retired installations are an explicit terminal no-op.

Migration 0144 adds primary App-owned `app_sentry_event_receipts` and
`app_sentry_event_jobs`, plus a nullable OAuth `grant_generation`. New bindings
receive a fresh UUID; a Hub token refresh keeps it. Old bindings without this
proof require reconnect before native events can be admitted. Existing manual
per-Space ingress remains compatible. These global tables stay on the primary
App owner, with the existing App connection movement blockers; they are not a
Space projection, retained Durable Object namespace, or export Queue.

Receipts contain only the signed body digest, installation/app identities,
action, and narrowly typed project/issue/event/incident references. Raw webhook
bodies, titles, actors, exception stacks, requests, user profiles, authorization
codes and tokens are never persisted there. Rich event snapshots would require
the existing private immutable content boundary; this ingress deliberately
sends identity-only notifications and official links. A current installation
and project read using the Space's own installed token must prove the verified
organization and projects before dispatch. Payload URLs are never fetched.
Current grant generation and credential version fence subscription routing;
current bindings are checked again before every individual Channel append and Automation dispatch.

Drain failures retain their durable retry outcome and report only a finite stage
(`binding`, `refresh`, `credentials`, `installation`, `project`, `channel`, or
`automation`) and a valid HTTP status when the provider boundary supplies one.
Error messages, response bodies, credentials and grant identities are excluded.
An eventual successful retry does not establish the original failure's cause;
incidents with no originating evidence stay unresolved until it is understood.

The signed body digest deduplicates seven days of exact redelivery, independent
of unsigned headers. Accepting a receipt freezes at most 50 current grant
bindings, preventing a later reconnect from gaining earlier work. Admission is
serialized per app and bounded by 1,000 outstanding jobs and 10,000 retained
receipts. A pass claims at most four jobs with fresh five-minute lease nonces, with at most eight active jobs
per app across all concurrent workers;
stale completions cannot finish reclaimed work. Eight attempts, durable
exponential backoff (up to one hour), and retained `failed` status bound retries,
including worker crashes. Completed and failed facts remain until receipt
expiry. Cleanup deletes at most two expired receipts/100 child jobs (admission may additionally remove the exact
expired replay receipt/50 children), plus four
exhausted leases per pass.

A minute Cron runs only this bounded Sentry recovery pass. The post-commit wake
is a latency optimization; recovery survives its loss. Neither invokes the
retired projection exporter or export Queue. Each project has at most 128
source and 128 wildcard subscription routes; overflow remains retryable rather
than silently truncating. Message ids and Automation event ids use the same
stable digest/project identity across retries, so partial delivery can resume
without duplicate durable effects. Automation failure is retried with the job.
The maximum metric-alert project fanout is ten. Operators inspect only job
state/count/attempt/lease/expiry metadata on the primary owner; provider bodies
and credentials must never be included in diagnostics. A failed job is evidence
of incomplete delivery, not successful native acceptance.

Company registration, installation, issues/alerts, uninstall, and actual
Channel/Automation acceptance remain separate release/E2E gates. The company
Public Integration should enable issue and alert subscriptions only after this
increment is formally deployed. The official protocol is documented at
https://docs.sentry.io/integrations/integration-platform/webhooks/ .

### Google Chat native Workspace add-on

Google Chat's native mode is an HTTP Workspace add-on, distinct from a manual
incoming webhook. The complete canonical configuration is
`CONNECTOR_GOOGLECHAT_SERVICE_ACCOUNT_JSON`, `CONNECTOR_GOOGLECHAT_APP_ID` and
`CONNECTOR_GOOGLECHAT_SYSTEM_SERVICE_ACCOUNT_EMAIL`. The outbound service
account uses only `chat.bot`, with no domain-wide delegation or impersonation.
The inbound Google system account is the separate read-only identity shown in
Chat Configuration. The formal release validates all three together; no global
service-account key or access token becomes a Space credential or Agent field.

The shared `/api/connectors/googlechat/events` endpoint verifies Google's RS256
ID token against fixed Google keys, the trusted endpoint audience and the
exact system account before parsing the bounded add-on interaction. It accepts
Workspace add-on message/add/remove shapes and returns add-on DataActions,
not legacy Chat event responses. It handles app mentions and direct messages;
it does not promise an unrestricted feed of every message in a room.

Adding the app does not authorize an xMatrix Space. In Apps, a Human Space
owner/admin chooses one explicit `spaces/<opaque-id>`. The Hub checks native
app membership and records a three-minute attempt tied to that Human's live
role, the connection/credential versions and its creation generation. A
192-bit one-use nonce is shown only in the mounted Human form, never a URL,
query cache, local storage or Channel message. The authority stores its SHA256
digest. Sending `@xMatrix link <nonce>` inside that exact Chat room confirms the
attempt under the verified Google system identity and live Space authority.
The primary transaction consumes the attempt, replaces manual credentials and
activates a fresh grant generation. There is one active Space binding per
app/room. Starting a reconnect preserves the old grant until confirmation.

Native Check proves the captured room's app membership and rechecks its grant.
Native post takes a server capability scoped to that room, rechecking current
grant and Channel action policy both before token minting and immediately
before the single provider write. Missing configuration, inactive bindings,
changed app identity or revoked grants cannot fall back to manual credentials.
An explicit later manual credential edit retires the native binding.

Incoming messages route only through the current exact app/room grant and
subscribed Channels. Source references are `googlechat:room-<sha256>` over the
case-sensitive room identifier, or `googlechat:*`; room identities themselves
are never lowercased. User profiles and confirmation nonces are not projected.
Delivery rechecks the captured grant before each append and before Automation;
failed delivery is not acknowledged as success. Stable event/message ids allow
provider retries within the ten-minute event window. This synchronous path is
not a durable asynchronous inbox. Signed removal retires active and pending
room grants, and its monotonic timestamp fences out-of-order confirmation.
Existing scheduled maintenance deletes at most 100 expired attempts and 100
removal fences per invocation; fences expire after one day, beyond both replay
windows. Cleanup never changes a connection or revives a grant. Migration 0146
is additive, carries no metadata-derived bindings, and participates in Space
purge, shard-move blocking and substrate inventories.

Company registration/configuration and fixture boundary tests do not prove
native acceptance. A company Human with Google Chat service access must still
add the app to a dedicated room, confirm a Space binding, perform Check and
policy-authorized post, observe signed interactions and verify removal. The
current hello@ account returns `ServiceNotAllowed`; changing Workspace services
or application mode is not part of this implementation.

See Google's [HTTP request verification](https://developers.google.com/workspace/add-ons/guides/alternate-runtimes)
and [Chat add-on interaction mapping](https://developers.google.com/workspace/add-ons/chat/convert).


## Discord company bot installation

Discord uses the advanced bot authorization code grant for one guild selected
in the native consent screen. Configure the company application for Guild
Install, Public Bot, and Requires OAuth2 Code Grant. Connect requests only
`bot identify`, `integration_type=0`, and permission bits `3072` (View Channel
and Send Messages). `applications.commands` may appear because Discord includes
it with `bot`; no command or Gateway receiver is enabled by this connector.
The shared bot is never copied into a Space credential or an Agent context.
The complete server-owned canonical group is `CONNECTOR_DISCORD_CLIENT_ID`,
`CONNECTOR_DISCORD_CLIENT_SECRET`, and `CONNECTOR_DISCORD_BOT_TOKEN`; production
injects them together through the immutable release train. Missing configuration
leaves the existing own-bot path available; a partial group cannot deploy.

A current Human Space owner/admin starts Connect. The ten-minute signed state
binds the Space, admin, client ID, fixed callback, and primary connection and
credential versions plus connection generation. A missing connection is created
before taking this snapshot; an existing connection is preserved during consent.
The callback rechecks live administration and the snapshot before exchanging a
bounded code, then writes only against the same snapshot under the primary row
locks. Concurrent callbacks, disconnect/reconnect, credential ABA, or a recreated
connection cannot replace a later grant. The authenticated token response's
`guild.id` supplies the guild; browser `guild_id` and `permissions` query hints
never grant access. The bearer authorization endpoint must confirm the expected
application, requested scopes, installing Human, and unexpired grant. Provider
profiles are discarded. Check independently verifies that the matching company
bot is public, requires the code grant, and belongs to the exact guild.

Encrypted Space credentials contain the expiring user token/refresh pair and
managed app/guild/user/scope evidence. Refresh validates the pair and authorization
again, preserves the original guild and Human, and commits by credential-version
CAS. Failed refresh, changed app, or partial native evidence fails closed. The
native post capability verifies the live primary snapshot and current Channel
access/write policy, user authorization, bot application and guild membership,
and target channel's exact guild. Only text and announcement channels are
supported; DMs, another guild, and threads fail before dispatch. The snapshot and
policy are rechecked immediately before the one bounded message request. Mentions
and reply pings are disabled. Provider failures do not retry a write or expose
provider bodies in logs/receipts.

Saving an own `botToken` is an explicit mode replacement and atomically removes
all managed native credentials; a stale refresh cannot revive them. Installing
the company bot similarly replaces manual credentials, and failed native grants
never fall back to a former own bot. Disconnecting the xMatrix connection does not
remove a shared bot from a Discord guild, which may serve another authorized
Space. Removal in Discord or bearer revocation is checked before future posts.
This is the existing outbound `post` feature's native installation path; native
company registration, real Check, message delivery, cross-guild denial, revocation
and reconnect still need provider/browser receipts. Gateway message ingestion and
Marketplace verification remain separately unimplemented and unverified.

### Signed Discord installation lifecycle

The dedicated `POST /api/connectors/discord/events` accepts Discord Webhook
Events, independently of the ordinary connector event ingress. Add the optional
server-only `CONNECTOR_DISCORD_PUBLIC_KEY` (Developer Portal Public Key; API
`verify_key`) to the complete company credential group. Its 32-byte Ed25519 key
verifies the exact timestamp header plus raw body before parsing or querying
PostgreSQL. Missing configuration fails closed, bad signatures/five-minute
request-clock skew return 401, and authenticated PING returns **204 with no body** and the required valid
`Content-Type: application/json`.
Application/version identity, bounded UTF-8 JSON, event time (at most 15 minutes
old and 30 seconds ahead), and installing user identity are checked separately.
Successful lifecycle deliveries also return empty 204. The lifecycle repository
uses the bounded primary receipt transaction budget; a timeout fails and retries
rather than acknowledging an uncommitted retirement.

A native callback records only its provider-confirmed app/guild/installing-user
binding and signed Connect start under the original connection/credential locks.
That start and binding generation survive token refresh. Existing company grants
have no inferred lifecycle binding: reconnect through Connect; their existing
live authorization and guild checks continue to protect outbound actions.
`APPLICATION_AUTHORIZED` observes only a matching currently configured guild
binding. It cannot create a Space connection, activate a disconnected connection,
change its guild, or grant Channel access. User installations and unrelated
Webhook Events are acknowledged without routing messages or granting authority.

`APPLICATION_DEAUTHORIZED` supplies a user, **not a guild**. It retires only that
user's current grants from the exact company app, in their already-bound Spaces,
with a credential version matched under primary row locks. It clears native
credentials/bindings, disconnects the connections and advances their revision;
manual own-bot connections and another app/user remain intact. A per-app/user
revocation watermark and callback share a transaction advisory lock, preventing
revocation-before-callback races. Replays are idempotent, old deliveries cannot
retire a newer Connect, and a stale refresh cannot recreate removed credentials.
The tombstone lives for 20 minutes (longer than Connect and accepted delivery
windows), prunes at most 100 expired rows per event, and fails before mutation
at 10,000 rows per app. Installation/retirement fanout is bounded at 50 current
bindings per app/user; overflow rolls back instead of partially retiring grants.
No raw payload, user profile or token enters lifecycle storage.

This lifecycle has no Channel-message or Automation append. Ordinary guild
messages still require a separately implemented Gateway receiver; Social SDK
lobby/game messages are not substitutes. User deauthorization is distinct from
removing a bot from a guild; that latter condition remains checked by the live
bot membership request before posting and is not claimed as a webhook signal.
As checked on 2026-10-04, the [official API version table](https://docs.discord.com/developers/reference#api-versioning)
marks the v10 used here Available; deprecated/discontinued old API versions do
not imply Discord product retirement. The [2026-09-17 change log](https://docs.discord.com/developers/change-log#unlinking-accounts-guide)
continues to document `APPLICATION_DEAUTHORIZED`. No product/signup sunset is
established by these sources.

Sources: [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2),
[application settings](https://docs.discord.com/developers/resources/application),
[permission bits](https://docs.discord.com/developers/topics/permissions), and
[channels](https://docs.discord.com/developers/resources/channel).


### Feishu company store app and group authority

The company integration uses a Feishu store app, rather than reinterpreting a
self-built app's internal token endpoint as company installation. Provision
`CONNECTOR_FEISHU_APP_ID`, `CONNECTOR_FEISHU_APP_SECRET`,
`CONNECTOR_FEISHU_VERIFICATION_TOKEN`, and `CONNECTOR_FEISHU_ENCRYPT_KEY`
as one complete production group, using stdin. An absent group preserves the
existing Worker configuration; any partial or malformed group blocks deployment.
The shared app credentials, pushed app tickets and short-lived API tokens never
become Space credential fields or Agent capabilities. The company endpoint is
`https://xmatrix-hub.xmatrix.sh/api/connectors/feishu/events`.

Enable the bot capability, sending messages as the app (`im:message:send_as_bot`),
receiving group messages addressed to the bot (`im:message.group_at_msg:readonly`),
and the chat membership read permission required by the native
`im/v1/chats/:chat_id/members/is_in_chat` endpoint. Verify the exact membership
permission in the company's current developer console before registration.
Subscribe to `im.message.receive_v1`, `im.chat.member.bot.deleted_v1`,
`app_ticket`, `app_open`, `app_status_change`, and `app_uninstalled`. Do not
request directory, contacts, user-token, private-message or organization admin
permissions to make this path work. Publishing in the app marketplace is a
separate deliverable; preparing this integration does not prove marketplace
approval, company registration, installation or E2E acceptance.

URL verification checks the configured verification token and returns only the
bounded challenge. Every authority-changing event requires an encrypted
AES-256-CBC body, the SHA-256 signature over the timestamp, nonce, Encrypt Key
and original body, fresh request/event times, and the exact configured app ID.
Schema 1 lifecycle events and schema 2 group messages remain distinct. Signed
app tickets are stored encrypted on primary PostgreSQL with app/row/version AAD;
newer ticket events replace older ones monotonically. The local availability
bound requires a ticket pushed within two hours, not a claim that Feishu expires
its tickets at that time. A missing ticket triggers one bounded native resend
and waits for the signed callback. API calls use only the fixed Feishu ISV
`auth/v3/app_access_token` then `auth/v3/tenant_access_token` endpoints.

Signed tenant enable/disable/uninstall events own installation availability.
A durable retirement timestamp fences pre-retirement grants even after a later
enable event. The Human Space owner/admin enters the installed tenant key and a
group chat ID; those values select the native membership check, never prove
access. The server checks bot membership, then records one private three-minute
nonce bound to the selected tenant/group, Human admin, original connection and
credential versions, and connection generation. A real signed user message in
that exact group consumes it. Link commands and their nonces are never projected
into Channels or Automations. Each Space can bind up to 20 independently
confirmed groups; one active company group has one Space owner. Native source
refs hash the case-sensitive tenant/group bytes, avoiding opaque-ID folding and
cross-tenant collisions. The existing self-built Feishu/Lark ingress and actions
remain an explicit manual configuration path; saving manual credentials retires
all company group grants and pending confirmations.

Incoming messages route only through current primary room/tenant grants and
existing Channel subscriptions. Before each Channel append and Automation the
server checks the captured grant again. Native sending resolves one explicit
group among the Space's confirmed grants, checks current Channel action policy
and bot membership, then rechecks immediately before a single provider write.
No mention markup or write retries are issued. Check confirms all current
bound groups with bounded concurrency and a shared request deadline. Signed bot
removal retires only the exact group; removing one group leaves other live group
grants intact. Disconnect/recreate, manual replacement, tenant retirement and
app-key rotation invalidate stale confirmations and captured capabilities.

Primary implementation evidence: the current official
[Lark Node SDK](https://github.com/larksuite/node-sdk), including its
[ISV token manager](https://github.com/larksuite/node-sdk/blob/main/client/token-manager.ts),
[event contracts](https://github.com/larksuite/node-sdk/blob/main/code-gen/other-event-handles.ts)
and [membership API](https://github.com/larksuite/node-sdk/blob/main/code-gen/projects/im.ts).

### Telegram company bot and explicit group grants

A company bot is optional. The formal Hub release injects the atomic pair
`CONNECTOR_TELEGRAM_BOT_TOKEN` and `CONNECTOR_TELEGRAM_WEBHOOK_SECRET`; a missing
pair leaves manual per-Space bot credentials available, while a partial or
malformed pair fails deployment before mutation. Tokens and the webhook secret
stay in server credentials, never in the Apps form or Agent capabilities.
Rotating either value changes the app identity and requires new group proof.

Register the company bot through BotFather using the authorized company identity.
After the formal endpoint is deployed, configure its HTTPS webhook at
`https://xmatrix-hub.xmatrix.sh/api/connectors/telegram/events`, with the
app-bound `secret_token` described in the operations runbook and exactly `message` and `my_chat_member` updates. Check reads `getWebhookInfo`
and verifies the endpoint and update selection without changing provider state.
Telegram authenticates delivery through `X-Telegram-Bot-Api-Secret-Token`; this
is a secret header over HTTPS, not a body HMAC signature. Telegram updates do not
identify their receiving bot. The delivery secret is derived separately from the
bot token and canonical secret seed, so changing either fences deliveries from
the old bot/webhook; the stored app fingerprint is never an authentication value.
Keep bot privacy mode
unchanged. Telegram's privacy mode determines whether it delivers only addressed
commands/replies or broader group messages; joining and linking cannot promise
messages the provider does not deliver.

A Human Space owner/admin starts a three-minute private confirmation in Apps
using the canonical negative group/supergroup ID. The Hub proves the fixed bot
identity, group type and current bot membership using the official Bot API.
A current Telegram group administrator sends the returned
`/xmatrix_link@<verified-bot-username> <nonce>` command in that exact group.
`getChatAdministrators` proves their current role without promoting the bot to
administrator. The server then rechecks the initiating Space admin, connection
and credential snapshots before atomically granting the group. Nonces remain
only in the mounted form and are stored as digests. Telegram uses second-resolution
message times, so challenge initiation uses the same resolution; removal wins
ambiguous same-second ordering. Copied or malformed confirmation commands never
become Channel messages or Automation content.

Each Space supports twenty independently confirmed groups; each active group
belongs to one Space for the current app identity. Primary PostgreSQL grants,
connection generations and exact source subscriptions authorize both delivery
and the typed `sendMessage` capability. Writes recheck bot membership and current
Channel policy/grants immediately before posting. Ambiguous provider receipts
are not retried automatically. Bot removal, lost send permission and group
migration retire the exact group; subsequent joins do not restore authority.
Human unlink affects only its selected group. Saving manual credentials retires
all company group grants and pending confirmations for that Space.

The expand-only Telegram room tables join primary substrate inventory and block
Space shard moves until their authority has a documented migration path. Bounded
scheduled cleanup expires old confirmations and removal fences without restoring
a retired grant. Provider-fixture, real PostgreSQL and production Chromium
coverage verifies these boundaries; company registration, actual group linking,
Check, real authenticated delivery, policy-controlled send and removal remain
separate native acceptance requirements.

References: [Telegram Bot API](https://core.telegram.org/bots/api),
[group administrator queries](https://core.telegram.org/bots/api#getchatadministrators),
and [bot privacy delivery](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get).

### WeCom third-party application

The [WeCom company suite contract](wecom-company-suite.md) records the
registration callback, Human website installation, encrypted company/member
grants, live Check, policy-controlled send, content-free text notifications and
bounded authorization retirement. Actual company registration and native
acceptance remain unverified. Existing group robot
webhooks remain their own connection mode. A verified suite ticket proves
app-level possession only and must never grant a Space or recipient access.

## Teams native authority

The company Bot uses the primary PostgreSQL Bot room authority with a Teams-only pending selection, atomically captured Microsoft-authenticated conversation reference, and original attempt time for removal fencing. JWT authentication and live member queries stay in the Hub; Web initiates the private Human confirmation and displays only a hashed source. The first release is bounded to company-home-tenant personal/groupChat, one conversation per Space; manual webhooks are an explicit replacement mode. See [Teams native contract](../connectors/teams-native.md). No delegated Microsoft file authority or tenant-wide grants are implied.
