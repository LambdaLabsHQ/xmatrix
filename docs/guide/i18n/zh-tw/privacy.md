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

**一句話說明：** 為了顯示你已註冊的 AI 工具還剩多少額度，xMatrix daemon 會讀取這些工具在你電腦上的登入檔案（例如 `~/.grok/auth.json`），並直接向對應服務商查詢。Codex、Claude Code 與 OpenCode 例外：xMatrix 直接詢問工具本身，不開啟它們的任何登入檔案。Codex 透過正在執行的工作階段或短暫啟動的 `codex app-server` 詢問；Claude Code 透過正在執行的工作階段或短暫啟動的 `claude` 詢問（其 `get_usage` 請求，不傳送任何提示詞）；OpenCode 透過短暫啟動的 `opencode serve` 詢問。從這些檔案讀到的任何內容（權杖、帳號 ID、檔案內容或檔案指紋）都不會傳送給 xMatrix；Hub 只收到正規化後的額度結果。同一個開關可同時停止讀取檔案、向 Codex、Claude Code 與 OpenCode 發出請求，以及向服務商發出請求（見下方「關閉本地額度探測」）。沒有官方額度介面的工具（如 Cursor），在你於那台電腦上允許之前完全不會被讀取（見下方「僅在你允許後才讀取的工具」）。OpenCode 2.2.0 以前的版本沒有官方額度介面，同樣在你於該電腦上授權前完全不讀取。

當你在本機註冊受支援的代理工具（如 Claude Code、Codex、Cursor、Grok、OpenCode、DeepSeek、Z.ai、Antigravity）時，xMatrix 可在 `xmatrix agent list` 與 Agents 頁面顯示訂閱剩餘額度，並供 `@auto` 避開已用盡的帳號。

為在不消耗模型對話的前提下查詢剩餘額度，本機 daemon 僅於記憶體內讀取對應已註冊工具的本機憑證並直連原廠端點：

| 工具 | 僅於本機記憶體讀取的位置 | 由本機直連的原廠端點 |
| --- | --- | --- |
| Claude Code | 不讀取：呼叫 Claude Code 自己的 `get_usage` 控制請求（正在執行的工作階段或短暫啟動的 `claude`），不傳送提示詞 | 由 Claude Code 使用其自身登入處理 |
| Codex | 不讀取：呼叫 Codex 自己的 app-server 方法 `account/rateLimits/read`（正在執行的工作階段或短暫啟動的 `codex app-server`） | 由 Codex 使用其自身登入處理 |
| Cursor（僅在你於那台電腦上允許後） | `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`、macOS 鑰匙圈（`cursor-access-token`）或 Cursor `auth.json` | `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| Grok Build | `GROK_CLI_OAUTH_TOKEN` 或 `~/.grok/auth.json` | `https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| OpenCode 2.2.0 及以上 | 不讀取：向短暫啟動的 `opencode serve` 請求 `GET /api/experimental/usage/limits`（僅監聽本機回送位址，使用一次性密碼）。OpenCode 路由到其他服務商的模型不讀取任何額度 | 由 OpenCode 使用其自身登入處理 |
| OpenCode 2.2.0 以前（僅在你於該電腦上授權後） | `OPENCODE_API_KEY` 或 OpenCode `auth.json` 中的 `opencode-go` 項目 | `https://opencode.ai/zen/go/v1/usage` |
| DeepSeek | `DEEPSEEK_API_KEY` 或 `$DSH_HOME` 憑證檔 | `https://api.deepseek.com/user/balance` |
| Z.ai / Zhipu | `ZAI_API_KEY` / `ZHIPU_API_KEY` | `https://api.z.ai/api/monitor/usage/quota/limit`（或 `open.bigmodel.cn`） |
| Antigravity | 直接呼叫未修改的 `agy -p "/usage" --output-format json` | 由 `agy` 自行處理 |

**嚴格邊界：**

- 憑證僅留在本機行程記憶體中，**只傳送給對應服務商自己的額度端點**。
- 本機 SHA-256 雜湊僅作記憶體快取鍵用來偵測帳號切換，**永不記錄於日誌，也永不上傳至 xMatrix**。
- 傳送給 xMatrix Hub 的僅為正規化後的剩餘額度資訊（百分比、重設時間、帳號可用狀態與預付餘額）。

### 僅在你允許後才讀取的工具

Cursor 沒有官方的額度查詢介面：唯一的辦法是讀取 Cursor 為自己保存的登入憑證。這份憑證是給 Cursor 用的，xMatrix 不把它當作授權。在電腦擁有者允許之前，xMatrix 不會讀取那台電腦上 Cursor 的任何登入來源（macOS 鑰匙圈項目 `cursor-access-token`、Cursor 的 `auth.json`，以及環境中已設定的 `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`），Cursor 的額度顯示為**未知**；額度用盡仍會根據 Cursor 自己的錯誤訊息辨識。

電腦擁有者可以在 Agents 或 Machines 檢視顯示 Cursor 額度的地方選擇 **Allow reading Cursor sign-in to show quota**，或在那台電腦上執行：

```sh
xmatrix config quotaAccess cursor on    # 允許
xmatrix config quotaAccess cursor off   # 停止
xmatrix config quotaAccess              # 查看本機已允許的工具
```

- 授權按電腦、按工具分別設定，預設關閉，並且獨立於額度探測開關：`quotaProbes` 開著不算授權。
- 憑證只在那台電腦上讀取，只用於向 Cursor 查詢它自己的用量。憑證中的任何內容都不會離開那台電腦；Hub 只收到 Cursor 回報的用量以及是否已授權。
- 授權綁定首次使用時登入的 Cursor 帳號，依據一個只保存在那台電腦 xMatrix 設定中、從不傳送的指紋。帳號或憑證一旦改變，授權即失效，最近的額度數字也會被刪除。
- 隨時可以在同一位置、在 **Settings → Legal and privacy → Reading sign-ins for quota**，或用 `xmatrix config quotaAccess cursor off` 停止，下一次讀取即被拒絕。
- 關閉本地額度探測（見下）優先於授權：即使已授權也什麼都不讀。

OpenCode 2.2.0 以前的版本同樣沒有官方額度介面，處理方式相同。未授權時，xMatrix 既不開啟 OpenCode 的 `auth.json`，也不讀取為它設定的 `OPENCODE_API_KEY`，不請求任何 OpenCode 端點，額度顯示為 **Unknown**。授權後（**Allow reading OpenCode sign-in to show quota**，或 `xmatrix config quotaAccess opencode on`），xMatrix 只讀取 OpenCode 為 OpenCode Go 儲存的金鑰，並只用於一次對 `https://opencode.ai/zen/go/v1/usage` 的請求。xMatrix 絕不代替 OpenCode 重新整理已過期的登入：額度顯示為未知並標示已過期，直到 OpenCode 重新登入。上面的帳號綁定、撤回與總開關同樣適用。從 OpenCode 2.2.0 起，xMatrix 詢問 `opencode serve`，無論是否授權都不讀取任何 OpenCode 憑證。

### 關閉本地額度探測

可在 **桌面 App → Settings → Legal and privacy → Local provider quota probes** 中關閉，或透過命令／環境變數停用：

```sh
xmatrix config quotaProbes off
# 或設定環境變數（優先度更高）
export XMATRIX_DISABLE_QUOTA_PROBES=1
```

若僅關閉 Antigravity 探測，可設定 `XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE=1`。關閉後，xMatrix 在所有路徑下均不會讀取本機服務商憑證、啟動 `codex app-server`、`claude` 或 `opencode serve`，詢問 Codex 或 Claude Code 工作階段，也不查詢原廠額度端點。

## 用戶端診斷與當機回報

xMatrix 不使用廣告 Cookie、跨站追蹤、工作階段錄影，也未整合 PostHog、Google Analytics 或 Cloudflare Web Analytics 等第三方行為分析 SDK。

選用的用戶端診斷與瀏覽器當機回報**在穩定版應用程式與 CLI 中預設關閉**；Beta 版的預設規則見下表。未登入的行銷頁、文件頁與法律條款頁絕不載入 Sentry。診斷開啟時傳送的內容：

- **錯誤與當機回報（Sentry）**：僅於登入應用內運作，只送出錯誤的類別、錯誤本身的代碼（如有）以及堆疊中的程式碼位置；錯誤訊息、麵包屑、URL、Cookie、HTTP 標頭、請求內容與使用者資訊一律不送出。未設定 DSN 的本機或自託管建置不送出任何回報。（Hub 伺服器端自身錯誤仍於伺服器端回報以維持託管服務運作，見下文。）
- **第一方診斷指標（xMatrix Hub → Cloudflare Analytics Engine）**：回報啟動耗時（`/api/observable/startup-timing`）、新手引導步驟計數（`/api/observable/onboarding-step`）、桌面端 daemon 啟動失敗資訊（`/api/observable/desktop-daemon-failure`）與 CLI 網路重連樣本（`/api/observable/client-metrics`）。識別碼於伺服器端以金鑰 HMAC-SHA-256 假名化。

### 診斷事件可以包含什麼

每個診斷事件都有一組宣告好的欄位，用戶端建立時檢查一次，Hub 接收時再檢查一次。欄位只能是清單中的固定值、數字、true/false、版本號、不透明識別碼，或像 `websocket_connect_failed` 這樣的短代碼（小寫字母、數字、`_` 與 `-`）。只要出現未宣告的欄位或超出欄位範圍的值，整個事件就會被拒絕，而不是被截成合規的樣子，因此你寫下的文字沒有任何欄位可以夾帶。錯誤只以類別與代碼回報，絕不包含錯誤訊息。

只有以下兩條路徑會攜帶文字：

- **桌面端啟動失敗卡片上的「送出失敗報告」**：CLI 的最後幾行輸出，桌面應用程式會先在你的電腦上遮蔽（家目錄、電子郵件地址、URL 查詢參數以及任何看似權杖或金鑰的內容都會被替換）。卡片會先顯示這些內容，只有你按下按鈕才會送出；開啟診斷時自動送出的回報只包含失敗階段、結束代碼、平台與應用程式版本。
- **Hub 伺服器端錯誤回報**：伺服器自身的錯誤訊息，其中引用的值、電子郵件地址、URL 查詢參數、家目錄路徑與看似權杖的字串都會被移除。記錄附帶的欄位只有在是數字、true/false 或不透明識別碼時才會回報。

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
- **CLI 與 daemon**：預設關閉；可透過 `xmatrix config telemetry on` 或 `XMATRIX_TELEMETRY=1` 開啟，並隨時以 `xmatrix config telemetry off`、`XMATRIX_TELEMETRY=0` 或 `DO_NOT_TRACK=1` 關閉。
- **CLI 與 daemon**：以 `xmatrix config telemetry on` 或 `XMATRIX_TELEMETRY=1` 開啟；以 `xmatrix config telemetry off`、`XMATRIX_TELEMETRY=0` 或 `DO_NOT_TRACK=1` 關閉。`xmatrix config telemetry on|off` 也會把選擇儲存到帳號。

## 把對話交給 xMatrix 支援

只有在你把對話交給支援時，xMatrix 的工作人員和 Agent 才會讀你的對話。產品分析只用中繼資料，從不使用你寫的內容。

需要協助時，在對話選單裡、在 xMatrix 發出的故障通知上（啟動失敗、反覆失敗、幾分鐘沒有進展），或在對話開啟時從 **Help → Report an issue** 選擇 **Hand to xMatrix support**。然後：

- 用一句話寫下出了什麼問題。
- 勾選要包含的內容。預設什麼都不勾：
  - **This conversation's messages**，包括其中的子討論串。
  - **Diagnostics for this conversation**：Agent 在這裡何時啟動、停止或失敗，以及失敗代碼。這些是只含狀態、代碼、計數和時間的診斷事件：沒有訊息內文、提示詞、錯誤訊息或 ID。
- 勾選 **I agree to let xMatrix support read what I selected**。不勾選就什麼都不會送出。

這次交接允許的範圍：

- **誰來讀：** xMatrix 支援，也就是 xMatrix 團隊及其支援 Agent，在為這次交接開設的支援對話裡處理。
- **唯讀：** 支援依你能看到的樣子讀取你勾選的內容，不能在你的對話裡寫入、回應或啟動任何東西。支援的答覆以「xMatrix support」的訊息出現在你的對話裡，或透過電子郵件寄給你。
- **多久：** 14 天。你，或你所在空間的擁有者或管理員，隨時可以在它留在對話裡的說明上按 **Withdraw now**。撤回或到期後立刻停止讀取。
- **每次讀取你都看得到：** 支援在任一小時內第一次讀取時，你的對話會顯示「xMatrix support read this conversation」和時間。
- 只有對話的發起人，或其空間的擁有者或管理員，才能交出這個對話。

## 法律文件

- [隱私權政策（EN）](/privacy)
- [Cookie 與本機儲存聲明（EN）](/cookies)
- [子處理商清單（EN）](/subprocessors)
- [服務條款（EN）](/terms)
