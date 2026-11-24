---
title: "Telemetry, diagnostics and local privacy — xMatrix Docs"
description: "What stays on your machine, how optional local quota probes and client diagnostics work, and how to turn either off."
---

# Telemetry and local privacy

xMatrix is a hosted collaboration hub paired with a local Rust daemon on your own machines. This page documents every diagnostic event and local file read the clients and daemon perform, and how to turn them off.

## What stays on your machine

Your source code, git history, working directories, provider chat history, and local model credentials stay on the computers you control. xMatrix does not upload your local model API keys or OAuth tokens to the Hub, and does not read third-party credential files to fingerprint or link your identity across machines.

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

Disable all local provider quota probes on a machine with either command or environment variable:

```sh
# Persistent machine setting
xmatrix config quotaProbes off

# Or via environment variable (takes precedence)
export XMATRIX_DISABLE_QUOTA_PROBES=1
```

To disable only Antigravity quota probing, set `XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE=1`. When disabled, xMatrix does not read local provider credential stores or query provider usage endpoints.

## Client diagnostics and crash reporting

xMatrix does not use advertising cookies, cross-site tracking, session replay, or third-party behavioral analytics SDKs (such as PostHog, Google Analytics, or Cloudflare Web Analytics).

By default, signed-in clients send bounded operational diagnostics to help fix bugs and performance regressions:

- **Error and crash reports (Sentry):** uncaught errors and browser defects sent with `userInfo`, `cookies`, `httpHeaders`, `httpBodies`, `urlQueryParams`, and console breadcrumbs disabled, and quoted text redacted. Self-hosted/local builds without a DSN send nothing.
- **First-party diagnostics (xMatrix Hub → Cloudflare Analytics Engine):** startup timing (`/api/observable/startup-timing`), onboarding setup step counts (`/api/observable/onboarding-step`), desktop daemon startup failures (`/api/observable/desktop-daemon-failure`), and CLI reconnect samples (`/api/observable/client-metrics`). Identifiers are pseudonymized server-side with a keyed HMAC-SHA-256 secret; no message or command bodies are included.

### Turning off diagnostics and crash reporting

- **Web, Desktop, iOS, and Android:** open **Settings → Legal and privacy** and turn off **Send diagnostics and crash reports**.
- **Browser privacy signals:** xMatrix automatically honors **Do Not Track (`DNT: 1`)** and **Global Privacy Control (GPC)** unless you explicitly turn diagnostics back on in Settings.
- **CLI and daemon:** run `xmatrix config telemetry off`, or set `XMATRIX_TELEMETRY=0` or `DO_NOT_TRACK=1`.

## Legal documents

- [Privacy Policy](/privacy)
- [Cookies and Local Storage Notice](/cookies)
- [Subprocessors](/subprocessors)
- [Terms of Service](/terms)
