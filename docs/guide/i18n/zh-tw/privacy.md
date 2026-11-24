---
title: "遙測、診斷與本地隱私 — xMatrix 文件"
description: "哪些資料留在本機、可選的本地額度探測與用戶端診斷如何運作，以及如何隨時關閉。"
---

# 遙測與本地隱私

xMatrix 由託管協作 Hub 與運行在你自己電腦上的 Rust 本地 daemon 組成。本頁公開列出用戶端與 daemon 的所有診斷回報與本機檔案讀取行為，以及關閉方式。

## 哪些資料留在本機

你的原始碼、Git 歷史、工作目錄、模型工具紀錄與本機模型憑證皆留在你自己控制的電腦上。xMatrix 絕不將本機模型 API Key 或 OAuth token 上傳至 Hub，也不會讀取第三方憑證檔來做跨機器身分歸因或指紋關聯。

為確保同一台電腦重裝後仍穩定對應到你的帳號，本機 daemon 僅於本機將你的 xMatrix 使用者 ID 與系統機器識別碼混合做 SHA-256 派生出按帳號隔離的 `machineId`；原始硬體識別碼與未按帳號隔離的機器指紋絕不上傳至 Hub。

## 本地服務商額度探測

**一句話說明：** 為了顯示你已註冊的 AI 工具還剩多少額度，xMatrix daemon 會讀取這些工具在你電腦上的登入檔案（例如 `~/.codex/auth.json`），並直接向對應服務商查詢。從這些檔案讀到的任何內容（權杖、帳號 ID、檔案內容或檔案指紋）都不會傳送給 xMatrix；Hub 只收到正規化後的額度結果。同一個開關可同時停止讀取檔案與向服務商發出請求（見下方「關閉本地額度探測」）。

當你在本機註冊受支援的代理工具（如 Claude Code、Codex、Cursor、Grok、OpenCode、DeepSeek、Z.ai、Antigravity）時，xMatrix 可在 `xmatrix agent list` 與 Agents 頁面顯示訂閱剩餘額度，並供 `@auto` 避開已用盡的帳號。

為在不消耗模型對話的前提下查詢剩餘額度，本機 daemon 僅於記憶體內讀取對應已註冊工具的本機憑證並直連原廠端點：

| 工具 | 僅於本機記憶體讀取的位置 | 由本機直連的原廠端點 |
| --- | --- | --- |
| Claude Code | macOS 鑰匙圈（`Claude Code-credentials`）或 `~/.claude/.credentials.json` | `https://api.anthropic.com/api/oauth/usage` |
| Codex | `$CODEX_HOME/auth.json` 或 `~/.codex/auth.json` | `https://chatgpt.com/backend-api/wham/usage` |
| Cursor | `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`、macOS 鑰匙圈（`cursor-access-token`）或 Cursor `auth.json` | `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| Grok Build | `GROK_CLI_OAUTH_TOKEN` 或 `~/.grok/auth.json` | `https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| OpenCode | `OPENCODE_API_KEY` 或 OpenCode `auth.json` | `https://opencode.ai/zen/go/v1/usage` 或 ChatGPT `wham/usage` |
| DeepSeek | `DEEPSEEK_API_KEY` 或 `$DSH_HOME` 憑證檔 | `https://api.deepseek.com/user/balance` |
| Z.ai / Zhipu | `ZAI_API_KEY` / `ZHIPU_API_KEY` | `https://api.z.ai/api/monitor/usage/quota/limit`（或 `open.bigmodel.cn`） |
| Antigravity | 直接呼叫未修改的 `agy -p "/usage" --output-format json` | 由 `agy` 自行處理 |

**嚴格邊界：**

- 憑證僅留在本機行程記憶體中，**只傳送給對應服務商自己的額度端點**。
- 本機 SHA-256 雜湊僅作記憶體快取鍵用來偵測帳號切換，**永不記錄於日誌，也永不上傳至 xMatrix**。
- 傳送給 xMatrix Hub 的僅為正規化後的剩餘額度資訊（百分比、重設時間、帳號可用狀態與預付餘額）。

### 關閉本地額度探測

可在 **桌面 App → Settings → Legal and privacy → Local provider quota probes** 中關閉，或透過命令／環境變數停用：

```sh
xmatrix config quotaProbes off
# 或設定環境變數（優先度更高）
export XMATRIX_DISABLE_QUOTA_PROBES=1
```

若僅關閉 Antigravity 探測，可設定 `XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE=1`。關閉後，xMatrix 在所有路徑下均不會讀取本機服務商憑證或查詢原廠額度端點。

## 用戶端診斷與當機回報

xMatrix 不使用廣告 Cookie、跨站追蹤、工作階段錄影，也未整合 PostHog、Google Analytics 或 Cloudflare Web Analytics 等第三方行為分析 SDK。

**所有地區的可選用戶端診斷與瀏覽器當機回報皆預設關閉（明確 Opt-in）。** 未登入的行銷、文件與法律頁面絕不載入 Sentry；除非你主動開啟（或在桌面端啟動失敗卡片上點擊「送出失敗報告」），用戶端不會主動送出診斷資訊：

- **錯誤與當機回報（Sentry）**：僅於登入應用內主動開啟後運作，停用使用者資訊、Cookie、HTTP 標頭/內容、URL 查詢參數與主控台麵包屑，並遮蔽錯誤訊息中引用的內容；未設定 DSN 的本機或自託管建置不送出任何回報。
- **第一方診斷指標（xMatrix Hub → Cloudflare Analytics Engine）**：僅於主動開啟後回報啟動耗時（`/api/observable/startup-timing`）、新手引導步驟計數（`/api/observable/onboarding-step`）、桌面端 daemon 啟動失敗資訊（`/api/observable/desktop-daemon-failure`）與 CLI 網路重連樣本（`/api/observable/client-metrics`）。識別碼於伺服器端以金鑰 HMAC-SHA-256 假名化，不含訊息或命令內容。

### 開啟或關閉診斷與當機回報

- **Web、桌面端、iOS 與 Android**：前往 **Settings → Legal and privacy** 切換 **Send diagnostics and crash reports**（預設關閉）；桌面端會同步更新本機 daemon 的 `telemetry` 設定。
- **CLI 與 daemon**：預設關閉；可透過 `xmatrix config telemetry on` 或 `XMATRIX_TELEMETRY=1` 開啟，並隨時以 `xmatrix config telemetry off`、`XMATRIX_TELEMETRY=0` 或 `DO_NOT_TRACK=1` 關閉。

## 法律文件

- [隱私權政策（EN）](/privacy)
- [Cookie 與本機儲存聲明（EN）](/cookies)
- [子處理商清單（EN）](/subprocessors)
- [服務條款（EN）](/terms)
