---
title: "AI 開發 Agent 的 @ 提及訊息語法 · xMatrix 文件"
description: "xMatrix 訊息語法完整參考：透過 @ 提及啟動 Claude Code 或 Codex，指定儲存庫、模型與推理強度，並停止、重啟或交接 Agent。"
---

# 訊息語法

你在 xMatrix 中下達的每一項指令，本質上都是一則普通訊息。沒有隱藏的表單：你輸入的文字就是系統儲存的內容，伺服器讀取的也和你看到的完全一致。輸入 `@`、`#` 或 `[[` 時，編輯器會自動提供補全建議，平時幾乎不需要死背語法。本頁提供完整語法參考。

## 語法速查

| 你輸入的內容 | 執行效果 |
| --- | --- |
| `@claude fix the failing test` | 啟動一個新的 Claude 執行個體並指派這項訊息任務 |
| `@auto repo:acme/api fix the failing test` | 讓 xMatrix 自動挑選 Agent，並在 `acme/api` 的新 worktree 中啟動 |
| `@codex pwd:"/Users/me/my app" …` | 在已註冊的資料夾內原地啟動 |
| `@codex model:<id> effort:high …` | 指定特定模型與推理強度啟動 |
| `@claude:2 also update the changelog` | 繼續與此對話中編號 2 的 Claude 執行個體互動 |
| `@claude:2 /model <id>` | 切換執行中個體的模型 |
| `@claude:2:stop` | 停止該執行個體 |
| `@claude:2:reborn` | 保留記憶並重新啟動該執行個體 |
| `@claude:2:handoff:@codex finish the migration` | 將它的程式碼簽出目錄交接給一個新的 Codex 執行個體 |
| `/stop all` | 停止此對話中的所有執行個體 |
| `@Maya` · `@everyone` | 通知某位成員，或通知對話中的所有人 |
| `@github:subscribe:acme/web pulls checks` | 執行已連結應用程式的操作 |
| `page:<id>` · `channel:<id>` | 參照某個頁面或對話 |

## 提及（Mentions）

提及由 `@` 加上名稱組成。當 `@` 位於訊息開頭，或緊接在空白字元或左括號之後時才會生效。全形的 `＠` 與半形 `@` 效果完全相同。

名稱比對不分大小寫，並採用最長符合優先原則，因此 `@codex-mba` 不會被誤判為 `@codex`。

用來啟動或指揮 Agent 的提及必須是獨立的詞彙：後方請加上空白、換行或結束標點符號。若是單純通知成員的提及，則可以直接緊接在中文或日文文字前方，例如 `@Maya的方案`。

### 不會觸發提及的情境

出現在以下區塊中的 `@` 會被視為純文字，不會通知任何人，也不會啟動任何 Agent：

- 行內程式碼與程式碼區塊
- 引用區塊（block quotes）
- 超連結與圖片
- 刪除線文字

當你想討論語法本身而不觸發動作時，只要把範例放進反引號（backticks）即可。

### 提及成員

輸入 `@` 並選擇成員。提及可以使用對方顯示名稱（如 `@Maya Chen`）或帳號代碼（handle）。被提及的成員會收到通知，待對方已讀後通知即會清除。

`@everyone`、`@channel`、`@all` 與 `@here` 會通知對話中的所有成員。

如果兩位成員同名，或成員名稱與 Agent 名稱衝突，系統會拒絕該則訊息，直到你改用對方的帳號代碼明確指定。

## 啟動 Agent

提及一個執行工具（harness）名稱，會在此對話中啟動一個**全新**的執行個體：

```text
@claude rework the hero so it shows the product
@codex check the mobile breakpoints
@auto find out why billing webhooks retry twice
```

- `@<harness>` 指定特定工具，如 `@claude`、`@codex`、`@cursor`、`@gemini` 等。完整清單請見[支援的執行工具](agents.md#supported-harnesses)。
- `@auto` 交由 xMatrix 自動決定。系統會閱讀任務內容，挑選最適合的工具，並指派給資源餘裕最充足的主機。

訊息其餘部分就是任務說明。Agent 同時也會收到對話上下文，因此當上方討論已交代背景時，簡短寫一句 `@claude take this one` 也完全足夠。

### 啟動條件

啟動條件用來限定 Agent 在哪裡以及如何啟動，格式為緊接在提及後方、以空白分隔的 `key:value` 詞組：

```text
@auto repo:acme/api model:<id> effort:high find out why webhooks retry twice
```

在這個例子中，`@auto` 是提及，後方的三個詞組是啟動條件，而從 `find` 開始的其餘文字則都是任務內容。

| 條件 | 說明 |
| --- | --- |
| `repo:<owner/repo>` | 在這個儲存庫的新建託管 worktree 中執行 |
| `pwd:"<absolute path>"` | 在這個已註冊的本機目錄中原地執行 |
| `machine:<name>` | 在擁有者所命名的這台主機上執行；可用 `xmatrix agent list` 查詢主機名稱 |
| `harness:<name>` | 搭配 `@auto` 使用：將選擇範圍限定在單一執行工具 |
| `model:<id>` | 指定使用的模型 |
| `effort:<level>` | 指定使用的推理強度（reasoning effort） |
| `fast:on` | 若該工具提供快速模式，將其開啟 |
| `param.<id>:<value>` | 設定該工具宣告支援的其他自訂選項 |

規則說明：

- **遇到第一個非條件詞彙即結束條件解析。** 從該詞彙開始的所有文字都屬於任務內容。因此輸入不認識的 `key:value` 只會被當作一般文字，不會報錯。
- **條件順序不拘**，但每個條件最多只能出現一次。
- **條件必須與提及在同一行。** 換行即結束條件解析。
- **值若包含空白，請用雙引號包起來。** 內部若有字面雙引號請連寫兩次：`pwd:"/Users/me/my ""old"" app"`。
- **無法滿足的條件會中止啟動。** xMatrix 不會私自替換其他模型或主機，提及標籤上會直接顯示未啟動的原因。

### Agent 的工作位置

`repo:` 與 `pwd:` 兩者擇一；單次提及最多只能帶入其中一個。

**`repo:`** 指定一個儲存庫。Agent 會獲得專屬的 git worktree，讓多個 Agent 可以同時在同一個儲存庫作業而不會互相覆寫檔案。GitHub 儲存庫直接寫 `owner/repo` 即可，也支援完整的 HTTPS 或 SSH remote URL（GitHub URL 會自動縮寫為 `owner/repo`）。參照中不可包含認證憑證、查詢字串或 fragment。

```text
@codex repo:acme/web …
@codex repo:https://gitlab.example.com/team/service …
```

**`pwd:`** 指定某人在主機上透過 `xmatrix workspace register` 註冊的目錄。Agent 會在該目錄現有狀態下原地工作。路徑必須為絕對路徑，且同時會鎖定該目錄所屬的主機。

```text
@claude pwd:/srv/app …
@claude pwd:"C:\Users\me\my app" …
```

若兩者皆未指定，xMatrix 會依任務內容比對 Space 內的儲存庫與目錄名稱及說明來自動選擇。如果從對話中看不出要處理哪個專案，建議自行明確寫出儲存庫名稱。

### 模型、推理強度與其他選項

`model:` 與 `effort:` 接受執行工具所回報的 ID。在編輯器選完工具後，系統會自動列出可用選項；你也可以在 [Agents 畫面](agents.md)查看。

除了模型與推理強度以外，各工具支援的額外選項不盡相同，因此沒有固定關鍵字。每個工具會自行宣告支援項目，你可以使用 `param.<id>:<value>` 來設定：

```text
@kimi param.<id>:<value> summarize the incident
@codex fast:on apply the rename
```

編輯器會列出各工具目前宣告的選項 ID 與可用值。`fast:on` 是 `param.fast:on` 的簡寫。布林開關接受 `on`、`off`、`true` 或 `false`。

### 誰可以啟動 Agent

從 xMatrix 訊息編輯器送出的訊息會直接啟動你召喚的 Agent。但如果是 Agent 自己傳送的訊息，唯有加上 `xmatrix send --launch` 才會啟動其他 Agent；若未加上此參數，它報告中寫到的 `@codex` 只是普通提及，不會意外觸發連鎖召喚。停止、重啟與交接則不論由誰操作皆一體適用。

未觸發啟動的提及會在標籤上標示狀態，訊息作者可以直接從標籤點擊啟動。單靠訊息文字本身無法強制啟動 Agent：舊有的 `launch:force` 條件已經停用並會被忽略，確保 Agent 無法在報告中寫入文字來偷渡啟動另一個 Agent。

### 新對話的第一則訊息

當新對話的第一則訊息沒有提及任何人或 Agent 時，你會有幾秒鐘的時間可以手動選擇要交給哪個 Agent 接手，或是都不指派。如果你沒有選擇，xMatrix 會閱讀訊息內容，只在判斷其中包含明確工作需求時才啟動 Agent。

後續對話中未提及任何對象的訊息不會啟動新 Agent。已經在該對話中的執行個體會收到訊息作為上下文，並自行判斷是否需要回應。

## 與特定執行個體對話

每個執行個體在所屬對話中都有獨立編號，顯示於名稱旁，例如 `claude:1`、`codex:2`。使用 `@<name>:<number>` 即可指定它：

```text
@claude:1 the tests still fail on Windows, take another look
```

這則訊息會精準傳遞給該執行個體。若它正處於休眠狀態，訊息會將其喚醒。編號僅在單一對話內有效：這裡的 `claude:1` 與另一個對話的 `claude:1` 是完全不同的執行個體。

直接「回覆（reply）」某個執行個體的訊息，即使不加 `@` 提及，同樣會傳遞給該執行個體。

對話中的其他執行個體會看到這則訊息作為上下文參考，但不會對指派給別人的訊息採取行動。

## 執行中個體的指令

指向單一執行個體並以 `/` 接續的訊息，會被視為給該個體的控制指令，而非工作任務：

| 指令 | 效果 |
| --- | --- |
| `@claude:1 /model` | 列出此執行個體可用的模型 |
| `@claude:1 /model <id>` | 切換模型 |
| `@claude:1 /effort` | 列出可用的推理強度等級 |
| `@claude:1 /effort <level>` | 切換推理強度（`/reasoning` 為同義指令） |
| `@claude:1 /config <id>` | 顯示某項工具選項的可用值與目前設定 |
| `@claude:1 /config <id> <value>` | 修改該選項設定 |
| `@claude:1 /fast on` · `off` · `status` | 控制快速模式；單獨 `/fast` 會切換開關 |
| `@claude:1 /goal <condition>` | 為該執行個體設定跨回合持續推進的完成條件 |
| `@claude:1 /goal status` · `pause` · `resume` · `clear` | 檢視、暫停、恢復或清除目標 |

切換設定會直接套用在執行中的工作階段，執行個體會保留原有記憶與簽出目錄，不需重新啟動。

`/model` 與 `/effort` 必須單獨佔據整則訊息；你可以在同一則訊息裡分行下達多條指令：

```text
@claude:1 /model <id>
@codex:2 /effort high
```

若混入了其他一般文字，整則訊息會被當作普通任務送出，避免設定只套用了一半。

各開發工具本身也支援專屬的斜線指令。在編輯器輸入 `@<name>:<number> /` 時，系統會列出該執行個體支援的斜線指令並直接透傳執行。

## 停止、重啟與交接

凡是能在對話中發言的成員都能控制對話內的執行個體，Agent 本身亦同。

| 你輸入的內容 | 效果 |
| --- | --- |
| `@claude:1:stop` | 停止此執行個體。`:kill` 效果相同。 |
| `@claude:1:stop wrong branch` | 停止並附上會顯示在狀態旁的原因 |
| `/stop all` | 停止對話中的所有執行個體。`/kill all` 效果相同。 |
| `/stop claude:1` | 停止單一執行個體的另一種寫法 |
| `@claude:1:reborn` | 保留原工作階段與簽出目錄，重新啟動同一執行個體 |
| `@claude:1:handoff:@codex` | 將它的工作與對話交接給一個新的 Codex 執行個體 |
| `@claude:1:handoff:@auto` | 同上，並交由 xMatrix 自動挑選接手者 |

**Stop（停止）**必須是整則訊息的主體；指令後方的所有文字都會被視為停止原因。已停止的執行個體不會因新訊息而喚醒，只能透過 `:reborn` 重新啟動。

**Reborn（重啟）**會恢復同一個執行個體：編號相同、記憶相同、工作目錄相同。適用於執行個體卡住、喚醒失敗或先前被停止的情況。提及後方的文字會在重啟後送交給它執行。

**Handoff（交接）**會先確認原執行個體已確實停止，再啟動另一個新的執行個體（常為不同工具）。路由過程套用一般的召喚授權與驗證規則。若原個體啟動時帶有明確的 `machine:` 條件，交接（包含自動配額交接）會保留在同一台主機上；若是系統自動配置的主機則可跨機移轉。若指定主機上沒有符合條件的接手者，交接會清楚顯示拒絕原因。當原個體尚在等待停止確認時不會啟動接手者，請待其背景服務確認程序結束後再重試交接。

接手對象後方可緊接一般召喚語法的啟動條件。你也可以直接以條件開頭指定接手者（如 `@claude:1:handoff:@machine:Laptop`、`@claude:1:handoff:@model:<id> effort:high`），將執行工具留給系統自動路由，寫法與一般召喚的 `@machine:Laptop` 相同。明確指定新的 `machine:` 會覆蓋原本繼承的主機條件，並重新通過權限與可用性檢查。模型、推理強度與工具參數皆依正常規則驗證；若明確指定了模型、推理強度或工具參數且無其他更佳選項，系統也可能在原註冊項目上啟動全新的執行個體。儲存庫或目錄條件必須與原本的工作位置一致；若要切換工作位置，請改用全新的指派訊息。第一個非條件詞彙之後皆為交接任務說明：

```text
@claude:1:handoff:@codex you have the branch; finish the migration and open the PR
@claude:1:handoff:@codex machine:Laptop effort:high continue in the original browser
@claude:1:handoff:@machine:Laptop model:<id> effort:high finish the migration
```

接手者一定是全新建立的個體，因此只需寫名稱而不帶編號。`@auto` 同樣會把工具選擇交給系統路由。

儲存庫的簽出目錄（包含尚未 commit 的變更）會透過交接分支完整移轉；已註冊的本機目錄則會留在原本的主機上。前任執行個體匯出的對話紀錄只作為前情提要，絕不會變成接手者的身分或工作階段。瀏覽器登入狀態與其他本機暫存狀態則不會隨簽出目錄遷移。

明確指定執行個體的訊息會作為該個體的任務，對其他同儕個體則是背景上下文。一般頻道訊息屬於共享工作；廣播提及仍會通知所有人。Agent 受信任的執行個體與執行（Run）識別碼會在整個恢復過程中維持一致。臨時協助用的助手個體在完成任務後應回傳最終結果並自行停止；仍在等待團隊成員回覆或 CI 結果的執行個體則仍有未完工作，會保持待命。

當模型供應商的配額用盡時，xMatrix 會嘗試自動交接給其他可用工具。如果沒有任何符合資格的接手者，你可以選擇 **Retry when quota recovers**（配額恢復後重試）或 **Not now**（暫不重試）。即使關閉頁面，等待狀態仍會持續運作，且隨時可以取消。最長等待期限為 35 天；重試前 xMatrix 會先確認供應商的實際配額已恢復。

## 已連結應用程式

連結到 Space 的外部應用程式可以像 Agent 一樣在訊息中呼叫操作：

```text
@<app>:<action>:<target> <text>
```

```text
@github:subscribe:acme/web pulls checks
@github:comment:acme/web:#42 Reproduced on main.
@sentry:resolve:<issue>
```

指令必須位於訊息開頭，每則訊息只能包含一個指令。第一行之後的內容皆屬於指令文字。所有支援的應用程式與操作請參閱[已連結應用程式](connectors.md)。

## 參照（References）

| 在編輯器輸入 | 儲存於訊息中的格式 | 顯示方式 |
| --- | --- | --- |
| 輸入 `[[` 並選擇頁面 | `page:<page-id>` | 顯示該頁面最新標題的標籤 |
| 輸入 `[[page#` 並選擇章節 | `page:<page-id>#<heading-slug>` | 可直接跳轉至該章節的標籤 |
| 輸入 `#` 並選擇對話 | `channel:<channel-id>` | 顯示該對話最新名稱的標籤 |

參照以 ID 儲存，因此重新命名頁面或對話絕不會造成舊訊息斷連。參照本身不附帶授權：沒有存取權限的讀者不會看到標題與連結。在對話中提及某個頁面，同時會將該頁面與此對話建立連結。

在頁面本文裡輸入 `page:<page-id>` 與 `channel:<channel-id>` 同樣會渲染成互動標籤；當游標移入參照時會再次顯示原始 ID 以便編輯。

`#` 後方緊接數字會維持純文字，因此 `#3484` 會正常保留為 Pull Request 編號。使用中文輸入法時，也可以直接輸入 `【【` 開啟頁面選擇清單。

## 限制

- 單則訊息本文最長為 131,072 字元。
- 單則訊息最多包含 8 個指令。
- 執行個體名稱、主機名稱、模型 ID 與推理強度最長各為 160 字元；路徑或儲存庫參照最長為 4,000 字元。

## 當沒有任何 Agent 啟動時

提及標籤本身會顯示目前狀態：等待中（waiting）、工作中（working）、已回覆（replied）、失敗（failed）或已停止（stopped），並附上原因。常見原因如下：

| 提及標籤顯示的狀態 | 處理方式 |
| --- | --- |
| Mentioned, not started | 傳送該訊息時未要求啟動 Agent：在標籤上按 Start，或改用 `xmatrix send --launch` 重新傳送 |
| No registered environment offers the requested model, effort or harness | 核對工具回報的實際 ID，或移除該條件；執行 `xmatrix agent list` 可查看每台主機執行的工具 |
| The requested machine does not run this Agent | 透過 `xmatrix agent list`（或 Agents 頁面）查看每台主機的工具、上線狀態與配額 |
| The requested directory is not authorized | 請在該主機上執行 `xmatrix workspace register` 註冊該目錄 |
| The repository reference is invalid | 請改寫為不含認證憑證的 `owner/repo` 格式 |
| Every matching environment has used up its provider quota | 等待配額重置，或改指定其他執行工具 |
| Only machines kept out of automatic assignment can run this | 使用 `machine:<name>` 明確指定其中一台主機 |
| The `:new` and `:once` suffixes are retired | 改用 `@auto repo:owner/repo`，不再使用舊的 `@agent:new:owner/repo` |

你也可以在終端機執行 `xmatrix diagnose <conversation>` 檢視同樣的診斷紀錄。
