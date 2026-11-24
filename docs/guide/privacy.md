---
title: "Telemetry, diagnostics and local privacy — xMatrix Docs"
description: "What stays on your machine, how optional local quota probes and client diagnostics work, beta vs stable defaults by region, and how to turn either off."
---

# Telemetry and local privacy

xMatrix is a hosted collaboration hub paired with a local Rust daemon on your own machines. This page documents every diagnostic event and local file read the clients and daemon perform, and how to turn them off.

## What stays on your machine

Your source code, git history, working directories, provider chat history, and local model credentials stay on the computers you control. xMatrix does not upload your local model API keys or OAuth tokens to the Hub, and does not read third-party credential files to fingerprint or link your identity across machines.

To keep a connected computer stable across reinstalls under your account, the daemon derives an owner-scoped `machineId` locally (`SHA-256` of your xMatrix user ID and an OS machine identifier). Raw OS hardware identifiers and unscoped machine fingerprints are never sent to the Hub.

## Local provider quota probes

**In short:** to show how much quota your registered AI tools have left, the xMatrix daemon reads those tools' own login files on your computer (for example `~/.grok/auth.json`) and asks each provider directly. Codex, Claude Code and OpenCode are the exceptions: xMatrix asks the tool itself and opens none of their login files. Codex is asked through the running session or a briefly started `codex app-server`, Claude Code through the running session or a briefly started `claude` (its `get_usage` request, which sends no prompt), and OpenCode through a briefly started `opencode serve`. Nothing read from those files — no token, account id, file contents or fingerprint — is sent to xMatrix; the Hub receives only the normalized quota answer. One switch stops the file reads, the requests to Codex, Claude Code and OpenCode, and the provider requests (see [Turning off local quota probes](#turning-off-local-quota-probes)).

When you register a supported harness (such as Claude Code, Codex, Cursor, Grok, OpenCode, DeepSeek, Z.ai, or Antigravity), xMatrix can show remaining subscription quota in `xmatrix agent list` and the Agents view, and let `@auto` route around exhausted accounts.

To read remaining quota directly from each provider without running an LLM turn, the local daemon reads the credential store of the registered harness on your machine:

| Harness | Local store read (in memory only) | Direct provider endpoint queried from your machine |
| --- | --- | --- |
| Claude Code | None: Claude Code's own `get_usage` control request, asked of the running session or a briefly started `claude`; no prompt is sent | Handled by Claude Code with its own sign-in |
| Codex | None: Codex's own app-server method `account/rateLimits/read`, asked of the running session or a briefly started `codex app-server` | Handled by Codex with its own sign-in |
| Cursor | `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`, macOS keychain (`cursor-access-token`), or Cursor `auth.json` | `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| Grok Build | `GROK_CLI_OAUTH_TOKEN` or `~/.grok/auth.json` | `https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| OpenCode | None: `GET /api/experimental/usage/limits` of a briefly started `opencode serve`, listening on loopback only with a one-time password. Nothing is read for a model OpenCode routes to another provider | Handled by OpenCode with its own sign-in |
| DeepSeek | `DEEPSEEK_API_KEY` or `$DSH_HOME` credential file | `https://api.deepseek.com/user/balance` |
| Z.ai / Zhipu | `ZAI_API_KEY` / `ZHIPU_API_KEY` | `https://api.z.ai/api/monitor/usage/quota/limit` (or `open.bigmodel.cn`) |
| Antigravity | Delegates to unmodified `agy -p "/usage" --output-format json` | Handled by `agy` itself |

**Strict boundary:**

- Credentials stay in local process memory and are sent **only** to that provider's own usage endpoint.
- Local SHA-256 content fingerprints are used solely as in-memory cache keys to detect account switches and are **never logged or sent to xMatrix**.
- Only normalized quota facts (remaining window percentage, reset timestamp, whether the account is currently served, and prepaid balance when applicable) are sent to the xMatrix Hub.

### Turning off local quota probes

Disable all local provider quota probes on a machine in **Desktop Settings → Legal and privacy → Local provider quota probes**, or via CLI / environment variable:

```sh
# Persistent machine setting
xmatrix config quotaProbes off

# Or via environment variable (takes precedence)
export XMATRIX_DISABLE_QUOTA_PROBES=1
```

To disable only Antigravity quota probing, set `XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE=1`. When disabled, xMatrix does not read local provider credential stores, start `codex app-server`, `claude` or `opencode serve`, ask a Codex or Claude Code session, or query provider usage endpoints—including pre-launch probes, startup/reconnect reads, and rate-limit recovery.

## Client diagnostics and crash reporting

xMatrix does not use advertising cookies, cross-site tracking, session replay, or third-party behavioral analytics SDKs (such as PostHog, Google Analytics, or Cloudflare Web Analytics).

Optional client diagnostics and browser crash reporting are **off by default in the stable apps and CLI**. Unauthenticated marketing, docs, and legal pages never load Sentry. What is sent when diagnostics are on:

- **Error and crash reports (Sentry):** inside the signed-in app, uncaught browser errors and defects are sent as the error's class, its code when it has one, and the code locations of its stack. The error's message, breadcrumbs, URLs, cookies, headers, request bodies and user details are never sent. Self-hosted/local builds without a DSN send nothing. (Server-side Hub errors remain reported server-side to operate the hosted service; see below.)
- **First-party diagnostics (xMatrix Hub → Cloudflare Analytics Engine):** clients send startup timing (`/api/observable/startup-timing`), onboarding setup step counts (`/api/observable/onboarding-step`), desktop daemon startup failures (`/api/observable/desktop-daemon-failure`), and CLI reconnect samples (`/api/observable/client-metrics`). Identifiers are pseudonymized server-side with a keyed HMAC-SHA-256 secret.

### What a diagnostic event may contain

Every diagnostic event has a declared set of fields, checked when the client builds it and again when the Hub receives it. A field may hold only a fixed value from a list, a number, true or false, a version, an opaque identifier, or a short code such as `websocket_connect_failed` (lowercase letters, digits, `_` and `-`). An event with any other field, or a value outside its field, is refused whole rather than trimmed into shape, so text you wrote has no field to travel in. Errors are reported by their class and code, never by their message.

Two paths carry text, and only these:

- **Send failure report on a desktop startup failure card:** the CLI's last lines, which the desktop App redacts on your machine first (home directory, email addresses, URL queries and anything shaped like a token or key are replaced). The card shows you exactly these lines before you send them, and they are sent only when you press the button; the automatic report sent when diagnostics are on carries only the failure's stage, exit code, platform and App version.
- **Server-side Hub error reports:** the server's own error message, with quoted values, email addresses, URL queries, home-directory paths and token-shaped strings removed. Logged details are reported only when they are numbers, true/false or opaque identifiers.

### Beta and stable defaults

| | Stable apps and CLI | Beta apps and CLI |
| --- | --- | --- |
| You opted in | Sent | Sent |
| You opted out, or Do Not Track, Global Privacy Control or `XMATRIX_TELEMETRY=0` | Not sent | Not sent |
| No choice made; signup country **and** current country outside the EU, EEA, UK and Switzerland | Not sent | Sent, after a one-line notice linking to the off switch |
| No choice made; either country in the EU, EEA, UK or Switzerland, or unknown | Not sent | Not sent; an unticked **Send diagnostics to help improve the beta** box is offered |

Rows apply in order: an explicit opt-in is honoured even with Do Not Track or Global Privacy Control on. Only ticking that box or flipping the switch in Settings (or `xmatrix config telemetry on|off`) counts as a choice. Dismissing the notice is not a choice, and xMatrix never changes your setting for you.

**How the region is decided.** Your clients have no reliable location of their own (time zone and language are settings), so the Hub tells them:

- **Signup region.** When your account is created, the Hub records, from the country Cloudflare reports for that request, whether it is a country that requires prior consent. Only that category is stored, never the country or your IP address, and it is never changed by a later request. Accounts created earlier get it the first time they use a beta build. It is deleted with your account.
- **Current region.** Before each send, a client uses the Hub's answer for its current connection, at most 10 minutes old; when older, it asks the Hub again with a small request that carries no diagnostics. If that lookup fails, times out or the country is unknown, nothing is sent. Travelling into a consent-required country therefore stops default sending within 10 minutes.

### Opting in or turning diagnostics off

- **Web, Desktop, iOS, and Android:** open **Settings → Legal and privacy** and toggle **Send diagnostics and crash reports**. Your choice is saved to your account, so every client follows it. On Desktop, this switch also updates the local daemon's `telemetry` setting.
- **Desktop startup failure card:** even with diagnostics off, you can choose **Send failure report** once on a daemon startup failure card to share the redacted failure details shown on the card.
- **CLI and daemon:** opt in with `xmatrix config telemetry on` or `XMATRIX_TELEMETRY=1`, and turn off with `xmatrix config telemetry off`, `XMATRIX_TELEMETRY=0`, or `DO_NOT_TRACK=1`. `xmatrix config telemetry on|off` also saves the choice to your account.

## Legal documents

- [Privacy Policy](/privacy)
- [Cookies and Local Storage Notice](/cookies)
- [Subprocessors](/subprocessors)
- [Terms of Service](/terms)
