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

選用的用戶端診斷與瀏覽器當機回報**在穩定版應用程式與 CLI 中預設關閉**；Beta 版的預設規則見下表。未登入的行銷頁、文件頁與法律條款頁絕不載入 Sentry。診斷開啟時傳送的內容：

- **錯誤與當機回報（Sentry）**：僅在已登入的應用程式內生效，嚴格關閉使用者資訊、Cookie、HTTP 標頭/請求內容、URL 查詢參數與主控台麵包屑，並對錯誤文字中的引用內容去識別化；未設定 DSN 的本機或自架建置不傳送任何回報。（Hub 伺服器端自身錯誤仍在伺服器端回報，以維持託管服務運作。）
- **第一方診斷指標（xMatrix Hub → Cloudflare Analytics Engine）**：啟動耗時（`/api/observable/startup-timing`）、新手引導步驟計數（`/api/observable/onboarding-step`）、桌面端 daemon 啟動失敗原因（`/api/observable/desktop-daemon-failure`）與 CLI 網路重連樣本（`/api/observable/client-metrics`）。識別碼在伺服器端以金鑰 HMAC-SHA-256 假名化，不包含訊息或指令內容。

### Beta 版與穩定版的預設行為

| | 穩定版應用程式與 CLI | Beta 版應用程式與 CLI |
| --- | --- | --- |
| 你已主動開啟 | 傳送 | 傳送 |
| 你已主動關閉，或開啟 Do Not Track、Global Privacy Control，或設定 `XMATRIX_TELEMETRY=0` | 不傳送 | 不傳送 |
| 未作選擇；註冊地**與**目前所在國家都不在歐盟、歐洲經濟區、英國與瑞士 | 不傳送 | 傳送，並顯示一行附關閉連結的提示 |
| 未作選擇；任一國家在歐盟、歐洲經濟區、英國或瑞士，或無法判斷 | 不傳送 | 不傳送；顯示未勾選的「Send diagnostics to help improve the beta」核取方塊 |

各列依序適用：主動開啟即使在 Do Not Track 或 Global Privacy Control 開啟時也會被尊重。只有勾選該核取方塊或在設定中切換開關（或 `xmatrix config telemetry on|off`）才算你的選擇；關閉提示不算選擇，xMatrix 也不會替你變更設定。

**如何判斷地區。** 用戶端本身沒有可靠的位置資訊（時區與語言都是使用者設定），因此由 Hub 告知：

- **註冊地區。** 建立帳號時，Hub 依 Cloudflare 回報的該請求所在國家，記錄它是否屬於需要事先同意的國家。只儲存這個類別，不儲存國家或 IP 位址，之後的請求也不會改寫它。較早建立的帳號會在第一次使用 Beta 版時記錄。刪除帳號時一併刪除。
- **目前地區。** 每次傳送前，用戶端使用 Hub 對目前連線的答覆，且不超過 10 分鐘；超過時會向 Hub 發出一個不含任何診斷資料的小請求重新詢問。若查詢失敗、逾時或國家不明，就不傳送。因此進入需要同意的國家後，預設傳送最多 10 分鐘內停止。

### 開啟或關閉診斷與當機回報

- **Web、桌面版、iOS 與 Android**：前往 **Settings → Legal and privacy**，切換 **Send diagnostics and crash reports**。你的選擇儲存在帳號上，所有用戶端都會遵循。在桌面版中，此開關也會同步更新本機 daemon 的 `telemetry` 設定。
- **桌面版啟動失敗卡片**：即使診斷已關閉，daemon 啟動失敗時你仍可在失敗卡片上按一次 **Send failure report**，只傳送該次去識別化的失敗資訊。
- **CLI 與 daemon**：以 `xmatrix config telemetry on` 或 `XMATRIX_TELEMETRY=1` 開啟；以 `xmatrix config telemetry off`、`XMATRIX_TELEMETRY=0` 或 `DO_NOT_TRACK=1` 關閉。`xmatrix config telemetry on|off` 也會把選擇儲存到帳號。

## 法律文件

- [隱私權政策（EN）](/privacy)
- [Cookie 與本機儲存聲明（EN）](/cookies)
- [子處理商清單（EN）](/subprocessors)
- [服務條款（EN）](/terms)
