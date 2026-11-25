import type { AlternativeLocaleCopy, AlternativeSlug } from "../types";

/** Traditional Chinese (zh-TW) copy for all competitor alternative pages. */
export const alternativesCopyZhTw: Readonly<Record<AlternativeSlug, AlternativeLocaleCopy>> = {
  raft: {
    alsoKnownAs: "原名 Slock",
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Raft 替代方案 (2026)：Raft vs xMatrix",
    metaDescription:
      "正在尋找 Raft（Slock）替代方案？比較 Raft vs xMatrix：用即時更新的即時頁面取代沉在聊天紀錄裡的決策與已下線的 Wiki Agent、支援 34 種程式設計代理，以及 40 多個受控管應用。",
    eyebrow: "Raft 替代方案 · Raft vs xMatrix",
    headline: "Raft vs xMatrix",
    lead: "Raft 將開發 Agent 視為聊天室隊友，並於 2026 年 9 月下線了 Wiki Agent。xMatrix 保留了人與 34 種程式設計代理共享的頻道，Agent 會把完成的工作記錄在全隊共讀的即時頁面（Pages）中，並以個別應用權限控管 40 多個整合工具。",
    productCaption:
      "xMatrix 實景：團隊成員與開發 Agent 在頻道（Channels）中即時協作，同步更新共享的動態專案頁面，不再讓脈絡散落在聊天捲軸與本機 MEMORY.md 檔案中。",
    painPoints: [
      {
        title: "工作成果困在聊天紀錄與單機 MEMORY.md 檔案裡",
        problem:
          "Raft 於 2026 年 9 月 24 日下線了 Wiki Agent，讓每個 Agent 仍綁定在單一電腦的本機 MEMORY.md 與 notes/ 目錄。一旦 Agent 早期寫下錯誤假設，過時脈絡便會在交接間持續殘留，直到人工手動清理；且 Free 方案的工作區歷史紀錄僅保留 30 天。",
        xmatrixAnswer:
          "xMatrix 將即時頁面設為產品的核心產出。工作落地時 Agent 會更新對應章節；若成員正在編輯某個段落，Agent 會先等待並接續成員寫下的內容。",
      },
      {
        title: "Stamp 僅涵蓋 GitHub——維運連接器缺少統一的核准層",
        problem:
          "Raft 的 Stamp 僅針對 GitHub push 與 PR 提供人工核准，但實際交付軟體的團隊還得操作 Vercel、Cloudflare、Linear、Sentry、Gmail、Stripe 與 Google Workspace。除此之外，Raft 的 Agent 執行環境啟動時會直接略過權限檢查。",
        xmatrixAnswer:
          "xMatrix 在 40 多個整合應用上套用統一的個別應用權限（唯讀、先詢問或讀寫，其中 GitHub 提供唯讀與讀寫），而 xmatrix secret exec 會將 Space 機密傳入指令的執行環境，不會將其印出或放進聊天中。",
      },
      {
        title: "Pro 方案仍對 Agent 收取席位費，且綁定單一電腦",
        problem:
          "在 Raft Pro（每位人類成員 US$10／月，年繳 US$8.80）中，每個 Agent 會占用 0.1 個席位，且每個 Agent 都固定綁定在一台電腦上——只要該筆電離線，Agent 就跟著停擺。",
        xmatrixAnswer:
          "xMatrix 以 Agent 零席位費在所有註冊的 macOS、Windows 與 Linux 主機上支援 34 種程式設計代理（並可透過 --runtime 接入任何自訂 CLI），依適配度與可用餘裕自動路由任務。",
      },
    ],
    comparisonRows: [
      {
        dimension: "專案狀態保存位置",
        xmatrix: "由 Agent 持續維護、與人共同編輯的即時頁面（Pages）",
        competitor: "聊天討論串、編號任務與單機 MEMORY.md（Wiki Agent 已下線）",
      },
      {
        dimension: "核准機制與機密管理",
        xmatrix: "40 多個應用的個別權限 + Space 機密；各主機擁有者為每個代理工具選擇完全存取或先詢問",
        competitor: "僅針對 GitHub push/PR 提供 Stamp；本機代理權杖；執行環境略過權限檢查",
      },
      {
        dimension: "代理數量與定價",
        xmatrix: "34 種程式設計代理（含 --runtime）；Free（500 次終身寫入）／Pro US$10／人類席位／月（年繳 US$8）",
        competitor: "支援執行環境較少；Free（30 天歷史）；Pro US$10／席位／月（年繳 US$8.80）+ 每個 Agent 0.1 席位",
      },
      {
        dimension: "路由與故障轉移",
        xmatrix: "@auto 依適配度與主機餘裕挑選代理；達配額上限時跨供應商自動交接",
        competitor: "每個 Agent 綁定單一執行環境；供應商或主機中斷即停止",
      },
      {
        dimension: "原始碼公開程度",
        xmatrix: "採 FSL-1.1-ALv2 授權公開原始碼（Source-available）",
        competitor: "公開原始碼鏡像；Enterprise SSO 尚未推出",
      },
    ],
    stayWhen: [
      "你偏好即時通訊搭配任務清單的介面，且 30 天免費無限聊天比持續更新的專案文件更重要。",
      "你的核准需求僅限於透過 Stamp 控管的 GitHub push 與 Pull Request。",
    ],
    switchWhen: [
      "你的團隊受夠了翻找聊天紀錄或排查過時的本機 MEMORY.md，只為確認目前到底上線了什麼。",
      "Agent 需要在單一 Space 機密庫保護下，安全存取 Vercel、Cloudflare、Linear、Sentry、Gmail 或 Stripe。",
      "你需要跨多台主機執行數十個專職或短期 Agent，不想承擔每個 Agent 0.1 席位的額外費用。",
    ],
    migrationSteps: [
      {
        title: "保留現有的本機儲存庫與 CLI 訂閱",
        detail:
          "在原本執行 Raft Computer 的同一批 macOS、Windows 或 Linux 主機上安裝 xMatrix CLI，原本的 Claude Code、Codex 或 Cursor 登入狀態全數留在本機。",
      },
      {
        title: "將釘選的頻道脈絡升級為即時頁面",
        detail:
          "為每個進行中的專案或產品線建立專屬頁面，讓所有 Agent 統一讀取最新決策，不再維護各自發散的 MEMORY.md 檔案。",
      },
      {
        title: "將 API 權杖移入 Space 機密並連結外部應用",
        detail:
          "連結 GitHub（唯讀或讀寫）以及套用「先詢問」原則的 Linear、Vercel、Cloudflare 或 Sentry，其餘憑證則集中存放於 Space 機密。",
      },
    ],
    faqs: [
      {
        question: "既然兩者都有人與 Agent 共用的頻道，xMatrix 與 Raft 的核心差異是什麼？",
        answer:
          "在 Raft 中，聊天訊息與任務就是最終紀錄，其 Wiki Agent 也已經下線。在 xMatrix 中，對話只是推動工作的場所，真正保存決策、現況與待辦事項的是持續更新的即時頁面。",
      },
      {
        question: "xMatrix 會像 Raft Pro 一樣對每個 Agent 收取 0.1 個席位費嗎？",
        answer:
          "不會。無論 Free 或 Pro 方案，Agent 都完全不占席位。Pro 方案為每位人類成員 US$10／月（年繳 US$96／席位／年），每月每席位包含 5,000 點 Agent 額度，而人類成員的編輯與訊息皆免費。",
      },
      {
        question: "xMatrix 是否也支援像 Raft 一樣的私人頻道？",
        answer: "支援。每個 Space 都同時提供公開與私人頻道，並搭配 Space 層級機密與個別應用程式核准原則。",
      },
    ],
  },
  lody: {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Lody 替代方案 (2026)：Lody vs xMatrix",
    metaDescription:
      "正在比較 Lody 替代方案？告別單一工作階段 worktree 與背景服務斷線問題，改用 xMatrix 的多人共享頻道、即時頁面、Space 機密與 Webhook 自動化。",
    eyebrow: "Lody 替代方案 · Lody vs xMatrix",
    headline: "Lody vs xMatrix",
    lead: "Lody 以「一個 worktree 對應一個獨立工作階段」為核心，並透過閉源雲端中繼同步。xMatrix 讓隊友與 34 種程式設計代理齊聚同一個共享頻道、隨工作落地持續更新即時頁面，並加上 Space 機密與事件驅動的 Norn 程式。",
    productCaption:
      "xMatrix 實景：不再逐一轉交孤立的開發工作階段，而是讓隊友與 34 種程式設計代理在同一個頻道即時協作，並將成果沉澱到即時頁面中。",
    painPoints: [
      {
        title: "以單一工作階段為中心的體驗，缺乏共享團隊頻道與動態文件",
        problem:
          "Lody 圍繞個人開發工作階段與子工作階段樹設計；雖然隊友間可以移交工作階段，但多人多 Agent 共享頻道、成員 @提及與共享專案文件仍停留在路線圖，並非核心工作流程。",
        xmatrixAnswer:
          "xMatrix 從第一天起就讓多位成員與多個 Agent 同處一個頻道，且 Agent 會將完成的工作寫回追蹤專案現況的共享頁面。",
      },
      {
        title: "跨裝置背景服務心跳斷線與 worktree 鎖定衝突",
        problem:
          "社群回饋與 GitHub Issue 追蹤（LodyAI/Lody 目前有 334 個未解決 Issue，包含持續追蹤每日桌面端 E2E 測試的 #507）都指出遠端 npx lody daemon 斷線、登入連結逾時、並行 git worktree 鎖定錯誤與 ACP 紀錄凍結等問題。",
        xmatrixAnswer:
          "xMatrix 將 Hub 權限控管與本機 daemon 執行清楚分離，搭配有界結果佇列與明確的執行生命週期轉換，重連時能乾淨恢復狀態而不遺失進度。",
      },
      {
        title: "缺乏工作區層級機密、應用核准原則與 Webhook 自動化",
        problem:
          "Lody 僅依單一工作階段設定權限，沒有工作區機密庫，也缺少維運工具的個別應用治理，且自動化僅支援定時 cron 而無法接收外部 Webhook 事件觸發。",
        xmatrixAnswer:
          "xMatrix 提供執行時注入的 Space 層級機密、涵蓋 40 多個整合工具的個別應用核准控管，以及內嵌於頁面、可由排程或 GitHub、Sentry 等外部事件觸發的 Norn 程式。",
      },
    ],
    comparisonRows: [
      {
        dimension: "核心協作單位",
        xmatrix: "由多人多 Agent 頻道支撐的即時頁面（Pages）",
        competitor: "個人工作階段與子工作階段樹（每個工作階段對應一個 worktree）",
      },
      {
        dimension: "機密與外部維運工具",
        xmatrix: "Space 層級機密（xmatrix secret exec）+ 40 多個受控管應用整合",
        competitor: "僅限單一工作階段權限；無工作區機密庫",
      },
      {
        dimension: "自動化觸發方式",
        xmatrix: "內嵌於頁面的排程與事件驅動 Norn 程式",
        competitor: "定時 cron 任務與配額重置恢復；無 Webhook 觸發",
      },
      {
        dimension: "代理廣度與路由能力",
        xmatrix: "34 種程式設計代理（含 --runtime），依適配度、餘裕與配額交接自動路由",
        competitor: "原地等待同一供應商的配額重置後再恢復",
      },
      {
        dimension: "定價方案",
        xmatrix: "Free（最多 3 人、500 次終身寫入）／Pro US$10／席位／月（年繳 US$8）",
        competitor: "Free（3 人、2 個工作區）／Plus US$8／席位／月（年繳）／Enterprise",
      },
    ],
    stayWhen: [
      "你特別偏好搭配工作階段樹模型的 iOS 動態島（Dynamic Island）鎖定畫面核准流程。",
      "你的團隊只需要協調寫程式工作階段，不需要動態文件或非 Git 類的維運連接器。",
    ],
    switchWhen: [
      "你需要多位隊友與不同執行工具在同一個即時頻道協作，而不是來回轉交單一工作階段。",
      "你需要透過易讀的即時頁面維護專案狀態，同時整合 Webhook 例行任務與 Space 機密。",
      "背景服務同步異常或 worktree 鎖定衝突正在拖慢你的遠端跨主機開發節奏。",
    ],
    migrationSteps: [
      {
        title: "在相同主機上註冊 xMatrix 背景服務",
        detail:
          "保留你原本的 Claude Code、Codex、Kimi 或相容 ACP 的 CLI；xMatrix 會自動偵測並註冊，完全不需更換原有訂閱。",
      },
      {
        title: "以專案頁面與頻道取代跳躍式工作階段管理",
        detail:
          "將每個活躍儲存庫連結到 Space 頁面，讓人與 Agent 在同一討論串協作並把長期有效的結論寫回頁面。",
      },
      {
        title: "接入 GitHub、Sentry 與部署連接器",
        detail: "掛接外部事件來源，讓例行任務能自動喚醒 Agent 處理，不再只能手動啟動工作階段。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 是否也能像 Lody 一樣在自己的電腦上執行開發 Agent？",
        answer:
          "可以。Agent 會直接在你註冊的 macOS、Windows、Linux 電腦（或你自管的伺服器）上，於你指定的資料夾與儲存庫中運行。",
      },
      {
        question: "面對供應商速率限制時，xMatrix 與 Lody 的處理方式有何不同？",
        answer:
          "xMatrix 不會卡住等待單一供應商的配額重置，而是能將對話直接交接給另一款可用的執行工具——例如從 Claude Code 交接給 Codex 或 Gemini。",
      },
      {
        question: "xMatrix 的同步伺服器是否像 Lody 一樣是閉源的？",
        answer:
          "xMatrix 採用 FSL-1.1-ALv2 授權完整公開 Hub、Web、CLI 與用戶端原始碼，目前則以自助式託管服務提供，而非自架套件。",
      },
    ],
  },
  multica: {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Multica 替代方案 (2026)：Multica vs xMatrix",
    metaDescription:
      "評估 Multica 替代方案？擺脫無頭工單執行、#9559 靜默丟失 bypassPermissions 限制與明文環境變數，改用 xMatrix 的即時頻道、即時頁面與 Space 機密。",
    eyebrow: "Multica 替代方案 · Multica vs xMatrix",
    headline: "Multica vs xMatrix",
    lead: "Multica 強制把每項 Agent 任務都塞進預設 bypassPermissions 的無頭看板工單，且缺乏動態文件層。xMatrix 讓團隊與 34 種程式設計代理在頻道即時協作（或透過 xmatrix claude 在你自己的終端機中啟動 Claude Code，並以頻道成員身分加入）、由 Agent 保持即時頁面最新，並以 Space 機密治理 40 多個整合工具。",
    productCaption:
      "xMatrix 實景：在共享頻道與隊友一同即時引導 Claude Code、Codex 與其餘 32 種程式設計代理，搭配明確的應用核准與即時頁面，取代盲跑的無頭看板工單。",
    painPoints: [
      {
        title: "預設強制啟用 bypassPermissions、權限限制曾靜默失效，且伺服器以明文存放環境變數",
        problem:
          "Multica 啟動 Claude Code 時預設加上 --permission-mode bypassPermissions、啟動 Codex 時採 full-auto 模式，且以明文在伺服器存放環境變數。社群回報的漏洞 #9559 更揭露 custom_args 會靜默丟棄使用者設定的 --permission-mode 限制。",
        xmatrixAnswer:
          "xMatrix 透過個別應用的「唯讀」、「先詢問」或「讀寫」權限治理 40 多個整合應用的外部操作，並由 xmatrix secret exec 將 Space 機密傳入指令的執行環境，讓機密永遠不會出現在對話紀錄裡。每台主機的擁有者在新增代理工具時，都會為其選擇完全存取或先詢問。",
      },
      {
        title: "所有工作都得開成無頭工單——沒有共享頻道，也不能掛接互動工作階段",
        problem:
          "Multica 內建聊天僅限私人一對一對話，整個流程要求把工作轉成無頭看板工單，並不支援在中途即時微調方向，或把進行中的本機終端機工作階段拉進團隊對話裡。",
        xmatrixAnswer:
          "xMatrix 讓隊友與 34 種程式設計代理在共享頻道中即時協作——執行 xmatrix claude 即可在你的終端機中啟動 Claude Code，並以即時成員身分加入頻道，同時由 Agent 將成果寫回即時頁面。",
      },
      {
        title: "缺乏即時頁面與內建專案記憶",
        problem:
          "Multica 只追蹤工單與技能，不維護持續演進的專案現況——社群提出的記憶功能請求（#838）自 2026 年 4 月以來一直未獲回應，導致決策散落在已關閉的工單中。",
        xmatrixAnswer:
          "每個 xMatrix Space 都原生內建即時頁面。每項決策只寫一次，支援人機共同編輯（具備建議模式與逐段署名），並由實際動手做的 Agent 保持最新。",
      },
    ],
    comparisonRows: [
      {
        dimension: "協作模式",
        xmatrix: "多人多 Agent 共享頻道 + 在你終端機中執行的 xmatrix claude + 即時頁面（Pages）",
        competitor: "看板工單 + 僅限無頭背景執行 + 私人 1 對 1 聊天",
      },
      {
        dimension: "外部操作與機密管理",
        xmatrix: "40 多個應用的個別權限 + 傳入指令、絕不顯示於聊天中的 Space 機密",
        competitor: "預設 bypassPermissions（#9559）；伺服器明文環境變數；MCP schema 核准",
      },
      {
        dimension: "動態文件",
        xmatrix: "原生即時頁面由 Agent 更新；支援建議模式、逐段署名與無鎖定共同編輯",
        competitor: "無（記憶功能請求 #838 尚未解決）",
      },
      {
        dimension: "支援的程式設計代理",
        xmatrix: "內建 34 種程式設計代理（另可透過 --runtime 接入任何自訂 CLI）",
        competitor: "28 種 CLI 執行環境",
      },
      {
        dimension: "外部維運連接器",
        xmatrix: "40 多個原生整合工具（GitHub、Linear、Vercel、Cloudflare、Sentry、Gmail、Stripe 等）",
        competitor: "聊天橋接（Slack、Lark、DingTalk、WeCom、Telegram）+ MCP 外掛",
      },
    ],
    stayWhen: [
      "你的組織明確要求在內網自架 Go + PostgreSQL 的工單看板自動化系統。",
      "你的團隊本來就習慣把每個工作單位都拆成獨立看板工單，且高度依賴 DingTalk、WeCom 或 Lark 觸發。",
    ],
    switchWhen: [
      "你想要與隊友及多個開發 Agent 即時互動並隨時微調方向，而不是盲跑的無頭工單。",
      "伺服器明文環境變數與 bypassPermissions 預設設定無法通過你的正式部署或維運安全要求。",
      "你希望專案決策與待辦事項由你的 Agent 整理在即時頁面裡，而不是深埋在已關閉的工單紀錄中。",
    ],
    migrationSteps: [
      {
        title: "連接現有的開發主機",
        detail:
          "在原本跑 Multica 背景服務的主機安裝 xMatrix CLI，再以 xmatrix agent add 加入你本機的 Claude Code、Codex 與 Cursor 設定。",
      },
      {
        title: "將重複性 Autopilot 任務搬進頁面的 Norn 例行任務",
        detail:
          "把排程與事件觸發的例行任務直接寫在對應的專案頁面裡，讓每次執行完畢都同步更新大家閱讀的現況。",
      },
      {
        title: "用 Space 機密取代明文環境變數",
        detail: "把權杖存入 xMatrix Space 機密，並為 GitHub（唯讀或讀寫）以及 Linear、Sentry 或 Vercel 設定明確的權限原則。",
      },
    ],
    faqs: [
      {
        question: "離開 Multica 的看板後，xMatrix 可以繼續搭配 Linear 或 GitHub Issues 使用嗎？",
        answer:
          "完全可以。xMatrix 原生整合 GitHub 與 Linear，讓 Agent 直接讀取 Issue、開 PR 並更新專案頁面，不必放棄你原本的追蹤系統。",
      },
      {
        question: "xMatrix 會強制 Claude Code 以 bypassPermissions 模式執行嗎？",
        answer:
          "不會。新增代理工具時，由該主機的擁有者選擇其存取方式：完全存取（對 Claude Code，xMatrix 會加上 --dangerously-skip-permissions）或先詢問，此時每個權限請求都會在頻道中詢問。已連結應用另外支援唯讀、先詢問與讀寫模式，Space 機密的值也絕不會出現在聊天中。",
      },
      {
        question: "在 xMatrix 中可以由多位成員同時監看並引導同一個 Agent 嗎？",
        answer: "可以。成員與 Agent 共用同一個頻道，可即時檢視執行軌跡與核准卡片，並共同編輯連結的頁面。",
      },
    ],
  },
  paradev: {
    alsoKnownAs: "原名 Superset",
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Paradev / Superset 替代方案 (2026)：vs xMatrix",
    metaDescription:
      "正在找 Paradev（Superset）替代方案？在 macOS、Windows、Linux 與 Android 上以 US$10／席位執行開發團隊，享有共享頻道、即時頁面與 40 多個應用權限控管。",
    eyebrow: "Paradev (Superset) 替代方案 · Paradev vs xMatrix",
    headline: "Paradev vs xMatrix",
    lead: "Paradev（2026 年 10 月由 Superset 更名）以 macOS 為主、團隊版價格直跳 US$60／人／月，且開啟遠端主機即暴露整台電腦。xMatrix 橫跨 macOS、Windows、Linux、Android 與 Web，以每位人類成員 US$10／月提供共享頻道、即時頁面與 40 多個受控管整合工具。",
    productCaption:
      "xMatrix 實景：透過清爽的頻道與即時頁面統籌數十個並行 Agent 對話，不必在 20 個終端機分割視窗之間疲於奔命。",
    painPoints: [
      {
        title: "滿螢幕終端機與 worktree 氾濫，把瓶頸轉嫁到你的注意力上",
        problem:
          "Product Hunt 與 Reddit 開發者雖然肯定 Paradev 的並行 worktree 能力，卻普遍反映同時盯著數十個獨立終端機、diff 面板與重疊分支會造成嚴重的視覺雜亂與審查疲勞，而且缺乏內建的雲端自動化支出上限，底層 LLM 帳單很容易失控。",
        xmatrixAnswer:
          "xMatrix 把操作重心從「盯緊每個終端機」翻轉為「讀專案的即時頁面」。對話在背景推進，你只需瀏覽頁面，有決策或例外狀況時再切入討論串。",
      },
      {
        title: "遠端與團隊協作需跨過 US$20–$60／席位的高額付費牆",
        problem:
          "Paradev 本機用戶端雖然免費（MIT），但遠端功能需要 Pro（US$20／人／月，年繳 US$192），團隊協作更跳升至 US$60／人／月——這還不包含你原本要付的 Anthropic 與 OpenAI 訂閱費用。",
        xmatrixAnswer:
          "xMatrix Pro 僅需每位人類成員 US$10／月（年繳 US$8／月），不限 Agent 數量、每席位含 5,000 點 Agent 額度與跨主機頻道，沒有額外的團隊版加價。",
      },
      {
        title: "開啟中繼即暴露整台主機，且缺少 Space 機密與維運連接器",
        problem:
          "Paradev 沒有 Space 層級機密與跨應用的核准治理層；一旦開放遠端中繼存取，實質上等於將整台主機暴露給已授權的隊友。",
        xmatrixAnswer:
          "xMatrix 會在你註冊的儲存庫與目錄中啟動 Agent，讓每台主機的擁有者為每個代理工具選擇完全存取或先詢問，將 Space 機密傳入指令而不印出，並在 40 多個整合工具上強制執行個別應用權限。",
      },
    ],
    comparisonRows: [
      {
        dimension: "團隊方案定價",
        xmatrix: "US$10／人類席位／月（年繳 US$8／月）；3 人以下免費（500 次終身寫入）",
        competitor: "Free（本機單人）／Pro US$20／人／月／Team US$60／人／月（含 150 雲端小時）",
      },
      {
        dimension: "核心工作流程",
        xmatrix: "共享頻道 + 由 Agent 隨工作完成更新的即時頁面（Pages）",
        competitor: "並行 IDE／worktree 工作區 + 可釘選留言的已發布頁面",
      },
      {
        dimension: "Agent 執行位置",
        xmatrix: "你自有的 macOS、Windows、Linux 主機（筆電、桌機或自管伺服器）",
        competitor: "macOS 優先本機 IDE、遠端 SSH／中繼主機，或 Vercel 雲端沙盒",
      },
      {
        dimension: "機密與維運應用",
        xmatrix: "Space 層級機密庫 + 40 多個具個別核准原則的整合工具",
        competitor: "行內工作區外核准；無 Space 機密；僅支援開發類觸發",
      },
      {
        dimension: "多人即時聊天協作",
        xmatrix: "原生多人多 Agent 公開與私人頻道",
        competitor: "工作區與頁面留言；無共享多 Agent 團隊頻道",
      },
    ],
    stayWhen: [
      "你明確需要 Paradev 開箱即用的 Vercel 雲端沙盒，希望筆電闔蓋時不必自建 VM 也能持續跑工作區。",
      "你偏好以視覺化 worktree diff 與元素釘選審查留言為核心的 IDE 式桌面應用。",
    ],
    switchWhen: [
      "在 Claude／Codex 訂閱之外再付 US$20–$60／席位，對協調自有主機的小團隊來說負擔過重。",
      "你希望 20 個並行討論串中的 Agent 把成果寫進即時頁面，而不是在 20 個終端機分頁間來回切換。",
      "你的 Agent 需要受控管地存取 Cloudflare、Vercel、Gmail、Stripe、Sentry 或 Google Workspace，而不只限於 git worktree。",
    ],
    migrationSteps: [
      {
        title: "在 xMatrix 註冊你的 macOS、Linux 或 Windows 主機",
        detail: "把現有的工作站或你自管的常駐 Linux 伺服器納入同一個 Space，不受限於 macOS 專用用戶端。",
      },
      {
        title: "用專案頁面取代多分頁監看",
        detail: "在連結至該頁面的頻道裡召喚 Agent，讓它們把每個 PR、測試結果與決策寫回頁面。",
      },
      {
        title: "集中管理憑證與應用權限",
        detail: "為已連結應用程式設定「唯讀」或「先詢問」原則，並將共用權杖存入 Space 機密。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 是否像 Paradev Team 一樣提供託管雲端沙盒？",
        answer:
          "目前不提供——xMatrix 會在你掌控的電腦與自管雲端 VM（macOS、Windows、Linux）上執行 Agent。如果你已經有常駐 VPS 或建置伺服器，xMatrix 可以把它與你的筆電順暢整合在同一個 Space 中。",
      },
      {
        question: "xMatrix 如何避免 Paradev 的終端機雜亂問題？",
        answer:
          "你不必逐一檢查數十個原始終端機視窗，xMatrix 的 Agent 會把每個對話的成果寫回連結的即時頁面，讓你直接在那裡掃描目前現況。",
      },
      {
        question: "Superset 真的更名為 Paradev 了嗎？",
        answer:
          "是的。Superset 於 2026 年 10 月正式更名為 Paradev（GitHub 為 ParadevAI/Paradev）。本頁所有資訊均反映截至 2026 年 11 月 22 日的 Paradev 最新定價與架構。",
      },
    ],
  },
  conductor: {
    verifiedDate: "2026 年 11 月 22 日",
    statusNote: "已於 2026 年 11 月被 Meta 收購——Conductor Cloud 已於 2026 年 11 月 20 日正式關閉。",
    metaTitle: "Conductor 替代方案 (2026)：Meta 關閉雲端後首選 xMatrix",
    metaDescription:
      "Conductor 已被 Meta 收購並於 2026 年 11 月 20 日關閉 Conductor Cloud。立即遷移至 xMatrix，以 US$10／席位跨 macOS、Windows 與 Linux 執行 Claude Code 與 Codex 團隊。",
    eyebrow: "Conductor 替代方案 · Meta 收購後遷移指南",
    headline: "在 Meta 關閉後告別 Conductor",
    lead: "Meta 於 2026 年 11 月收購 Conductor、停止新用戶註冊，並在 2026 年 11 月 20 日關閉 Conductor Cloud，僅 macOS 專屬本機版維持維護至 2027 年初。xMatrix 是持續活躍且獨立營運的新家，讓你的 34 種程式設計代理橫跨 macOS、Windows 與 Linux 運行，並把團隊脈絡保存在即時頁面中。",
    productCaption:
      "xMatrix 實景：將從 Conductor 匯出的儲存庫與 Claude Code／Codex 登入無縫帶入跨作業系統工作區，涵蓋 macOS、Windows、Linux、iPhone 與 iPad、Android 以及 Web。",
    painPoints: [
      {
        title: "Conductor Cloud 已走入歷史，產品路線圖逐步收尾",
        problem:
          "在 Meta 2026 年 11 月收購之後，Conductor Cloud 於 11 月 13 日轉為唯讀，並於 2026 年 11 月 20 日永久關閉。新使用者無法加入，隨著團隊轉入 Meta Superintelligence Labs，本機版也僅提供關鍵修復至 2027 年初。",
        xmatrixAnswer:
          "xMatrix 維持高頻活躍開發、採 FSL-1.1-ALv2 公開原始碼，專為長期獨立運作的團隊打造，提供自助式定價且不依附任何科技巨頭收購方。",
      },
      {
        title: "僅支援 macOS 的平台綁定，將 Windows 與 Linux 隊友拒於門外",
        problem:
          "Conductor 獨立營運期間始終未推出原生 Windows 或 Linux 支援，迫使混合平台工程團隊必須拆分工具，或為了共用工作區而額外添購 Mac。",
        xmatrixAnswer:
          "xMatrix 支援 macOS、Windows、Linux、iPhone 與 iPad、Android 以及 Web，讓 Linux 建置伺服器、Windows 開發機與 MacBook 共處同一個 Space。",
      },
      {
        title: "關閉前定價高達 US$50–$60／月，且缺乏動態專案頁面",
        problem:
          "Conductor 過往 Pro 方案收費 US$50／月、Teams 為 US$60／人／月，長對話紀錄容易造成介面卡頓，且知識分散在獨立工作區中，沒有共享的動態文件。",
        xmatrixAnswer:
          "xMatrix Pro 為每位人類成員 US$10／月（年繳 US$8／月），在 34 種程式設計代理下不限 Agent 數量，由 Agent 將完成的工作記錄在即時頁面中，並附帶 40 多個受控管整合工具與 Space 機密。",
      },
    ],
    comparisonRows: [
      {
        dimension: "產品狀態（2026 年 11 月）",
        xmatrix: "活躍開發、獨立營運、開放註冊、公開原始碼",
        competitor: "已被 Meta 收購；Cloud 於 2026 年 11 月 20 日關閉；停止新用戶註冊",
      },
      {
        dimension: "支援作業系統",
        xmatrix: "macOS、Windows、Linux、iPhone 與 iPad、Android 以及 Web",
        competitor: "僅支援 macOS 與 iOS；無原生 Windows 或 Linux 支援",
      },
      {
        dimension: "定價方案",
        xmatrix: "免費方案（500 次終身寫入）+ Pro US$10／人類席位／月（年繳 US$8／月）",
        competitor: "原為 Pro US$50／月、Teams US$60／人／月（關閉時已退款）",
      },
      {
        dimension: "多 Agent 產出形式",
        xmatrix: "即時頁面（Pages）+ 支援 34 種程式設計代理的多人共享頻道",
        competitor: "並行 worktree 工作階段與 diff 檢視",
      },
      {
        dimension: "治理與外部連接器",
        xmatrix: "40 多個應用個別權限原則 + Space 機密",
        competitor: "本機 Agent 以完整作業系統使用者權限運行；無維運核准層",
      },
    ],
    stayWhen: [
      "你已經將 Conductor Cloud 工作區匯出至本機 Mac，且僅需要撐到 2027 年初前的短期過渡方案。",
    ],
    switchWhen: [
      "你在 11 月 20 日失去了 Conductor Cloud，現在就需要一個活躍且支援跨主機的 Claude Code 與 Codex 工作區。",
      "你的團隊除了 Mac 之外，還同時使用 Windows 或 Linux 主機。",
      "你希望享有 US$10／席位定價、動態專案頁面，以及 GitHub、Linear、Vercel 與 Cloudflare 的受控管連接器。",
    ],
    migrationSteps: [
      {
        title: "直接沿用從 Conductor 匯出的本機儲存庫",
        detail:
          "若你使用了 Conductor 的「Transfer to local」匯出功能，Git 儲存庫與分支都已經在硬碟上——xMatrix 可直接對接這些資料夾。",
      },
      {
        title: "連接你的主機與現有訂閱",
        detail:
          "在 Mac、Linux VPS 或 Windows 主機安裝 xMatrix CLI，透過 xmatrix agent add 加入既有的 Claude Code、Codex 或 Cursor 工具。",
      },
      {
        title: "建立團隊 Space 並連接 GitHub",
        detail: "邀請隊友加入、為各個產品線建立即時頁面，擺脫 macOS 與單一廠商綁定，持續執行並行 Agent。",
      },
    ],
    faqs: [
      {
        question: "我可以將從 Conductor Cloud 匯出的工作區遷移至 xMatrix 嗎？",
        answer:
          "可以。任何已轉移至本機或託管於 GitHub 的 Git 儲存庫都能立即註冊進 xMatrix，並繼續使用你原本已訂閱的 Claude Code 與 Codex。",
      },
      {
        question: "xMatrix 除了 macOS 之外，也支援 Windows 與 Linux 嗎？",
        answer:
          "是的。與僅限 macOS 的 Conductor 桌面版不同，xMatrix 在同一個 Space 內同時支援 macOS、Windows 與 Linux 主機，並提供網頁與行動端。",
      },
      {
        question: "xMatrix 會像 Conductor Cloud 一樣提供託管雲端 VM 嗎？",
        answer:
          "xMatrix 目前著重連接你自有掌控的筆電、辦公室主機或自管雲端 VM（如 Fly、AWS 或 Hetzner），而不綁定封閉的專屬雲端沙盒——這樣即使外部雲端服務關閉，你的工作成果也不會跟著蒸發。",
      },
    ],
  },
  orca: {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Orca 替代方案 (2026)：Orca vs xMatrix",
    metaDescription:
      "正在比較 Orca（stablyai/orca）替代方案？擺脫單人記憶體暴衝、8,900+ 未解 Issue 與脆弱的區網手機配對，改用 xMatrix 多人頻道與即時頁面。",
    eyebrow: "Orca 替代方案 · Orca vs xMatrix",
    headline: "Orca vs xMatrix",
    lead: "Orca 是一款熱門的開源單人 ADE，擅長將單一提示詞同時扇出（fan-out）到多個本機 worktree，但多人介面仍未推出、把同一提示扇出給 N 個 Agent 會讓 Token 消耗倍增，大型艦隊也容易吃爆本機記憶體。xMatrix 會從 34 種程式設計代理中將每項任務精準路由給最合適的 Agent，並為整個團隊持續維護即時頁面。",
    productCaption:
      "xMatrix 實景：將並行開發任務分散到你所有的主機上，不再因內嵌瀏覽器而吃爆記憶體，無論桌面或手機都能清爽掌握進度。",
    painPoints: [
      {
        title: "仍是單人工具——缺乏共享頻道、團隊身分與 Space 機密",
        problem:
          "Orca 是為單一開發者指揮本機艦隊而設計；多人協作介面尚未推出，實驗性的 Slack／Discord 橋接僅把隊友訊息當作被動脈絡，也沒有 Space 層級機密庫或個別應用核准層。",
        xmatrixAnswer:
          "xMatrix 原生即為多人設計。多位隊友與 Agent 共享公開或私人頻道、依據個別應用原則核准外部操作，並安全共用 Space 機密。",
      },
      {
        title: "本機資源暴衝、當機積壓與介面／Agent 狀態脫節",
        problem:
          "stablyai/orca 目前累積 8,988 個未關閉 Issue（其中逾 100 則提及當機），使用者常回報並行 xterm 加上內嵌 Chromium 導致 RAM／CPU 飆升、dev helper 權限錯誤（#26498）、介面凍結並誤將任務標示為「完成」但 Agent 其實還在改檔，以及單一提示同時扇出給 4–5 個 Agent 瞬間燒光配額。",
        xmatrixAnswer:
          "xMatrix 不在每個窗格塞入瀏覽器艦隊，也不強制冗餘扇出。Agent 會在最合適的註冊主機上乾淨運行、回報明確的執行狀態，並將最終結果收斂到一份易讀的頁面。",
      },
      {
        title: "脆弱的區網手機配對，且缺乏動態專案記憶",
        problem:
          "Orca 行動端仰賴區域網路 E2EE QR Code 配對，在企業 VPN 或分段 Wi-Fi 環境下經常失效，且任務跑完後不會留下持續維護的專案 Wiki。",
        xmatrixAnswer:
          "xMatrix 透過 Hub 在任何網路環境（行動網路、VPN 或桌面端）穩定連線，並由 Agent 將完成的工作記錄在即時頁面中，讓整個團隊隨時在網頁、桌面或手機查閱。",
      },
    ],
    comparisonRows: [
      {
        dimension: "多人協作與權限",
        xmatrix: "多人多 Agent 頻道、角色權限、Space 機密、個別應用核准",
        competitor: "單人桌面 ADE；多人介面尚未推出；無共用機密",
      },
      {
        dimension: "動態專案狀態",
        xmatrix: "隨工作落地由 Agent 更新的頁面；與成員無鎖定共同編輯",
        competitor: "worktree diff 與實驗性 DAG 編排；無動態文件",
      },
      {
        dimension: "行動端與遠端存取",
        xmatrix: "透過 Hub 中繼的 Web、桌面端、iPhone 與 iPad 及 Android 應用程式，跨任何網路與 VPN",
        competitor: "區域網路 QR 配對，易受企業 VPN／防火牆阻斷",
      },
      {
        dimension: "路由與 Token 消耗",
        xmatrix: "@auto 依任務適配度、CPU／記憶體與配額餘裕挑選單一 Agent",
        competitor: "扇出提示會在 N 個並行 worktree 上倍增 Token 消耗",
      },
      {
        dimension: "維運連接器",
        xmatrix: "40 多個具個別應用原則的整合工具 + Space 機密",
        competitor: "實驗性 Slack／Discord 脈絡橋接；無維運核准層",
      },
    ],
    stayWhen: [
      "你是獨立開發者，明確需要把同一則提示詞同時發給四個模型，並搭配內嵌瀏覽器並列比對視覺差異。",
      "你堅持使用 100% MIT 授權的純本機桌面 IDE，完全不經由任何託管 Hub。",
    ],
    switchWhen: [
      "你需要與隊友協作，讓每個人在同一個工作區擁有獨立身分、通知與核准權限。",
      "本機瀏覽器與 worktree 艦隊正在拖垮你的筆電記憶體，或加速燒乾 Claude／OpenAI 配額。",
      "你需要跨 VPN 與行動網路都穩定可靠的手機控制，以及一份呈現所有專案現況的即時頁面。",
    ],
    migrationSteps: [
      {
        title: "同時連接你的工作站與閒置建置伺服器",
        detail: "在同一個 xMatrix Space 裡把任務分散到 MacBook 與 Linux 伺服器，別再讓單一筆電記憶體過載。",
      },
      {
        title: "沿用既有的 CLI 執行工具",
        detail: "透過 xmatrix agent add 一次註冊 Claude Code、Codex、Kimi 或 Cursor，無需重新登入專屬執行環境。",
      },
      {
        title: "將儲存庫連結至即時頁面",
        detail: "讓 Agent 直接把 PR、CI 狀態與決策更新到共享頁面，取代逐一比對原始終端機分頁。",
      },
    ],
    faqs: [
      {
        question: "為什麼 Orca 的 GitHub 星數這麼高，未解決 Issue 卻也這麼多？",
        answer:
          "星數衡量的是關注度，而非是否適合你的團隊。Orca 是熱門專案，同時累積了大量未關閉 Issue；建議依日常穩定度以及是否需要多人治理來評估兩款工具。",
      },
      {
        question: "xMatrix 在企業 VPN 與手機行動網路下能正常運作嗎？",
        answer:
          "可以。因為本機背景服務主動向外與 xMatrix Hub 維持連線，你隨時隨地都能用手機閱讀頁面、傳訊給 Agent 與核准連接器操作。",
      },
      {
        question: "在 xMatrix 中依然可以同時並行執行多個 Agent 嗎？",
        answer:
          "可以。數十個對話可同時在一台或多台已註冊主機上並行運作，並各自將進度與最終成果回報至專案頁面。",
      },
    ],
  },
  lobehub: {
    alsoKnownAs: "原名 LobeChat",
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "LobeHub (LobeChat) 替代方案 (2026)：vs xMatrix",
    metaDescription:
      "正在找 LobeHub 或 LobeChat 替代方案？告別點數轉售加價、2.0 PostgreSQL／S3 自架門檻與 RAG 片段汙染，改用 xMatrix 本機開發 Agent 與即時頁面。",
    eyebrow: "LobeHub (LobeChat) 替代方案 · LobeHub vs xMatrix",
    headline: "LobeHub vs xMatrix",
    lead: "LobeHub（由 LobeChat 更名）是主打轉售模型點數的通用型 AI 工作區，2.0 自架架構沉重，且缺乏多人多 Agent 共享頻道。xMatrix 直接沿用你的現有訂閱，在真實儲存庫中執行 34 種程式設計代理，並內建用於設定完成條件的 Goals 與 40 多個受控管整合工具。",
    productCaption:
      "xMatrix 實景：在即時團隊頻道與即時頁面中協調你既有的 Claude Code、Codex 與 Cursor 訂閱，零 Token 轉售加價、零 Docker 維運負擔。",
    painPoints: [
      {
        title: "點數轉售計費在長程式碼脈絡下消耗難以預測",
        problem:
          "LobeHub Cloud 免費方案（約 50 萬點）封鎖了許多旗艦模型，付費方案（每月 US$12.9／US$24.9／US$49.9）則透過雲端點數對每個 Token 計費。開發者普遍反映長程式碼脈絡與深度研究 Agent 消耗點數的速度遠超預期。",
        xmatrixAnswer:
          "xMatrix 絕不轉售或加價 LLM Token。你的 Agent 直接使用你原本擁有的 Claude Code、Codex、Cursor 或 Gemini 訂閱與 API 金鑰，xMatrix Pro 則為每人每月 US$10，每席位含 5,000 點額度，供 Agent 與應用寫入使用。",
      },
      {
        title: "沉重的 2.0 架構改寫與失效的舊版自架教學",
        problem:
          "從 LobeChat 改版為 LobeHub 2.0 時導入了強制性的 PostgreSQL、S3 相容物件儲存、新版驗證流程，並轉為 LobeHub Community License——導致大量 1.x Docker Compose 教學失效，引發社群對部署複雜度的強烈反彈。",
        xmatrixAnswer:
          "xMatrix 不需要自己架設任何資料庫或 S3 儲存桶就能開始使用。登入帳號、在電腦安裝輕量單一 CLI，幾分鐘內即可接上現有儲存庫。",
      },
      {
        title: "缺乏即時多人多 Agent 開發頻道，且知識庫易受 RAG 片段汙染",
        problem:
          "LobeHub 雖支援 Agent 群組與知識庫，但使用者經常遇到向量檢索抓進無關片段汙染脈絡的問題，且缺少一個讓多位工程師與多個本機開發 Agent 共同推進發布的即時房間。",
        xmatrixAnswer:
          "xMatrix 用明確、人類可直接閱讀的即時頁面與即時多人頻道取代模糊的 RAG 切塊檢索——Agent 讀到的是準確的當下決策，而不是過時的向量碎片。",
      },
    ],
    comparisonRows: [
      {
        dimension: "模型與 Token 計費",
        xmatrix: "自備訂閱／金鑰；Token 零加價；Pro US$10／人類席位",
        competitor: "Cloud 轉售模型點數（US$12.9–$49.9／月）；免費方案限制旗艦模型",
      },
      {
        dimension: "多人多 Agent 協作空間",
        xmatrix: "原生公開與私人頻道，支援隊友與多款開發工具共處",
        competitor: "由單一領隊編排的 Agent 群組；透過 Discord／Slack／Lark 接入外部機器人",
      },
      {
        dimension: "知識維護模型",
        xmatrix: "由人與 Agent 原地維護的動態 Markdown 頁面",
        competitor: "向量知識庫（易受片段汙染）+ 具編輯鎖定的頁面",
      },
      {
        dimension: "部署與維護負擔",
        xmatrix: "託管 Hub + 主機安裝單一原生 CLI 背景服務",
        competitor: "雲端 SaaS 或自架 PostgreSQL + S3 + 驗證整套架構（2.0 遷移）",
      },
      {
        dimension: "交付驗證與權限治理",
        xmatrix: "在支援 Goals 的代理工具上使用 Goals + 40 多個受控管整合工具",
        competitor: "內建交付檢查；透過 lh connect 連接的外部開發 Agent 未受治理",
      },
    ],
    stayWhen: [
      "你想要一個整合 40+ 託管聊天模型、統一由單一點數帳單結算的通用 AI 入口，而不打算分別訂閱 Anthropic／OpenAI。",
      "你高度依賴 LobeHub 內建的 Discord、Telegram、WeChat 與 Lark 機器人綁定，或依成員／Agent 追蹤的預算儀表板。",
    ],
    switchWhen: [
      "你原本就已經訂閱 Claude Code、Codex 或 Cursor，不想在長程式碼脈絡上再被剝一層點數轉售費。",
      "你希望工程師與 34 種程式設計代理在共享頻道即時協作並維護權威即時頁面，而非反覆除錯 RAG 檢索品質。",
      "你不想只是為了協調本機開發 Agent，還得自己維護一整套 PostgreSQL + S3 自架基礎設施。",
    ],
    migrationSteps: [
      {
        title: "保留原生的開發 CLI 與既有訂閱",
        detail: "將 34 種程式設計代理中的任何一款（Claude Code、Codex、Gemini、Cursor 等）直接註冊至 xMatrix，停止為託管點數池重複付費。",
      },
      {
        title: "將靜態知識庫轉換為即時頁面與 Goals",
        detail: "把關鍵架構筆記與待辦工作匯入 xMatrix 頁面，由 Agent 隨工作落地持續更新，並用 xmatrix goal 設定一個讓執行持續努力達成的完成條件。",
      },
      {
        title: "以個別應用治理連結維運服務",
        detail: "掛接 GitHub（唯讀或讀寫）以及 Linear、Vercel、Cloudflare、Sentry 或 Gmail（支援唯讀／先詢問／讀寫原則）。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 會像 LobeHub Cloud 一樣轉售 AI 模型點數嗎？",
        answer:
          "不會。Agent 一律使用你自有的訂閱或 API 金鑰。xMatrix Pro（每人每月 US$10）每席位含 5,000 點額度，用於 Agent 與應用訊息、Agent 頁面修訂及付費 X API 操作——絕不轉售 LLM Token。",
      },
      {
        question: "xMatrix 如何避免 LobeHub 的知識庫檢索汙染問題？",
        answer:
          "xMatrix 不將文件切成不透明的向量碎片，而是把狀態整理為精簡的即時頁面，支援大綱與章節層級讀取，確保 Agent 只讀到當下精確的章節。",
      },
      {
        question: "xMatrix 也支援個別工具核准與機密管理嗎？",
        answer:
          "支援。已連結應用支援唯讀、先詢問與讀寫權限（GitHub：唯讀或讀寫），Space 機密則在執行時傳入指令的執行環境，不會被印出或放進聊天中。",
      },
    ],
  },
  cumora: {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Cumora 替代方案 (2026)：Cumora vs xMatrix",
    metaDescription:
      "正在比較 Cumora（yetone/cumora）替代方案？直接在你真實的本機儲存庫中執行開發 Agent，告別離線沙盒阻斷（#350）、bwrap 錯誤與邀請制預覽。",
    eyebrow: "Cumora 替代方案 · Cumora vs xMatrix",
    headline: "Cumora vs xMatrix",
    lead: "Cumora 將人設驅動的 Agent 放進團隊聊天室，卻將本機 BYOA 鎖在與真實工作區隔離的離線沙盒裡，屢遇 Bubblewrap 與 CDN 擷取失敗（#350），且仍處於邀請制預覽。xMatrix 直接在你的儲存庫執行 34 種程式設計代理，透過 40 多個受控管整合工具與即時頁面交付成果。",
    productCaption:
      "xMatrix 實景：無需等待邀請碼，也沒有離線沙盒高牆——你真實的本機 Claude Code 與 Codex 工具直接在你的儲存庫裡與團隊並肩作戰。",
    painPoints: [
      {
        title: "離線沙盒高牆阻斷真實開發流程與 CDN 資源存取",
        problem:
          "Cumora 的 BYOA 模式預設將本機 CLI 關在獨立沙盒工作區並封鎖對外網路，導致外部套件、技術文件甚至自家聊天附件都無法擷取（Issue #350），同時也讓 Agent 無法直接進入你的真實工作目錄。",
        xmatrixAnswer:
          "xMatrix 直接在你明確註冊的本機儲存庫與資料夾中執行 Agent，完整銜接你原有的開發工具鏈、Git remote 與測試套件。",
      },
      {
        title: "Bubblewrap 啟動失敗、雲端與本機行為落差，以及殘缺的行動端",
        problem:
          "使用者頻頻遭遇本機 bwrap 啟動失敗、Cumora Cloud Kubernetes FUSE pod 與本機 BYOA 主機行為不一致，以及手機端顯示「coming soon」佔位畫面；且儲存庫自 2026 年 11 月 1 日後便未再推送新 commit。",
        xmatrixAnswer:
          "xMatrix 持續穩定發布 macOS、Windows、Linux、iPhone 與 iPad、Android 以及 Web 版本，採單一且一致的本機主機執行模型，經由正式環境持續驗證。",
      },
      {
        title: "缺乏用於交付與維運的受控管連接器",
        problem:
          "Cumora 雖內建聊天、文件、看板與行事曆元件，卻缺少針對 GitHub、Vercel、Cloudflare、Linear、Sentry、Gmail 與 Stripe 的跨應用核准層與 Space 機密庫。",
        xmatrixAnswer:
          "xMatrix 原生連接 40 多個工程與商務應用，提供個別應用權限原則與 Space 層級機密。",
      },
    ],
    comparisonRows: [
      {
        dimension: "本機 Agent 工作位置",
        xmatrix: "在 34 種程式設計代理下，直接於你已註冊的本機儲存庫與工具鏈運作",
        competitor: "限制在 Cumora 自家離線沙盒工作區（封鎖對外擷取，#350）",
      },
      {
        dimension: "開放程度與開發動能",
        xmatrix: "開放自助註冊 Free（500 次終身寫入）與 Pro 方案；每日持續更新發布",
        competitor: "邀請制預覽；自 2026 年 11 月 1 日後無儲存庫推送",
      },
      {
        dimension: "外部應用治理",
        xmatrix: "40 多個具個別應用原則的整合工具 + Space 機密",
        competitor: "僅有正式部署核准；缺乏同等維運連接器核准層",
      },
      {
        dimension: "動態專案文件",
        xmatrix: "與人共同編輯、並由 Agent 隨工作落地更新的頁面（Pages）",
        competitor: "搭配人設聊天的內建文件、看板與行事曆",
      },
      {
        dimension: "行動端與跨平台支援",
        xmatrix: "macOS、Windows、Linux、iPhone 與 iPad、Android 以及 Web",
        competitor: "以桌面／網頁為主；行動端工作階段尚有缺口（顯示 coming soon）",
      },
    ],
    stayWhen: [
      "你明確希望在 Cumora Cloud 邀請制預覽期間，由官方託管 Kubernetes pod 代付推論費用。",
      "你偏好讓具人設的聊天 Agent 隔離在完全無網路的沙盒裡，遠離你的本機儲存庫。",
    ],
    switchWhen: [
      "你需要 Agent 直接在真實儲存庫、相依套件與測試環境中運作，不要一直撞上離線沙盒錯誤。",
      "你今天就需要一套開放、穩定迭代的正式工作區，而不是苦等邀請碼的預覽版。",
      "你需要在單一 Space 下安全控管 GitHub、Linear、Vercel、Cloudflare、Sentry 與 Gmail 存取。",
    ],
    migrationSteps: [
      {
        title: "免等候補名單，立即開始使用",
        detail: "建立免費 xMatrix Space——支援最多 3 人與不限數量的 Agent。",
      },
      {
        title: "註冊現有的本機儲存庫與執行工具",
        detail: "在你的 Mac、Linux 或 Windows 主機執行 xmatrix agent add，讓 Claude Code、Codex 與 Cursor 直接在程式碼所在處運作。",
      },
      {
        title: "將進行中的專案脈絡搬入即時頁面",
        detail: "把決策、版本狀態與待辦事項統一維護在頁面中，不必在聊天人設與看板之間東拼西湊。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 會像 Cumora 一樣封鎖本機開發 Agent 的對外網路嗎？",
        answer:
          "不會。Agent 會在你註冊的本機開發環境中沿用正常網路存取，套件安裝、查閱 API 文件與測試套件都能順利運作；而透過已連結應用進行的寫入則遵循各應用的權限設定。",
      },
      {
        question: "試用 xMatrix 需要邀請碼嗎？",
        answer: "不需要。xMatrix 全面開放自助註冊，並提供支援最多 3 人、不限 Agent 數量的免費方案。",
      },
      {
        question: "xMatrix 只適合寫程式，還是也能維護文件與日常維運？",
        answer:
          "兩者兼具。Agent 既能在儲存庫中交付程式碼，也能為產品發布、研究分析、招募、事故應變與維運持續更新即時頁面。",
      },
    ],
  },
  "t3-code": {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "T3 Code 替代方案 (2026)：T3 Code vs xMatrix",
    metaDescription:
      "正在找 T3 Code 替代方案？為團隊帶來真實成員身分、共享頻道（GitHub Discussion #27974）、動態專案頁面（#15858）、Space 機密與跨供應商交接（#15846）。",
    eyebrow: "T3 Code 替代方案 · T3 Code vs xMatrix",
    headline: "T3 Code vs xMatrix",
    lead: "T3 Code 是一款出色的免費單人開發工作台，但每個環境都綁死單一帳號、缺少共享動態專案頁面，且配額用完後討論串停在「Limited」，只能等重置或手動換一家。xMatrix 為你的團隊帶來共享頻道、即時頁面、Space 機密，以及跨主機運行的 34 種程式設計代理。",
    productCaption:
      "xMatrix 實景：在真正的多人頻道裡讓 34 種程式設計代理跨主機協作，為整個團隊持續保持即時頁面最新。",
    painPoints: [
      {
        title: "缺乏真正的多人身分與共享團隊頻道",
        problem:
          "T3 Code 將每個環境綁定於單一 T3 Connect 帳號——紀錄裡每個人都只顯示為「user」，訪客連結 24 小時就會過期，且訪客每發一則訊息都得由主持人核准。社群在 GitHub Discussions 反覆提出的團隊需求（GitHub Discussions #27974、#12283、#27708）始終未獲回應，迫使許多團隊轉向第三方分支。",
        xmatrixAnswer:
          "xMatrix 從底層即為多人多 Agent 的 Space 而建：具備真實成員身分、公開與私人頻道、具名頁面編輯紀錄，以及精準送達提問者的通知。",
      },
      {
        title: "撞到「Limited」就原地停擺——缺乏跨供應商自動配額交接",
        problem:
          "當 Claude 或 Codex 在 T3 Code 觸及用量上限時，討論串只會停在 Limited 等候重置或人工切換。社群在 GitHub Discussions 對跨供應商自動備援的請求（GitHub Discussions #15846、#24453、#18949）仍未實作，使用者也回報包裝子任務額外消耗配額或誤報 Limited 狀態。",
        xmatrixAnswer:
          "xMatrix 會即時監控你已註冊工具的供應商配額視窗，當某家供應商觸頂（例如 Claude Code）時，自動將工作交接給其他尚有額度的供應商（如 Codex 或 Gemini），讓開發不中斷。",
      },
      {
        title: "缺少動態專案頁面、Space 機密與維運連接器",
        problem:
          "T3 Code 擅長本機 diff 與模擬器，卻沒有共享專案記憶或動態文件（GitHub Discussion #15858），新討論串預設即採 Full access，免費 T3 Connect 通道僅限 3 台主機，且範疇侷限於寫程式而缺乏受控管的維運應用。",
        xmatrixAnswer:
          "在 xMatrix 中，Agent 會將完成的工作記錄在即時頁面裡；你可以跨 34 種程式設計代理連接任意數量的主機、保存 Space 層級機密，並治理 Vercel、Cloudflare、Sentry、Gmail 與 Stripe 等 40 多個整合應用。",
      },
    ],
    comparisonRows: [
      {
        dimension: "多人協作與署名歸屬",
        xmatrix: "完整團隊 Space、個人真實身分、公開／私人頻道、具名編輯紀錄",
        competitor: "單人環境；24 小時訪客連結測試版；無團隊身分",
      },
      {
        dimension: "供應商達配額上限時",
        xmatrix: "保留未提交變更的跨供應商自動交接",
        competitor: "停在 Limited；只能手動切換或乾等重置",
      },
      {
        dimension: "專案狀態與動態文件",
        xmatrix: "由 Agent 持續維持最新、與人共同編輯的即時頁面",
        competitor: "各自獨立的討論串紀錄；無專案記憶或動態文件（GitHub Discussion #15858）",
      },
      {
        dimension: "預設安全與維運治理",
        xmatrix: "各主機擁有者為每個代理工具選擇完全存取或先詢問；40 多個應用個別權限原則 + Space 機密",
        competitor: "新討論串預設 Full access；單機本機機密；僅限開發議題",
      },
      {
        dimension: "代理數量與遠端主機",
        xmatrix: "34 種程式設計代理（含 --runtime），跨所有 macOS、Windows 與 Linux 主機",
        competitor: "10 種代理 + ACP；T3 Connect 免費方案上限 3 台主機",
      },
    ],
    stayWhen: [
      "你完全獨立作業，只需要一款免費的本機 IDE 工作台，內建 diff 審查、checkpoint 回溯、瀏覽器預覽與 iOS／Android 模擬器。",
      "你只想在 1–3 台電腦上免帳號本機運行，不需要隊友協作、動態文件或非程式碼連接器。",
    ],
    switchWhen: [
      "兩位以上成員需要在同一工作區與開發 Agent 協作，並保有清楚的署名與共享脈絡。",
      "你受夠了 Claude 觸及 5 小時或每週上限時討論串卡死在「Limited」，而手邊的 Codex 或 Gemini 配額卻閒置不用。",
      "你希望將數十個討論串的成果濃縮為即時頁面，並加上 Vercel、Cloudflare、Linear、Sentry 與 Gmail 的受控管存取。",
    ],
    migrationSteps: [
      {
        title: "保留原有本機 CLI——甚至可透過 MCP 與 xMatrix 並用",
        detail: "xMatrix 直接驅動你原本為 T3 Code 安裝的 Claude Code、Codex、Cursor、OpenCode、Grok 與 Antigravity CLI。",
      },
      {
        title: "免綁 T3 Chat 方案，直接連接超過 3 台主機",
        detail: "把你的筆電、建置主機與自管伺服器全數註冊到同一 Space，讓 @auto 自動路由至最有餘裕的主機與供應商。",
      },
      {
        title: "用即時頁面記錄專案",
        detail: "不必再在每個新討論串重複交代架構決策——在專案頁面寫一次，所有工具都會自動讀取。",
      },
    ],
    faqs: [
      {
        question: "既然 T3 Code 免費，為什麼團隊願意付費升級 xMatrix Pro？",
        answer:
          "如果你只需要在 1–3 台電腦使用的免費單人工作台，T3 Code 非常棒。當團隊需要真正的多人 Space、動態專案頁面、跨供應商自動配額交接、Space 機密以及 40 多個受控管整合工具時，就會選擇 xMatrix。",
      },
      {
        question: "Claude 達到上限時，xMatrix 真的會自動切換供應商嗎？",
        answer:
          "是的。當某家供應商的配額視窗耗盡時，xMatrix 會將工作路由或交接給你已註冊的另一款可用工具，且不會對單一供應商進行違反服務條款的多帳號輪換。",
      },
      {
        question: "我可以同時搭配 T3 Code 使用 xMatrix 嗎？",
        answer:
          "可以。xMatrix 提供 MCP 伺服器來讀取、更新頁面與發送頻道訊息，並直接對接相同本機儲存庫而不鎖定檔案。",
      },
    ],
  },
  herdr: {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "herdr 替代方案 (2026)：herdr vs xMatrix",
    metaDescription:
      "評估 herdr（herdr-core）替代方案？立即在 xMatrix 獲得內建身分驗證、團隊權限、免候補名單的跨裝置中繼、個別應用核准與即時頁面。",
    eyebrow: "herdr 替代方案 · herdr vs xMatrix",
    headline: "herdr vs xMatrix",
    lead: "herdr 從受歡迎的 Rust TUI 多工器演進為 herdr-core 搭配原生應用程式，帶來破壞性協定變動並引發 Reddit 對 GUI 綁定的反彈，同時仍缺乏多使用者驗證、核准機制、機密庫與正式上線的雲端中繼。xMatrix 今天就提供完整受控管的協作層。",
    productCaption:
      "xMatrix 實景：今日即可在桌面、網頁與手機跨裝置協作——搭配經驗證的 Space、Space 機密與即時頁面，取代未驗證的預覽 socket。",
    painPoints: [
      {
        title: "沒有身分驗證、權限邊界、核准機制或機密管理",
        problem:
          "herdr-core 明確定位為單一使用者本機執行環境：任何連上其 socket 的人實質上就擁有完整 shell 權限。它沒有使用者角色、沒有操作核准、沒有機密庫，也沒有排程或 Webhook 觸發自動化。",
        xmatrixAnswer:
          "xMatrix 在本機執行之上建立明確的信任邊界：經查驗的人類與 Agent 身分、傳入指令時不會被印出或放進聊天中的 Space 層級機密、個別應用核准原則，以及 Norn 自動化程式。",
      },
      {
        title: "協定頻繁異動、破壞性變更與從 TUI 轉向 GUI 的社群反彈",
        problem:
          "重寫為 herdr-core 破壞了舊版第三方用戶端，v0.9.2 移除了窗格圖形 API，Reddit 開發者也對背離通用 SSH TUI 存取、轉向專屬用戶端感到不滿。現有 Issue 也持續追蹤 SSH stderr 滲入窗格、macOS 主執行緒卡頓（os error 35）以及 CLAUDE_CODE_* 環境變數跨 systemd 單元外洩等問題。",
        xmatrixAnswer:
          "xMatrix 提供一致整合的網頁、桌面、CLI 與行動端體驗，背後以版本化的 Hub／CLI 相容性契約與明確的單次執行隔離把關。",
      },
      {
        title: "Herdr Cloud 仍在候補名單——而且終端機不會維護動態文件",
        problem:
          "跨裝置加密中繼（Herdr Cloud）與官方行動 App 仍處於候補名單或開發中；即便未來上線，PTY 多工器仍會把所有決策埋沒在終端機捲軸紀錄裡。",
        xmatrixAnswer:
          "xMatrix 今天就能在 macOS、Windows、Linux、iPhone 與 iPad、Android 以及 Web 之間穩定跨機中繼，並由 Agent 將完成的工作寫回即時頁面。",
      },
    ],
    comparisonRows: [
      {
        dimension: "身分驗證與安全邊界",
        xmatrix: "經驗證的 Space、成員角色、Space 機密、個別應用核准",
        competitor: "無——連上本機 socket 即等同擁有完整 shell 權限",
      },
      {
        dimension: "跨裝置中繼與行動端",
        xmatrix: "今日即上線，支援 macOS、Windows、Linux、iPhone 與 iPad、Android 以及 Web",
        competitor: "目前需手動設定 SSH；Herdr Cloud 中繼仍在候補名單",
      },
      {
        dimension: "工作成果保存位置",
        xmatrix: "由 Agent 持續維護的即時頁面 + 可搜尋頻道",
        competitor: "常駐 PTY 捲軸窗格",
      },
      {
        dimension: "自動化與外部連接器",
        xmatrix: "排程與事件驅動 Norn 程式 + 40 多個整合工具",
        competitor: "無內建 cron、Webhook 自動化或應用連接器",
      },
      {
        dimension: "目標族群",
        xmatrix: "需要協調多位 Agent 與外部應用的個人開發者與團隊",
        competitor: "想基於 PTY 執行環境自行打造工具的單人終端機進階玩家",
      },
    ],
    stayWhen: [
      "你明確需要一個 Apache-2.0 授權的本機 PTY 背景服務，透過原始 JSON-RPC／OpenRPC socket 在 SSH 上自訂終端機介面。",
      "你完全獨自在終端機作業，永遠不需要團隊權限、即時頁面或外部應用核准。",
    ],
    switchWhen: [
      "你今天就想要跨裝置的桌面與手機存取，不想繼續苦等 Herdr Cloud 候補名單或排查 SSH ProxyCommand 外洩問題。",
      "在 Agent 透過 Vercel、Cloudflare、Linear 或其他已連結應用採取行動之前，你需要真正的身分驗證、Space 機密與人工核准。",
      "你希望在即時頁面一目了然掌握專案現況，而不是在常駐 PTY 窗格裡大海撈針。",
    ],
    migrationSteps: [
      {
        title: "在現有工具旁安裝 xMatrix CLI",
        detail: "一行指令即可註冊你的 macOS、Linux 或 Windows 主機，無需手動架設 SSH 通道。",
      },
      {
        title: "一次連接所有開發工具",
        detail: "以 xmatrix agent add 加入 Claude Code、Codex、Cursor、Gemini 或 OpenCode，原有訂閱全數留在本機。",
      },
      {
        title: "將例行狀態追蹤移至即時頁面",
        detail: "為進行中的專案建立頁面，交給排程或事件驅動的例行任務維持準確。",
      },
    ],
    faqs: [
      {
        question: "關掉瀏覽器或闔上筆電時，xMatrix 的 Agent 執行會繼續跑嗎？",
        answer:
          "只要執行該任務的主機保持喚醒連線（例如桌機、Mac Studio 或自管 Linux VPS），背景服務就會持續執行，等你重新開啟網頁、桌面或手機端時立即同步最新進度。",
      },
      {
        question: "相較於直接暴露本機 PTY socket，xMatrix 為什麼更安全？",
        answer:
          "xMatrix 在伺服器端強制執行 Space 驗證與成員控管、將主機註冊與 Space 存取權分離、以 xmatrix secret exec 將 Space 機密傳入指令而不印出，並透過唯讀或先詢問權限把關已連結 SaaS 操作。",
      },
      {
        question: "我還是可以從終端機操作 xMatrix 嗎？",
        answer:
          "可以。原生 Rust CLI（xmatrix）讓人與 Agent 都能直接在 shell 中讀取頁面、傳送訊息、檢視執行狀態並呼叫受控管連接器。",
      },
    ],
  },
  seedmux: {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Seedmux 替代方案 (2026)：Seedmux vs xMatrix",
    metaDescription:
      "尋找 Seedmux 替代方案？擺脫 macOS + iPhone 平台綁定、閉源執行檔與手機端預設 YOLO 模式，在 macOS、Windows、Linux、Android 與 iOS 使用 xMatrix。",
    eyebrow: "Seedmux 替代方案 · Seedmux vs xMatrix",
    headline: "Seedmux vs xMatrix",
    lead: "Seedmux 結合了精緻的 Ghostty + tmux macOS 終端機與 iPhone 配套 App，但它是閉源軟體、僅限 Mac 與單人使用，且手機端啟動的工作階段預設進入 YOLO 模式。xMatrix 為 macOS、Windows、Linux、Android 與 iOS 帶來跨主機協作、真實團隊 Space 與即時頁面。",
    productCaption:
      "xMatrix 實景：橫跨 macOS、Windows、Linux、iPhone 與 iPad、Android 以及 Web 的單一工作區，搭配受控管的應用核准，以及由各主機擁有者選定的代理工具存取權限。",
    painPoints: [
      {
        title: "macOS + iPhone 平台綁定，將 Windows、Linux 與 Android 排除在外",
        problem:
          "Seedmux 嚴格限定為原生 macOS 應用程式，仰賴瀏海區域通知並搭配 iPhone 配套 App（需 Seedmux Pro）。沒有原生 Windows 或 Linux 桌面版、沒有網頁工作區，也沒有 Android App。",
        xmatrixAnswer:
          "xMatrix 涵蓋 macOS、Windows、Linux、iPhone 與 iPad、Android 以及 Web，你與隊友手邊的每台電腦與手機都能加入同一個 Space。",
      },
      {
        title: "單人終端機窗格，且行動端預設開啟 YOLO 模式",
        problem:
          "Seedmux 沒有團隊頻道、沒有共享角色，也沒有 Space 機密；從 iPhone 配套 App 發起的工作階段預設採 YOLO 權限，且經過行動網路或企業防火牆中繼時容易增加核准延遲。",
        xmatrixAnswer:
          "無論從哪個裝置發起工作，xMatrix 都套用相同規則：每個代理工具都以其主機擁有者確認過的完全存取或先詢問權限運行，已連結應用遵循「唯讀／先詢問／讀寫」權限，Space 機密不會出現在聊天中，而 Space 管理員會在共享頻道中核准「先詢問」操作。",
      },
      {
        title: "脆弱的 CLI 狀態擷取，且缺乏動態專案文件",
        problem:
          "由於 Seedmux 透過 tmux 包裝本機 CLI 窗格，CLI 改版或登入權杖過期常會讓窗格狀態偵測卡住，多窗格同時運行容易吃重本機 MacBook 記憶體，且成果只留在捲軸裡，無法沉澱成團隊文件。",
        xmatrixAnswer:
          "xMatrix 採用結構化工具轉接器與明確的生命週期狀態，將任務分散至所有已連接主機，並把完成的工作轉化為即時頁面。",
      },
    ],
    comparisonRows: [
      {
        dimension: "支援平台",
        xmatrix: "macOS、Windows、Linux、iPhone 與 iPad、Android 以及 Web",
        competitor: "僅限 macOS + iPhone 配套 App（Linux 主機僅靠 SSH／中繼）",
      },
      {
        dimension: "團隊協作",
        xmatrix: "多人多 Agent 頻道與共同編輯的即時頁面",
        competitor: "僅限單人終端機；無共享團隊頻道或文件",
      },
      {
        dimension: "行動端安全預設",
        xmatrix: "主機擁有者確認過的代理工具存取權限（完全存取或先詢問）+ 任何裝置皆適用相同的個別應用原則",
        competitor: "手機發起的工作階段預設啟用 YOLO 模式",
      },
      {
        dimension: "原始碼透明度",
        xmatrix: "採 FSL-1.1-ALv2 授權公開原始碼",
        competitor: "閉源二進位執行檔",
      },
      {
        dimension: "外部維運應用",
        xmatrix: "40 多個整合工具（GitHub、Linear、Vercel、Cloudflare、Sentry、Gmail、Stripe 等）",
        competitor: "僅限終端機 CLI 指令；無 SaaS 連接器核准層",
      },
    ],
    stayWhen: [
      "你是獨立作業的 macOS + iPhone 終端機愛好者，特別偏好 Ghostty 渲染、tmux 窗格分割與 MacBook 瀏海彈出通知。",
    ],
    switchWhen: [
      "你或你的隊友使用 Windows、Linux 或 Android 裝置。",
      "你需要行動端控制，且每台主機的擁有者都已為每個代理工具明確選擇完全存取或先詢問。",
      "你希望將決策與專案進度持續整理在即時頁面中，而非稍縱即逝的終端機分割視窗。",
    ],
    migrationSteps: [
      {
        title: "保留現有的 CLI 工具與訂閱",
        detail: "在你的 Mac 與 Linux 主機安裝 xMatrix，透過 xmatrix agent add 加入 34 種程式設計代理中的任何一款（Claude Code、Codex、Grok、OpenCode、Kimi 等）。",
      },
      {
        title: "免自架中繼，直接跨網頁、桌面與行動端操作",
        detail: "從任何瀏覽器、桌面應用程式，或 iPhone、iPad 與 Android App 追蹤進度並回覆核准。",
      },
      {
        title: "將所有工作成果收斂到即時頁面",
        detail: "不必手動巡檢每個 worker 窗格的回執，讓各 Agent 直接更新專案頁面的對應章節。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 是否也像 Seedmux worker 一樣提供結構化任務回執？",
        answer: "是的。每項發送給 Agent 的程式請求都會以具型別（typed）的回覆收尾，同時搭配明確的生命週期狀態，並直接將更新寫入頻道與連結頁面。",
      },
      {
        question: "我可以把 Linux 伺服器跟 MacBook 接在一起嗎？",
        answer:
          "可以。在 Linux、macOS 與 Windows 主機上安裝原生 xMatrix 背景服務，所有主機都會出現在 Space 內統一的 Agents 矩陣中。",
      },
      {
        question: "xMatrix 是開源還是閉源？",
        answer: "xMatrix 採 FSL-1.1-ALv2 授權在 GitHub（LambdaLabsHQ/xmatrix）公開原始碼，而 Seedmux 為閉源軟體。",
      },
    ],
  },
  linear: {
    alsoKnownAs: "Linear Coding Sessions 與 Loops",
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Linear Agents 替代方案 (2026)：Linear vs xMatrix",
    metaDescription:
      "比較 Linear Agents 替代方案？擺脫會過期的預付沙盒點數、僅限雲端工單執行與 Enterprise 才有的稽核日誌，改用 xMatrix 本機頻道與即時頁面。",
    eyebrow: "Linear Agents 替代方案 · Linear vs xMatrix",
    headline: "Linear Agents vs xMatrix",
    lead: "Linear 是極為出色的議題追蹤工具，Linear Agents 也能將界定清楚的 Issue 轉成雲端沙盒 PR——但每 20 分鐘要價 US$0.25 另計 Token 費用，且必須從 12 個月過期的獨立預付錢包扣款。你可以繼續用 Linear 追蹤議題，並將它連接至 xMatrix，在自有主機的即時頻道與即時頁面中執行 34 種程式設計代理。",
    productCaption:
      "xMatrix 實景：保留 Linear 連線的同時，在本機以 Claude Code 與 Codex 於即時頻道協作，免付沙盒計時費、沒有過期預付餘額。",
    painPoints: [
      {
        title: "獨立預付點數錢包會過期且無法退款",
        problem:
          "在 Basic（US$10／席位）或 Business（US$16／席位，使用 Loops 必備）之外，Linear Coding Sessions 還要求另行儲值獨立的美元預付餘額（最低 US$10、12 個月後過期、不可退款），依 Token 用量另加每 20 分鐘 US$0.25 的沙盒費。需求模糊的工單一旦反覆重試，點數很快就會燒光。",
        xmatrixAnswer:
          "xMatrix 直接在你的自有主機上使用你原本已付費的 Claude Code、Codex 或 Cursor 訂閱執行 Agent——沒有沙盒計時費，也沒有會過期的預付現金餘額。",
      },
      {
        title: "萬事皆須開成工單——沒有即時多 Agent 頻道或本機主機編排",
        problem:
          "Linear Agents 擅長在雲端沙盒處理範圍明確的單一 Issue，但無法跨你的 MacBook、Linux 建置主機或 Windows 開發機編排 Agent，也缺少即時頻道讓大家共同引導多個工具。",
        xmatrixAnswer:
          "xMatrix 為團隊提供即時頻道，讓人與多個本機工具同場協作，並將最終狀態直接寫入即時頁面。",
      },
      {
        title: "缺乏逐項開發操作核准，且 Agent 稽核能力薄弱",
        problem:
          "Linear 的稽核日誌僅限 Enterprise 方案，且不會細部記錄個別 Agent 操作，更缺乏涵蓋 Cloudflare、Vercel、Gmail、Sentry 與 Stripe 的統一應用核准閘門。",
        xmatrixAnswer:
          "xMatrix 內建對話與執行軌跡、Space 層級機密，以及涵蓋 40 多個整合應用（包含 Linear 本身）的個別應用權限原則。",
      },
    ],
    comparisonRows: [
      {
        dimension: "開發 Agent 執行位置",
        xmatrix: "你自有的 macOS、Windows、Linux 主機（筆電、桌機或自管伺服器）",
        competitor: "Linear 雲端沙盒（US$0.25／20 分鐘）或外部廠商雲端",
      },
      {
        dimension: "Agent 計費模式",
        xmatrix: "34 種程式設計代理皆自備模型訂閱；Pro US$10／人類席位／月（年繳 US$8）",
        competitor: "席位月費（US$10–$16／月）+ 獨立預付點數（12 個月過期、不退費）",
      },
      {
        dimension: "最適合的工作型態",
        xmatrix: "從即時頻道、即時頁面與維運展開的工作——直接與 Linear 串聯",
        competitor: "規格已清楚拆分的單一 Issue 轉雲端 PR",
      },
      {
        dimension: "治理與可稽核性",
        xmatrix: "全方案皆享 40 多個應用個別權限原則 + Space 機密",
        competitor: "團隊層級 Agent 開關；稽核日誌僅限 Enterprise 且不細分單一 Agent 操作",
      },
      {
        dimension: "能否搭配使用？",
        xmatrix: "原生 Linear 連接器讓 xMatrix Agent 直接讀寫 Linear Issue",
        competitor: "以 Issue 為主；第三方 Agent 需透過 Agent Interaction API 串接",
      },
    ],
    stayWhen: [
      "你的流程完全是針對乾淨獨立的工單執行 Issue 轉 PR，且希望完全免除本機主機設定。",
      "你已經重度使用 Linear Business，且偶爾只需要在 Linear Issue 上跑雲端 Loops。",
    ],
    switchWhen: [
      "你想在自有硬體上充分運用現有的 Claude Code／Codex 訂閱，不想另付每 20 分鐘沙盒費或管理會過期的預付餘額。",
      "你的團隊在架構設計、版本發布與維運上需要即時多 Agent 頻道與即時頁面，而不只是一張張工單。",
      "你需要跨 Linear、GitHub、Vercel、Cloudflare、Sentry 與 Gmail 的個別應用核准與 Space 機密。",
    ],
    migrationSteps: [
      {
        title: "繼續把 Linear 當作議題追蹤器——直接連結到 xMatrix",
        detail: "完全不必捨棄 Linear。在 xMatrix 啟用 Linear 應用，讓本機 Agent 直接讀單、開 PR 並同步進度。",
      },
      {
        title: "註冊你的本機主機與執行工具",
        detail: "在自己的工作站上執行 Claude Code、Codex、Cursor 或 Gemini，免付雲端沙盒費用。",
      },
      {
        title: "用即時頁面維護專案真相",
        detail: "把頁面連結到各工作流，讓架構決策、發布進度與待解阻礙不必埋沒在工單留言裡。",
      },
    ],
    faqs: [
      {
        question: "使用 xMatrix 就必須離開 Linear 嗎？",
        answer:
          "不用。xMatrix 內建原生 Linear 連接器——團隊可以繼續在 Linear 追蹤 Issue，同時在 xMatrix 進行多 Agent 執行、維護即時頁面與受控管維運流程。",
      },
      {
        question: "為什麼不直接使用 Linear Coding Sessions 的 BYOK 選項就好？",
        answer:
          "即使啟用 BYOK，Linear Coding Sessions 依然只能在雲端沙盒運行，仍須從會過期的預付點數扣除每 20 分鐘 US$0.25 的沙盒費，且無法協調你的本機主機或 Linear 以外的維運連接器。",
      },
      {
        question: "xMatrix 的類 Loops 排程自動化需要額外加價嗎？",
        answer:
          "不需要。排程與事件驅動的 Norn 例行任務直接內建於 xMatrix 頁面中並共用現有方案額度，無須額外升級 Business 方案。",
      },
    ],
  },
  notion: {
    alsoKnownAs: "Notion AI 與 External Agents",
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Notion Custom Agents 替代方案 (2026) — xMatrix",
    metaDescription:
      "正在尋找 Notion Custom Agents 替代方案？擺脫 US$20–$24 Business 門檻、三種點數錢包、建立者點數耗盡導致暫停與行動端限制，改用 xMatrix 即時頁面。",
    eyebrow: "Notion Custom Agents 替代方案 · Notion vs xMatrix",
    headline: "Notion vs xMatrix",
    lead: "Notion Custom Agents 被鎖在 US$20–$24／席位的 Business 方案與複雜的三錢包點數制度後，團隊共用 Agent 預設會扣光建立者的個人 Select 點數並在途中停擺。在 xMatrix 中，34 種程式設計代理會在你的真實儲存庫交付程式碼時更新即時頁面，並共用每個 Space 單一的點數額度池。",
    productCaption:
      "xMatrix 實景：Agent 在真實儲存庫執行、在頻道與團隊對話並持續維護即時頁面——單一 Space 共享額度池，完整支援行動端。",
    painPoints: [
      {
        title: "三種獨立點數錢包，且共用 Agent 會扣乾建立者個人額度而停擺",
        problem:
          "Notion 將 AI 用量拆成個人 Standard 點數（1,500／月）、個人 Select 點數（500／月，使用 Custom Agents 必備）以及管理員加購的 Workspace Notion Credits（US$10／1,000 點）。個人餘額既不能合併也不能遞延，隊友觸發共用 Agent 預設會扣建立者的個人 Select 池，點數歸零當下任務就會中途暫停。",
        xmatrixAnswer:
          "xMatrix Pro 為每人每月 US$10（年繳 US$8／月）。每個席位每月為整個 Space 共享的額度池增加 5,000 點；Agent 與應用寫入會消耗點數，人類編輯則免費，用完後依序使用擁有者加購的點數包（每 5,000 點 US$10）與每席位 2,500 點的緩衝額度。xMatrix 絕不轉售 LLM Token。",
      },
      {
        title: "無法本機主機執行、無跨機中繼，也沒有即時 Agent 頻道",
        problem:
          "Notion 把文件當作人工操作介面，將寫程式外包給外部雲端 API（Alpha 階段），無法直接在你的筆電或建置伺服器上執行 Claude Code 或 Codex，缺少 Space 機密，也沒有多人多 Agent 即時頻道。",
        xmatrixAnswer:
          "在 xMatrix 中，你在頻道對話、Agent 直接在你的 macOS、Windows、Linux 本機儲存庫執行，即時頁面則隨真實工程進度自然更新。",
      },
      {
        title: "行動端無法建立、甚至無法執行團隊共用的 Custom Agents",
        problem:
          "Notion 手機 App 禁止建立 Custom Agents，且僅允許行動端使用者互動「自己個人擁有」的 Custom Agents，讓離開桌機的隊友束手無策。",
        xmatrixAnswer:
          "xMatrix 成員可以從 Web、桌面應用程式，或 iPhone、iPad 與 Android App 閱讀頁面並召喚 Space 的 Agent——Space 管理員也能在這些裝置上核准「先詢問」的連接器操作。",
      },
    ],
    comparisonRows: [
      {
        dimension: "定價與點數制度",
        xmatrix: "免費方案（500 次終身寫入）+ Pro US$10／席位／月（年繳 US$8）；單一 Space 共享額度池",
        competitor: "Business US$20–$24／席位／月 + 三種獨立錢包（Standard、Select、Workspace US$10／1k）",
      },
      {
        dimension: "Agent 執行位置",
        xmatrix: "直接在你自有的 macOS、Windows、Linux 主機上執行 34 種程式設計代理",
        competitor: "Notion 雲端瀏覽器／VM；寫程式委由外部廠商雲端執行",
      },
      {
        dimension: "文件維持最新方式",
        xmatrix: "實際交付程式碼的 Agent 隨進度改寫頁面；內建建議模式與逐段署名",
        competitor: "由人呼叫 Agent 或觸發器修改區塊；同樣具備建議模式與署名歸屬",
      },
      {
        dimension: "行動端團隊存取",
        xmatrix: "行動端可使用頻道、頁面與召喚 Agent；Space 管理員也能在行動端核准操作",
        competitor: "行動端無法建立 Custom Agents，也無法執行團隊共用 Agent",
      },
      {
        dimension: "機密與工程連接器",
        xmatrix: "Space 層級機密庫 + 40 多個整合工具（包含 Notion 本身）",
        competitor: "無可供 CLI 執行的 Space 層級機密庫",
      },
    ],
    stayWhen: [
      "你的公司高度仰賴關聯式 Notion 資料庫、CRM 表格與面向非工程團隊的豐富文件排版。",
    ],
    switchWhen: [
      "你受夠了搞懂 Standard、Select 與 Workspace 三種點數，或看團隊共用 Agent 因為建立者個人點數用完而停擺。",
      "你希望開發 Agent 直接在你的儲存庫工作並在工作時維護專案頁面，而不是任由 Wiki 與現實脫節。",
      "你的工程師需要在手機上存取共享 Agent、Space 機密以及受控管的部署／維運連接器。",
    ],
    migrationSteps: [
      {
        title: "先連結 Notion，不必一夜之間全部搬家",
        detail: "xMatrix 內建原生 Notion 連接器，讓 Agent 能讀取現有 Notion 規格書，同時在 xMatrix 頁面維護即時工程狀態。",
      },
      {
        title: "將變動最快的專案狀態移到 xMatrix 頁面",
        detail: "先從在 Notion 最容易過時的發行追蹤、架構決策與事故手冊著手。",
      },
      {
        title: "加上排程與事件驅動的 Norn 例行任務",
        detail: "把例行任務直接寫在各頁面裡，由 GitHub、Sentry 或每日排程自動更新，不再白燒 Notion Select 點數。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 可以連結我們現有的 Notion 工作區嗎？",
        answer: "可以。xMatrix 內建 Notion 連接器，支援依需求設定為「唯讀」、「先詢問」或「讀寫」權限。",
      },
      {
        question: "隊友觸發我設定的 Agent 時，會額外扣我個人額度嗎？",
        answer: "不會。在 xMatrix Pro 上，Agent 額度（每位人類成員每月 5,000 點）由整個 Space 共享，沒有個人建立者錢包瓶頸。",
      },
      {
        question: "如果人跟 Agent 同時編輯同一份 xMatrix 頁面會怎麼樣？",
        answer:
          "不會有任何鎖定。即時共同撰寫的 Agent 會避開你正在打字的段落，並在你編輯它正在撰寫的內容時立即停止；透過 CLI 編輯的 Agent 若變更與你的重疊，該變更會被拒絕，並取得目前內容以便重新合併。",
      },
    ],
  },
  "slack-code": {
    alsoKnownAs: "Slack Code API",
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Slack Code 替代方案 (2026)：告別 15 則 API 限制",
    metaDescription:
      "尋找 Slack Code 替代方案？擺脫 Slack 對自訂應用設下的每分鐘 1 次、最多 15 則歷史訊息限流、90 天免費上限與缺少 Agent 執行環境的限制，改用 xMatrix。",
    eyebrow: "Slack Code 替代方案 · Slack Code vs xMatrix",
    headline: "Slack Code vs xMatrix",
    lead: "Slack Code API 在 Slack 內加入了任務頻道與 diff 預覽，但 Slack 本質仍是聊天外殼——沒有 Agent 執行環境、沒有動態文件，還對非 Marketplace 應用程式的歷史紀錄端點施加嚴苛限流（每分鐘 1 次、單次最多 15 則）。透過 xMatrix 原生 Slack 連接器維持與 Slack 的連動，同時在自有主機執行 34 種程式設計代理並把決策留在即時頁面中。",
    productCaption:
      "xMatrix 實景：由自有主機與即時頁面支撐的原生多人多 Agent 頻道，享有完整脈絡讀取權限，零 15 則 API 阻擋。",
    painPoints: [
      {
        title: "嚴苛的 Slack API 限流，讓自訂開發 Agent 缺乏足夠脈絡",
        problem:
          "Slack 將非 Marketplace 應用的 conversations.history 與 conversations.replies 壓縮到每分鐘僅 1 次請求、每次最多 15 筆物件——大幅砍斷自訂 Agent 的上下文視窗，引發開發者對 AI 壟斷把關的強烈不滿；此外免費工作區超過 90 天即遺失歷史紀錄。",
        xmatrixAnswer:
          "xMatrix 原生為 Agent 設計：支援完整頻道歷史讀取、結構化頁面大綱與章節讀取，在你自己的 Space 中絕不設下人為的 15 則 API 高牆。",
      },
      {
        title: "Slack 只是聊天介面——沒有執行環境、跨機路由與 Space 機密",
        problem:
          "Slack Code 僅能顯示 diff 與合作夥伴 Agent 的更新，你仍須另行購買合作夥伴 Agent，或自己從零架設與維運主機執行器、背景服務、配額備援與機密注入。",
        xmatrixAnswer:
          "xMatrix 提供完整的執行協調堆疊：一次註冊你的 macOS、Windows 與 Linux 主機，自由路由 Claude Code、Codex、Cursor 與 Gemini，並安全注入 Space 機密。",
      },
      {
        title: "知識最終仍淹沒在不斷捲動的 Slack 頻道裡",
        problem:
          "即便有了任務頻道，Slack 依舊缺少動態專案文件層——決策很快沉沒在數百則訊息之下，迫使每位新進成員或 Agent 反覆猜測哪些結論依然有效。",
        xmatrixAnswer:
          "xMatrix 的頻道會連結至即時頁面，由 Agent 原地改寫最新狀態——只要讀頁面就能掌握專案現況。",
      },
    ],
    comparisonRows: [
      {
        dimension: "Agent 脈絡與 API 限制",
        xmatrix: "原生完整頻道歷史讀取 + 結構化頁面大綱／章節讀取",
        competitor: "非 Marketplace 歷史／回覆限每分鐘 1 次、最多 15 則；Free 版 90 天上限",
      },
      {
        dimension: "執行環境",
        xmatrix: "內建跨主機背景服務，支援 34 種程式設計代理（含 --runtime）",
        competitor: "純聊天介面；需另購合作夥伴 Agent 訂閱或自行架設",
      },
      {
        dimension: "動態專案狀態",
        xmatrix: "由 Agent 隨工作完成更新的即時頁面（Pages）",
        competitor: "線性捲動聊天紀錄與已封存的任務頻道",
      },
      {
        dimension: "受控管整合工具與機密",
        xmatrix: "Space 機密 + 40 多個具個別應用權限原則的整合工具",
        competitor: "無內建 Agent 機密庫或跨應用執行期治理",
      },
      {
        dimension: "能否與 Slack 整合？",
        xmatrix: "原生 Slack 連接器將 Slack 訊息帶入頻道；Agent 依其權限設定回覆至 Slack",
        competitor: "完全綁定在 Slack 內部",
      },
    ],
    stayWhen: [
      "整個公司完全無法離開 Slack，且你只需要付費 Marketplace 合作夥伴 Agent 在既有 Slack 討論串貼出 diff。",
    ],
    switchWhen: [
      "Slack 每分鐘 1 次、最多 15 則歷史紀錄的限流已經打壞你的自訂 Agent 流程。",
      "你想要開箱即用的 Claude Code、Codex 與 Cursor 跨主機執行器，不想自己寫一堆膠水基礎設施。",
      "你希望專案決策沉澱在即時頁面裡，而不是消失在 Slack 聊天捲軸中。",
    ],
    migrationSteps: [
      {
        title: "保留 Slack 處理公司溝通，並將它連結到 xMatrix",
        detail: "為 xMatrix 原生 Slack 連接器套用「先詢問」或「唯讀」原則，讓工程協作井然有序的同時仍與非技術隊友保持暢通。",
      },
      {
        title: "將多 Agent 工程頻道移入 xMatrix",
        detail: "註冊你的主機，直接在具備完整脈絡的 xMatrix 頻道執行 Claude Code、Codex 與 Cursor。",
      },
      {
        title: "把釘選的 Slack 訊息升級為即時頁面",
        detail: "用 Agent 隨工作落地更新的頁面，取代早就過時的釘選訊息與書籤。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 還能與我們現有的 Slack 工作區互動嗎？",
        answer: "可以。xMatrix 內建原生 Slack 連接器，並提供個別應用的唯讀、先詢問或讀寫權限。",
      },
      {
        question: "xMatrix 會限制我自己 Agent 能讀取多少頻道歷史嗎？",
        answer: "不會。Agent 可以直接讀取對話歷史與相連的即時頁面，沒有非 Marketplace 15 則 API 限制。",
      },
      {
        question: "xMatrix 的費用與 Slack 加上合作夥伴開發 Agent 相比如何？",
        answer:
          "xMatrix Pro 為每位人類成員 US$10／月（年繳 US$8／月），搭配你既有的 CLI 訂閱即可無限使用 Agent，不必在 Slack 席位費之上再層層疊加外部合作夥伴 Agent 訂閱。",
      },
    ],
  },
  "nowledge-mem": {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Nowledge Mem 替代方案 (2026)：vs xMatrix",
    metaDescription:
      "比較 Nowledge Mem 替代方案？別只從舊聊天抽取出推測的記憶碎片——在 xMatrix 跨主機執行開發 Agent，並直接維護權威的動態專案頁面。",
    eyebrow: "Nowledge Mem 替代方案 · Nowledge Mem vs xMatrix",
    headline: "Nowledge Mem vs xMatrix",
    lead: "Nowledge Mem 在各 AI 工具間建立了巧妙的本機圖譜／向量記憶層，但它只是被動的記憶庫——從舊對話推測事實、無法執行開發 Agent 或控管外部工具，且 Team 工作區仍在封測階段。在 xMatrix 中，實際執行的任務會直接寫下整個團隊今天就能共享的權威即時頁面。",
    productCaption:
      "xMatrix 實景：不再事後從舊對話裡被動推測記憶，而是讓實際交付程式碼的 Agent 直接維持整個團隊的動態專案頁面準確無誤。",
    painPoints: [
      {
        title: "事後推測抽取記憶 vs. 即時更新權威專案頁面",
        problem:
          "Nowledge Mem 在背景觀察聊天紀錄並推斷 Trace → Unit → Crystal 記憶圖譜，附帶 30 天衰減與衝突佇列。當工程事實在一次 PR 或部署中改變時，機率式的記憶抽取始終落後於真實權威紀錄。",
        xmatrixAnswer:
          "在 xMatrix 中，合併 PR 或跑完檢查的那一次執行（Run）會直接原地改寫專案即時頁面——人與 Agent 讀的都是同一份權威文本，並內建建議模式、逐段署名與修訂歷史。",
      },
      {
        title: "沒有 Agent 編排、團隊頻道或跨主機執行",
        problem:
          "Nowledge Mem 不會啟動開發 Agent、無法在共享頻道協調多位隊友，也不能跨主機路由工作——你依然得自行拼裝執行器、通道與 MCP 設定。",
        xmatrixAnswer:
          "xMatrix 是完整的協作執行層：在同一產品中整合共享頻道、涵蓋 34 種程式設計代理的跨主機路由、漸進式頁面大綱／章節讀取與即時頁面。",
      },
      {
        title: "團隊同步仍在封測，且缺乏維運治理能力",
        problem:
          "Nowledge Mem Team 仍處於封閉測試（private beta），本機部署要求 macOS 15+ 與手動 MCP／代理設定，且沒有 Space 機密庫或正式環境工具的核准閘門。",
        xmatrixAnswer:
          "xMatrix Space 今天即可自助啟用，支援 macOS、Windows、Linux、iPhone 與 iPad、Android 以及 Web，並內建 Space 層級機密與 40 多個整合工具的個別應用權限原則。",
      },
    ],
    comparisonRows: [
      {
        dimension: "核心任務",
        xmatrix: "在共享頻道執行多 Agent 工作，並維護即時頁面",
        competitor: "從跨工具對話紀錄中抽取、索引並檢索記憶",
      },
      {
        dimension: "事實權威來源",
        xmatrix: "由實際執行任務直接改寫的權威動態 Markdown 頁面",
        competitor: "帶 30 天衰減的推測圖譜／向量 Crystal；LLM Wiki 僅為衍生檢視",
      },
      {
        dimension: "團隊版本可用性",
        xmatrix: "今日即開放自助式 Free（500 次終身寫入）與 Pro 團隊 Space",
        competitor: "本機個人版正式推出；Cloud 公測中；Team 工作區封測中",
      },
      {
        dimension: "代理執行",
        xmatrix: "跨自有主機啟動並路由 34 種程式設計代理（含 --runtime）",
        competitor: "不執行也不路由開發 Agent",
      },
      {
        dimension: "機密與外部應用",
        xmatrix: "Space 層級機密 + 40 多個具個別應用原則的整合工具",
        competitor: "Team 版僅含託管 Slack 連線；無維運連接器核准層",
      },
    ],
    stayWhen: [
      "你需要一套離線個人記憶圖譜，用來跨網頁版 ChatGPT、Claude 網頁版與 Cursor 擷取對話，且不打算改變現有的程式執行方式。",
    ],
    switchWhen: [
      "你希望由實際做完工作的 Agent 直接維護權威專案頁面，而不是仰賴背景抽取器從舊對話猜測事實。",
      "你今天就需要可用的團隊 Space（而非封測），包含跨主機 Agent 執行與 40 多個受控管維運整合工具。",
      "你不想在 macOS、Windows、Linux、Android 與 Web 之間手動維護本機代理與通道設定。",
    ],
    migrationSteps: [
      {
        title: "將長期有效的知識升級為 xMatrix 即時頁面",
        detail: "把關鍵決策與架構筆記（包含 OKF／Markdown 匯出檔）依專案結構匯入 xMatrix 頁面。",
      },
      {
        title: "一次連接所有開發工具",
        detail: "在 xMatrix 註冊 Claude Code、Codex、Cursor 或 Gemini，讓每次執行精準讀取所需頁面大綱／章節並寫回最新結果。",
      },
      {
        title: "用 Norn 例行任務維持頁面常新",
        detail: "讓 Agent 依排程更新指標、發行說明與待辦阻礙，不必再為了掃描閒置聊天紀錄而白付背景 LLM 抽取 Token。",
      },
    ],
    faqs: [
      {
        question: "沒有向量資料庫的話，xMatrix 如何避免 Agent 一次讀入過多脈絡？",
        answer:
          "xMatrix 支援漸進式閱讀——Agent 先瀏覽 Space 頁面樹與摘要、檢查頁面大綱與各章節大小，只讀取必要章節並原地改寫該章節。",
      },
      {
        question: "我可以同時並用 Nowledge Mem 與 xMatrix 嗎？",
        answer:
          "可以。若你想用它保存日常網頁聊天的個人跨瀏覽器記憶，完全沒問題；同時把共享專案真相、Agent 編排與團隊核准交給 xMatrix。",
      },
      {
        question: "如果 Agent 在 xMatrix 頁面寫錯內容怎麼辦？",
        answer: "每份頁面都保存完整修訂歷史並支援無鎖定共同編輯——你直接改寫任何一行，讀取該章節的 Agent 會在下一回合收到變更通知。",
      },
    ],
  },
  everos: {
    alsoKnownAs: "EverMind / EverMemOS",
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "EverOS (EverMemOS) 替代方案 (2026)：vs xMatrix",
    metaDescription:
      "正在尋找 EverOS 或 EverMemOS 替代方案？告別單機 SQLite 鎖定、隱藏的背景抽取 LLM 帳單與無團隊同步，改用 xMatrix 頻道與即時頁面。",
    eyebrow: "EverOS (EverMemOS) 替代方案 · EverOS vs xMatrix",
    headline: "EverOS vs xMatrix",
    lead: "EverOS（EverMemOS）以 Markdown 檔案搭配本機 SQLite 與 LanceDB 索引，但其開源 v1 明確禁止在同一目錄啟動第二個服務、將多租戶與同步排除在範疇外，且持續在背景消耗 LLM Token 進行抽取。xMatrix 為團隊帶來涵蓋 34 種程式設計代理的即時跨主機執行與權威即時頁面。",
    productCaption:
      "xMatrix 實景：由實際動手的開發 Agent 即時更新跨主機 Markdown 頁面，零單一目錄鎖定衝突，零背景抽取 Token 消耗。",
    painPoints: [
      {
        title: "單機架構限制，v1 明確排除同步與多租戶支援",
        problem:
          "EverOS v1 是為單一本機程序設計：在同一目錄啟動第二個服務會被直接拒絕，多租戶與分散式同步明確不在範疇內，當多個開發工具共用本機 Markdown／SQLite 目錄時也容易發生鎖定衝突。",
        xmatrixAnswer:
          "xMatrix 在所有隊友與已註冊的 macOS、Windows、Linux 主機間即時同步頁面與頻道，徹底告別本機 SQLite 鎖定互搶。",
      },
      {
        title: "持續的背景 LLM Token 開銷與本機索引負載",
        problem:
          "同時運作本機 LanceDB 向量索引以及持續呼叫 LLM 執行事件抽取、衝突消解與輪廓整合，不僅吃重單機記憶體，也帶來難以預測的持續 API 帳單——而在多使用者情境下 EverMemBench 準確率更降至 66.67%。",
        xmatrixAnswer:
          "xMatrix 不跑背景抽取迴圈去猜測舊對話發生了什麼事，而是由完成任務的 Agent 執行回合直接更新對應頁面章節。",
      },
      {
        title: "單純的記憶儲存無法執行、路由或治理開發 Agent",
        problem:
          "EverOS 本質是記憶後端（且 v1.7.1 已移除 Foresight 預測功能）；它無法跨主機召喚程式設計代理，也無法在接觸 Vercel、Cloudflare、Gmail 或 Stripe 前要求人工核准。",
        xmatrixAnswer:
          "xMatrix 將涵蓋 34 種程式設計代理的多 Agent 執行、Space 機密、40 多個整合工具的個別應用核准與即時頁面整合在同一工作區中。",
      },
    ],
    comparisonRows: [
      {
        dimension: "跨主機與團隊同步",
        xmatrix: "跨 macOS、Windows、Linux、Android 與 Web 的即時多人多主機 Space",
        competitor: "開源 v1 嚴格限單機；多租戶與同步不在範疇內",
      },
      {
        dimension: "知識維持最新方式",
        xmatrix: "實際執行任務的 Agent 原地改寫權威 Markdown 頁面",
        competitor: "背景 LLM 抽取寫入 SQLite + LanceDB 索引（額外 Token 消耗）",
      },
      {
        dimension: "Agent 執行與路由",
        xmatrix: "跨自有主機啟動並路由 34 種程式設計代理（含 --runtime）",
        competitor: "僅為記憶層；不執行也不協調 Agent 艦隊",
      },
      {
        dimension: "並行編輯處理",
        xmatrix: "即時協作頁面，支援建議模式、逐段署名與無鎖定合併",
        competitor: "本機目錄鎖定；多工具同時寫入易引發競爭衝突",
      },
      {
        dimension: "治理與外部連接器",
        xmatrix: "Space 層級機密 + 40 多個具個別應用原則的整合工具",
        competitor: "無",
      },
    ],
    stayWhen: [
      "你正在研究對話記憶評測基準（LoCoMo／LongMemEval），或想在單機 Python／CLI 堆疊內嵌入一個 Apache-2.0 本機記憶引擎。",
    ],
    switchWhen: [
      "你需要跨多台主機或與隊友協作，無法接受 v1 單一目錄的鎖定限制。",
      "你希望由實際執行任務的 Agent 直接維護權威 Markdown 頁面，而非長期支付背景 LLM 抽取成本。",
      "除了持久化專案知識外，你還需要涵蓋 34 種程式設計代理的真實執行能力與 40 多個受控管整合工具。",
    ],
    migrationSteps: [
      {
        title: "將既有的 Markdown 檔案直接帶入 xMatrix 頁面",
        detail: "因為 EverOS 同樣以 Markdown 作為權威層，你整理好的專案筆記可直接搬入 xMatrix 頁面。",
      },
      {
        title: "將所有主機連接到同一個 Space",
        detail: "在筆電與伺服器安裝 xMatrix CLI，讓每款工具共享同一份即時頁面，不再踩到本機 SQLite 鎖定錯誤。",
      },
      {
        title: "交由實際執行任務維護各個章節",
        detail: "每次 Agent 合併程式碼或完成研究時直接更新對應章節，取代背景抽取管線。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 頁面是否也像 EverOS 一樣採用純 Markdown？",
        answer: "是的。頁面是結構化的 Markdown 文件，支援章節層級讀寫、完整版本紀錄以及即時人機共寫。",
      },
      {
        question: "xMatrix 會為了背景記憶整合而額外消耗 LLM Token 嗎？",
        answer:
          "不會。因為實際動手的 Agent 在完成任務當下就會順手更新頁面，你不必再養一條常駐抽取管線反覆掃描每份聊天紀錄。",
      },
      {
        question: "相較於 EverOS，xMatrix 在多人協作上的表現如何？",
        answer: "xMatrix 從第一天就專為多人多 Agent 的 Space 設計，提供具名編輯、即時頻道，完全沒有單機目錄鎖定限制。",
      },
    ],
  },
  youmind: {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "YouMind 替代方案 (2026)：YouMind vs xMatrix",
    metaDescription:
      "比較 YouMind 替代方案？擺脫每月 US$20–$200 單人點數方案與缺少 Android／團隊支援的限制，改用 US$10／席位的 xMatrix 多人開發頻道、本機儲存庫執行與即時頁面。",
    eyebrow: "YouMind 替代方案 · YouMind vs xMatrix",
    headline: "YouMind vs xMatrix",
    lead: "YouMind 是一款精緻的個人創作工作室，擅長將影片、Podcast 與網頁研究彙整成簡報與文章（每月 US$20–$200 點數方案），但缺乏原生團隊協作、沒有 Android App，對 GitHub／Linear 也僅止於橋接脈絡而非執行本機開發 Agent。xMatrix 在同一個多人 Space 中整合程式碼交付、研究與維運。",
    productCaption:
      "xMatrix 實景：在涵蓋桌面、網頁、Android 與 iOS 的同一個多人 Space 裡，把研究筆記、規格與多 Agent 軟體交付一次串起。",
    painPoints: [
      {
        title: "個人創作工作室定位——缺乏即時團隊頻道與權限治理",
        problem:
          "YouMind 圍繞個人研究看板設計，而非多人工作區。團隊缺少共享即時頻道、角色型核准原則，以及共同交付軟體所需的 Space 層級機密。",
        xmatrixAnswer:
          "xMatrix 將隊友與 Agent 聚在共享的公開與私人頻道中，搭配即時頁面與個別應用「唯讀／先詢問／讀寫」治理。",
      },
      {
        title: "並非本機開發 Agent 執行器，且點數方案高達 US$40–$200／月",
        problem:
          "YouMind 雖能橋接 GitHub 與 Linear 來草擬規格，卻無法在你的本機儲存庫與建置主機上編排 Claude Code、Codex 或 Cursor。重度多媒體任務會迅速消耗 Starter（US$20／2 萬點）與 Pro（US$40／4 萬點），把桌面 Agent 工作流推向 US$100–$200 的 Max 方案。",
        xmatrixAnswer:
          "xMatrix 以 Pro 每位人類成員 US$10／月，讓你在自有主機沿用原本訂閱執行真實開發工具，同時兼顧研究、文件與維運。",
      },
      {
        title: "沒有官方 Android App，跨裝置工程流程支離破碎",
        problem:
          "YouMind 僅提供 iOS 與 Chrome 擴充功能，沒有官方 Android App，讓 Android 開發者離開座位就無法監控或引導任務。",
        xmatrixAnswer:
          "xMatrix 橫跨 macOS、Windows、Linux、iPhone 與 iPad、Android 以及 Web，將研究、規格、程式碼 PR 與上線進度統一收斂在共享的即時頁面中。",
      },
    ],
    comparisonRows: [
      {
        dimension: "核心定位",
        xmatrix: "以即時頁面為核心的多人軟體開發、研究與維運協作",
        competitor: "個人多媒體研究與內容創作看板",
      },
      {
        dimension: "本機程式碼執行",
        xmatrix: "直接在你的本機儲存庫執行 34 種程式設計代理（含 --runtime）",
        competitor: "僅橋接 GitHub／Linear 脈絡；桌面 Agent 需 US$100–$200 Max 方案",
      },
      {
        dimension: "定價方案",
        xmatrix: "免費方案（500 次終身寫入）+ Pro US$10／人類席位／月（年繳 US$8），自備模型訂閱",
        competitor: "Starter US$20／Pro US$40／Max US$100–$200／月（按點數計量）",
      },
      {
        dimension: "團隊協作",
        xmatrix: "多人多 Agent 頻道、共編即時頁面、Space 機密",
        competitor: "以單人看板為主；協作多仰賴匯出成品",
      },
      {
        dimension: "平台覆蓋範圍",
        xmatrix: "macOS、Windows、Linux、iPhone 與 iPad、Android 以及 Web",
        competitor: "網頁、iOS、Chrome 擴充功能；無官方 Android App",
      },
    ],
    stayWhen: [
      "你的主要目標是個人多媒體內容製作——把 YouTube 影片與 Podcast 轉化成圖文文章、簡報與短影音。",
    ],
    switchWhen: [
      "你希望研究資料與規格書就住在同一個 Space 裡，讓開發 Agent 直接據此開 PR、跑測試並部署上線。",
      "你需要團隊協作、使用 Android，或不想在既有開發訂閱外再多付每月 US$40–$200 的創作點數費。",
    ],
    migrationSteps: [
      {
        title: "將進行中的研究簡報移入 xMatrix 即時頁面",
        detail: "把競品分析、發布計畫與架構筆記存放在頁面裡，讓 Agent 既能更新也能直接動手執行。",
      },
      {
        title: "連接開發 Agent 與發佈工具",
        detail: "在自有主機執行 Claude Code、Codex 或 Gemini，連結 GitHub（唯讀或讀寫）以及套用「先詢問」核准的 Google Docs、Notion、X 或 Search Console。",
      },
      {
        title: "自動化定期研究與報表彙整",
        detail: "在頁面內嵌排程 Norn 程式，由 Agent 依排程更新每週摘要與關鍵指標。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 除了寫程式，也能處理研究、撰文與產品發布嗎？",
        answer: "可以。許多團隊在軟體工程之外，同時用 xMatrix 頁面管理研究、SEO、產品發布、招募與日常維運，全都由 Agent 持續保持最新。",
      },
      {
        question: "xMatrix 有 Android App 嗎？",
        answer: "有的。xMatrix 提供 Android App（可從 Google Play 或 APK 安裝），另有 iPhone 與 iPad App、macOS 與 Windows 桌面應用程式、Web，以及供 Linux 主機使用的 CLI。",
      },
      {
        question: "外部 Agent 也能搭配 xMatrix 使用嗎？",
        answer:
          "可以。xMatrix 內建支援 34 種程式設計代理（並可透過 --runtime 接入任何自訂 CLI），同時對外部工具開放 MCP 伺服器。",
      },
    ],
  },
  jules: {
    verifiedDate: "2026 年 11 月 22 日",
    statusNote: "Google Jules 已於 2026 年 11 月 11 日進入唯讀模式，並將於 2026 年 12 月 31 日完全關閉。",
    metaTitle: "Google Jules 替代方案 (2026 年底關閉) — xMatrix",
    metaDescription:
      "Google Jules 已於 11 月 11 日轉為唯讀，並於 2026 年 12 月 31 日正式關閉。將匯出的 Jules 記憶、排程與 GitHub 儲存庫帶到 xMatrix，並肩執行 Antigravity、Claude Code 與 Codex。",
    eyebrow: "Google Jules 替代方案 · 12 月 31 日關閉遷移指南",
    headline: "遷出 Google Jules",
    lead: "Google Jules 已於 2026 年 11 月 11 日停止執行新工作階段，並將於 2026 年 12 月 31 日徹底下線，且未提供記憶、排程或任務的自動遷移。xMatrix 讓你將匯出的脈絡直接匯入即時頁面，並繼續從手機或 Web 非同步派發 GitHub PR——在你自有的常駐電腦或自管 VPS 上執行 Google Antigravity 與其餘 33 種程式設計代理。",
    productCaption:
      "xMatrix 實景：從 Web 或手機持續非同步推進 GitHub Issues，讓 Google Antigravity、Claude Code、Codex 與其餘 31 種程式設計代理在你自有的常駐主機或 VPS 上並肩合作。",
    painPoints: [
      {
        title: "2026 年 12 月 31 日永久關閉，且僅支援手動匯出",
        problem:
          "Jules 已於 11 月 11 日進入唯讀模式，並於 2026 年 12 月 31 日完全終止服務。雖然透過 @google/jules 可以匯出環境變數、記憶、排程任務與工作階段紀錄，但 Google 並未提供自動遷移至 Antigravity 的機制，迫使團隊必須手工重建流程。",
        xmatrixAnswer:
          "xMatrix 今天就能乾淨承接你的資產：將匯出的 Jules 記憶放進即時頁面、把匯出的 .env 機密存入 Space 機密，並在頁面內用 Norn 程式重建定期排程。",
      },
      {
        title: "全數押注單一 Google Antigravity 的單廠商配額焦慮",
        problem:
          "Hacker News、Reddit 與 Google AI 論壇的開發者紛紛表達對失去 Jules 可預期每日非同步任務模式的無奈，並擔心把所有工作集中到單一廠商的統一配額池後，會更常撞上意外上限或超額費用。",
        xmatrixAnswer:
          "xMatrix 原生支援將 Google Antigravity 與其餘 33 種程式設計代理（Claude Code、Codex、Cursor、Gemini CLI 等）並列運行——當單一廠商配額視窗耗盡時，也能將工作交接給其他供應商。",
      },
      {
        title: "重建輕量行動端與非同步清理 GitHub 待辦的習慣",
        problem:
          "早期遷移者反映，離開 Jules 後中斷了原本在手機隨時開單、非同步清掉 GitHub Issues 並產出 PR 的輕快習慣，不必整天守在本機 IDE 前。",
        xmatrixAnswer:
          "只要連上一台常駐電腦或你自管的 Linux VPS，再從 iPhone、iPad 或 Android App 或 Web 輸入 @auto repo:owner/repo，或由 GitHub 事件自動觸發 Agent，就能非同步看著 PR、CI 狀態與頁面更新陸續到位。",
      },
    ],
    comparisonRows: [
      {
        dimension: "服務狀態（2026 年 11 月）",
        xmatrix: "持續活躍、自助啟用、公開原始碼（FSL-1.1-ALv2）",
        competitor: "自 2026 年 11 月 11 日轉為唯讀；2026 年 12 月 31 日永久關閉",
      },
      {
        dimension: "執行工具與模型選擇",
        xmatrix: "Google Antigravity + 其餘 33 種程式設計代理（含 --runtime）與配額交接",
        competitor: "僅限 Google 雲端 Agent（退場整合至 Google Antigravity）",
      },
      {
        dimension: "記憶與專案文件",
        xmatrix: "人與每款工具共享的動態 Markdown 頁面",
        competitor: "12 月 31 日前可透過 @google/jules CLI 匯出；無自動遷移",
      },
      {
        dimension: "排程與事件驅動任務",
        xmatrix: "內嵌於頁面的 Norn 程式（cron + GitHub／連接器事件）",
        competitor: "排程任務已於 11 月 11 日停跑；僅能匯出為本機快照",
      },
      {
        dimension: "程式碼執行位置",
        xmatrix: "你自有的常駐電腦或自管 Linux VPS（不提供 xMatrix 託管雲端 VM）",
        competitor: "Google 託管雲端 VM（12 月 31 日關閉）",
      },
    ],
    stayWhen: [
      "2026 年 12 月 31 日之後將無法繼續留在 Jules——請務必在服務終止前透過 npm install -g @google/jules 完成資料匯出。另請留意：xMatrix 需要你自備常駐電腦或自管 VPS，不提供託管雲端 VM。",
    ],
    switchWhen: [
      "你想繼續使用 Google Antigravity，並與其餘 33 種程式設計代理並肩運作，不必把所有工作押注在單一廠商。",
      "你需要一個長久穩定的家，承接匯出的 Jules 記憶、環境機密與 GitHub 排程巡檢任務。",
      "你手邊已有 Mac Studio、桌機或平價 Linux VPS，想要一套不會因雲端測試服務關閉而被迫中斷的手機非同步開 PR 工作流。",
    ],
    migrationSteps: [
      {
        title: "在 2026 年 12 月 31 日前匯出你的 Jules 資料",
        detail: "執行 Google 官方的 @google/jules 匯出工具，將記憶、排程任務、設定腳本與環境變數妥善備份至本機。",
      },
      {
        title: "將記憶載入即時頁面，將機密移入 Space 機密",
        detail: "把匯出的專案記憶貼進 xMatrix 頁面，並將匯出的 .env 機密存入 Space 機密（絕不貼進聊天室明文）。",
      },
      {
        title: "連接你的常駐主機或 VPS 與 GitHub",
        detail: "在 xMatrix 註冊一台常駐桌機或你自管的 Linux VPS、連結 GitHub，並以頁面內的 Norn 程式重建定期巡檢。",
      },
    ],
    faqs: [
      {
        question: "從 Jules 遷移後，我還能在 xMatrix 裡執行 Google Antigravity 嗎？",
        answer:
          "可以。xMatrix 原生支援 Google Antigravity（agy），並可在你的自有主機上與其餘 33 種程式設計代理（Claude Code、Codex、Cursor、Gemini 等）並列運作。",
      },
      {
        question: "xMatrix 會像 Jules 一樣提供託管雲端 VM 嗎？",
        answer:
          "不提供——xMatrix 需要一台由你掌控的常駐電腦（你的桌機、Mac Studio 或自管的平價 Linux VPS）。換來的好處是零廠商綁定：即使某個託管雲端測試服務退場，你的儲存庫與工作流也不會跟著消失。",
      },
      {
        question: "如何在 xMatrix 取代 Jules 的排程任務？",
        answer: "只要在 xMatrix 專案頁面直接加入一段 Norn 程式區塊，它就會依你的排程或 GitHub 事件自動執行並把結果更新回頁面。",
      },
    ],
  },
};
