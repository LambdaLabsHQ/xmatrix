---
title: "Telemetry, diagnostics and local privacy — xMatrix Docs"
description: "What stays on your machine, how optional local quota probes and client diagnostics work, and how to turn either off."
---

# Telemetry and local privacy

xMatrix is a hosted collaboration hub paired with a local Rust daemon on your own machines. This page documents every diagnostic event and local file read the clients and daemon perform, and how to turn them off.

## What stays on your machine

Your source code, git history, working directories, provider chat history, and local model credentials stay on the computers you control. xMatrix does not upload your local model API keys or OAuth tokens to the Hub, and does not read third-party credential files to fingerprint or link your identity across machines.

To keep a connected computer stable across reinstalls under your account, the daemon derives an owner-scoped `machineId` locally (`SHA-256` of your xMatrix user ID and an OS machine identifier). Raw OS hardware identifiers and unscoped machine fingerprints are never sent to the Hub.

## Local provider quota probes

When you register a supported harness (such as Claude Code, Codex, Cursor, Grok, OpenCode, DeepSeek, Z.ai, or Antigravity), xMatrix can show remaining subscription quota in `xmatrix agent list` and the Agents view, and let `@auto` route around exhausted accounts.

To read remaining quota directly from each provider without running an LLM turn, the local daemon reads the credential store of the registered harness on your machine:

| Harness | Local store read (in memory only) | Direct provider endpoint queried from your machine |
| --- | --- | --- |
| Claude Code | macOS login keychain (`Claude Code-credentials`) or `~/.claude/.credentials.json` | `https://api.anthropic.com/api/oauth/usage` |
| Codex | `$CODEX_HOME/auth.json` or `~/.codex/auth.json` | `https://chatgpt.com/backend-api/wham/usage` |
| Cursor | `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`, macOS keychain (`cursor-access-token`), or Cursor `auth.json` | `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| Grok Build | `GROK_CLI_OAUTH_TOKEN` or `~/.grok/auth.json` | `https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| OpenCode | `OPENCODE_API_KEY` or OpenCode `auth.json` | `https://opencode.ai/zen/go/v1/usage` or ChatGPT `wham/usage` |
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

To disable only Antigravity quota probing, set `XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE=1`. When disabled, xMatrix does not read local provider credential stores or query provider usage endpoints—including pre-launch probes, startup/reconnect reads, and rate-limit recovery.

## Client diagnostics and crash reporting

xMatrix does not use advertising cookies, cross-site tracking, session replay, or third-party behavioral analytics SDKs (such as PostHog, Google Analytics, or Cloudflare Web Analytics).

**Optional client diagnostics and browser crash reporting are off by default across all regions.** Unauthenticated marketing, docs, and legal pages never load Sentry. Nothing is sent from your clients unless you explicitly opt in (or click **Send failure report** on a desktop daemon startup failure card):

- **Error and crash reports (Sentry):** when opted in inside the signed-in app, uncaught browser errors and defects are sent as the error's class, its code when it has one, and the code locations of its stack. The error's message, breadcrumbs, URLs, cookies, headers, request bodies and user details are never sent. Self-hosted/local builds without a DSN send nothing. (Server-side Hub errors remain reported server-side to operate the hosted service; see below.)
- **First-party diagnostics (xMatrix Hub → Cloudflare Analytics Engine):** when opted in, clients send startup timing (`/api/observable/startup-timing`), onboarding setup step counts (`/api/observable/onboarding-step`), desktop daemon startup failures (`/api/observable/desktop-daemon-failure`), and CLI reconnect samples (`/api/observable/client-metrics`). Identifiers are pseudonymized server-side with a keyed HMAC-SHA-256 secret.

### What a diagnostic event may contain

Every diagnostic event has a declared set of fields, checked when the client builds it and again when the Hub receives it. A field may hold only a fixed value from a list, a number, true or false, a version, an opaque identifier, or a short code such as `websocket_connect_failed` (lowercase letters, digits, `_` and `-`). An event with any other field, or a value outside its field, is refused whole rather than trimmed into shape, so text you wrote has no field to travel in. Errors are reported by their class and code, never by their message.

Two paths carry text, and only these:

- **Send failure report on a desktop startup failure card:** the CLI's last lines, which the desktop App redacts on your machine first (home directory, email addresses, URL queries and anything shaped like a token or key are replaced). The card shows you exactly these lines before you send them, and they are sent only when you press the button; the automatic report sent when diagnostics are on carries only the failure's stage, exit code, platform and App version.
- **Server-side Hub error reports:** the server's own error message, with quoted values, email addresses, URL queries, home-directory paths and token-shaped strings removed. Logged details are reported only when they are numbers, true/false or opaque identifiers.

### Opting in or turning diagnostics off

- **Web, Desktop, iOS, and Android:** open **Settings → Legal and privacy** and toggle **Send diagnostics and crash reports** (off by default). On Desktop, this switch also updates the local daemon's `telemetry` setting.
- **Desktop startup failure card:** even with diagnostics off, you can choose **Send failure report** once on a daemon startup failure card to share the redacted failure details shown on the card.
- **CLI and daemon:** off by default; opt in with `xmatrix config telemetry on` or `XMATRIX_TELEMETRY=1`, and turn off with `xmatrix config telemetry off`, `XMATRIX_TELEMETRY=0`, or `DO_NOT_TRACK=1`.

## Legal documents

- [Privacy Policy](/privacy)
- [Cookies and Local Storage Notice](/cookies)
- [Subprocessors](/subprocessors)
- [Terms of Service](/terms)
