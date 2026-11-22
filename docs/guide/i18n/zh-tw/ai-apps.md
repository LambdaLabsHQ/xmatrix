---
title: "透過 MCP 在 ChatGPT、Grok 或 Cursor 中使用 xMatrix · xMatrix 文件"
description: "連接 ChatGPT、Grok、Cursor 或其他支援 MCP 的 AI 應用程式，直接讀取與更新你的 xMatrix 頁面與對話。"
---

# 連接外部 AI 應用程式

你可以直接從 ChatGPT、Grok、Cursor、Codex，或任何支援遠端 MCP 與 OAuth 的用戶端，存取你在 xMatrix 中的頁面與對話。伺服器網址為：

```text
https://xmatrix-hub.xmatrix.sh/mcp
```

在你的 AI 應用程式中，使用上述網址新增自訂遠端 MCP 伺服器或連接器。系統提示時登入 xMatrix、核對應用程式名稱與請求的權限，接著核准連線即可。ChatGPT 將其稱為自訂 MCP 外掛（custom MCP plugins），Grok 則稱為自訂連接器（custom connectors），實際設定入口依各用戶端與訂閱方案而異。官方 MCP Registry 上的登錄名稱為 `io.github.LambdaLabsHQ/xmatrix`。

完成連結的應用程式會擁有與你在 xMatrix 中相同的存取權限。讀取權限讓它能尋找你的 Spaces、搜尋與閱讀頁面，以及讀取對話紀錄；若一併授予寫入權限，它也能以你的名義建立或編輯頁面，並在對話中發送訊息。送出的訊息若提及某個 Agent，同樣能請該 Agent 展開工作。頁面修訂紀錄與訊息標頭上都會在你的署名旁標註該外部應用程式的註冊名稱（此名稱由該應用程式提供）。

試著問它：「找出我的產品路線圖並摘要最新決策」或「顯示我的專案 Wiki」。支援 MCP Apps 的用戶端可以直接呈現頁面卡片，包含目前版本號、文字預覽與在 xMatrix 開啟原文的按鈕；其他用戶端則會以純文字格式收到相同的頁面內容與原文連結。

若要中斷連線，請開啟你的 xMatrix 個人檔案，進入 **AI apps** 並移除該應用程式。移除後該應用程式便無法再換發新的存取權杖，但最後一組已核發的權杖最長可能仍會在 15 分鐘內有效。先前已經傳送給外部供應商的資料，則依該供應商的服務條款與隱私權設定處理。
