---
title: "Norn 程式：協調 Agent 與團隊成員 · xMatrix 文件"
description: "在 xMatrix 頁面上撰寫 Norn 程式來協調 Agent 與團隊成員：強型別請求、截止時間、例行任務與事件觸發，確保每項請求都有明確結果。"
---

# 程式

程式（Program）用來定義多位 Agent 與團隊成員如何協力完成一項工作：向誰請求什麼、按什麼順序、在何時之前回覆，以及對方拒絕或未回應時該怎麼處理。只要在頁面上寫好一次，xMatrix 就會自動照著執行，不再需要人工在 Agent 之間傳話或記得催促回覆。

程式以開放的協作語言 [Norn](https://norn-lang.org) 撰寫。xMatrix 是它的執行宿主：負責保存每筆請求紀錄、派送任務、管理計時器，並嚴格套用你的 Space 權限。在實際套用到團隊前，你也可以先在 [Norn 演練場](https://norn-lang.org/norn/)用模擬團隊試跑看看。

## 你的第一個程式

打開一個頁面，加入一個標記為 `norn run` 加上名稱的程式碼區塊，然後儲存：

````markdown
```norn run release-notes
let notes = run(@claude, "Draft the release notes for 2.4")->wait?
switch confirm(@alice, "Publish these notes?", ~about=notes, ~by=1d)->wait {
| Answered(Yes) => run(@claude, "Publish the notes", ~about=notes)->wait
| Answered(No) | NoReply => Refused("Not published")
| other => fail(other)
}
```
````

請將 `@claude` 換成你 Space 中的 Agent，將 `@alice` 換成實際成員名稱。儲存頁面後程式便會啟動：先請 Agent 草擬發行說明，再請該成員確認是否發布；如果超過一天未獲回覆，程式便會直接結束而不進行發布。

僅標記為 `norn` 的區塊（或位於引用區塊中的程式碼）只會顯示而不會執行。你也可以請 Agent 幫你寫程式：只要請它把程式加進頁面，儲存時它就會自動讀取檢查器回報的錯誤並修正。

## 請求與回覆

程式的核心機制是發出請求（Request）。不同的動詞要求不同型別的回覆：

| 動詞 | 請求內容 |
| --- | --- |
| `run(who, task)` | 執行一項工作，並依程式指定的格式回傳結果 |
| `confirm(who, question)` | 回答「是」或「否」 |
| `choose(who, question, [A, B])` | 從選項中擇一 |
| `ask(who, question)` | 以文字回答問題 |

`~about=` 用來說明這筆請求的主題對象，`~context=` 可帶入額外參考資料，`~by=` 則可設定截止時間，格式可為時間長度（如 `4h`、`2d`）或 UTC 時間點。`->wait` 會等待這筆請求結束。

每筆請求最終必定會收斂到以下六種回覆之一，且程式必須處理所有分支；漏掉任何一種情況的程式都無法啟動。

| 回覆 | 意義 |
| --- | --- |
| `Answered(x)` | 對方已回覆，內容為 `x` |
| `Refused(why)` | 對方明確拒絕 |
| `NoReply` | 已超過截止時間仍未獲回覆 |
| `Broke(why)` | 對方嘗試執行但失敗，或無法聯繫 |
| `Cancelled` | 程式主動取消了該筆請求 |
| `Revoked` | 該筆請求所依據的授權已失效 |

`->wait?` 是簡寫語法，代表「若收到正常回覆就繼續往下執行，遇到其他任何狀況則以此回覆直接結束程式」。完整語法請參考 [Norn 語言規格書](https://github.com/norn-lang/norn/blob/main/docs/spec.md)。

## 向 Agent 發出請求時會發生什麼事

對執行工具名稱（如 `@claude`、`@codex`）或 `@auto` 發出請求時，會像對話提及一樣啟動對應 Agent，並告知任務內容與要求的回覆格式。啟動條件可寫在括號內：`@auto(~repo="acme/app", ~effort="high")` 支援 `repo`、`pwd`、`machine`、`harness`、`model` 與 `effort`。

Agent 會透過指令提交回覆，回覆內容同時也會以它的名義張貼在對話中：

```sh
xmatrix reply <request> 'Sound'
xmatrix refuse <request> '<why>'
xmatrix broke <request> '<why>'
xmatrix delegate <request> @Daniel '<why>'   # 轉交由他人代為回覆
xmatrix requests            # 檢視你目前待回覆的請求，以及你的程式正在等待的請求
```

只有被指派該請求的執行回合（Run）能提交回覆。格式不符的回覆會被退回，請求也會維持開啟。請求絕不會無限期懸置：若 Agent 啟動失敗、被中途停止，或結束回合卻未回覆，在工作意外中斷的情況下系統會轉交給全新 Agent 重試一次，其餘情況則直接結案為 `Broke`，讓程式走入預先定義的錯誤處理分支。

## 向團隊成員發出請求時會發生什麼事

發給成員姓名或帳號代碼的請求，會在對話中呈現為一張互動卡片，清楚列出問題、選項與截止時間，並同步出現在對方的 **Needs you** 清單中。只有該指定成員可以回覆；點擊 **Decline** 則可附上理由拒絕。沉默絕不等於同意：超過 `~by` 時限請求即結案為 `NoReply`；若未設定 `~by`，則會持續等待直到對方回應。

如果 Space 中找不到該名稱，或有多位成員撞名，該請求會直接結案為 `Broke` 並說明原因。

## 將請求委派給其他人

目前持有請求的人或 Agent，都可以將其委派（delegate）給另一位參與者代為回覆：在卡片上點擊 **Delegate…**，指定另一位成員、Agent 名稱（如 `@claude`）或對話中的既有執行個體（如 `@claude:2`），並填寫原因即可。程式本身不會察覺這層委派，截止時間維持不變，而對話紀錄會清楚呈現是誰代替誰作答。受託人可以完成回覆，或是將請求退回（點擊 **Give back** 或執行 `xmatrix refuse`），退回後責任便回到原持有人身上。在請求尚未結案前，原持有人也能隨時在卡片點擊 **Take back** 收回。Agent 則使用 `xmatrix delegate` 執行委派。

## 檢視程式目前的執行進度

頁面會在程式區塊下方繪製視覺化流程圖，呈現已發出的每筆請求與結果、目前正在等待誰以及期限為何，以及接下來所有可能走向的分支。若程式碼無法通過檢查，也會直接標示錯誤行號與原因。

每個程式都有獨立對話，連結至所屬頁面並以頁面與區塊名稱命名。所有請求、回覆與最終結果都會記錄在此，且完成最後一項工作的 Agent 會留在對話中，方便你直接留言追問後續細節。

```sh
xmatrix page read <page-id>     # 列出頁面上的程式與各自目前的執行狀態
```

## 修改與停止程式

修改程式就像編輯頁面上的一般文字一樣自然：

- **編輯區塊並儲存。** 系統會對照既有的請求紀錄重新評估程式：字面完全相同、已經詢問過的請求不會重問，新增的步驟才會開始執行。若修改後的程式未通過語法檢查，新版本不會套用。
- **重新命名區塊**會建立一個全新的程式並開啟專屬對話。同一頁面上若出現兩個同名區塊，在其中一個改名之前兩者都不會執行。
- **移除區塊**（或刪除整個頁面）會立即停止程式並取消所有進行中的請求。停止程式所屬對話也有相同效果。
- **編輯已結束的程式區塊**可讓它重新執行。

程式一律以最後儲存該頁面的成員身分與權限運作；若由 Agent 儲存，則套用該 Agent 擁有者的權限。

## 定期重複的例行工作

`open Std` 會引入 Norn 標準函式庫。只需一行呼叫就能建立例行任務（routine）：

````markdown
```norn run upkeep
open Std
routine(~every=7d, ~from=2026-11-16T09:00Z, ~who=@auto(~repo="acme/app"),
  ~otherwise=@claude(~repo="acme/app"), "Weekly upkeep: fix the riskiest open issue")
```
````

系統會從指定時間起每週執行一回合。若某回合未順利取得回覆，系統會改向 `~otherwise` 指定的備援 Agent 再試一次；若仍失敗則在程式對話中回報異常，而例行排程仍會照常繼續。修改任務描述只會套用到下一次執行，不會重跑先前的回合。

定時提醒則由等待加上發送訊息組成：

````markdown
```norn run renew-domain
after(2026-11-03T01:00Z)->wait
say(@alice, "The domain renews this week")
```
````

標準函式庫同時提供 `decide`（僅在無人於期限內回覆時採納預設選項）、`remind`、`followUp`、`schedule` 與 `all`。

## 接收已連結應用程式的事件

程式可以監聽來自外部服務的事件流：

| 事件流 | 觸發時機 |
| --- | --- |
| `ciFailed("owner/repo")` | 該儲存庫預設分支上的工作流程執行失敗 |
| `prMerged("owner/repo")` | Pull Request 合併至預設分支 |
| `appEvent("sentry", ~feature="issue.created")` | [已連結應用程式](connectors.md)送來特定事件；省略 `~feature` 則接收該應用的所有事件 |

```norn
every(1d)->or(ciFailed("acme/app"))->forEach(_ =>
  run(@auto(~repo="acme/app"), "Check the build and fix what is broken")->wait)
```

這段程式每天定期檢查一次，並且在 CI 一失敗時就立刻啟動修復。Space 的外部連線必須已涵蓋對應的儲存庫或應用程式。

## 讓已連結的應用程式執行動作

程式可以讓[已連結的應用程式](connectors.md)在你指定的時間自行完成一件事，到時不需要任何 Agent 在線。分兩步：**準備**把要做的內容原樣固定並取得放行，此時不會送出任何東西；**發布**把它執行一次。

```norn
open Std
let post = (video, text, ~at) => spawn(~key=video, () => {
  let ready = X.prepareVideo("@acme", video, text)->wait?
  after(at)->wait
  X.publish(ready)->wait
})
ignore(all([
  post("<message id>/<attachment id>", "Stop pasting API keys.", ~at=2026-11-24T01:00Z),
  post("<message id>/<attachment id>", "One table for every agent.", ~at=2026-11-24T09:00Z),
]))
never()->wait
```

程式一啟動，兩則貼文就同時請求放行，你可以一次批完；之後各自在自己的時間送出。在清單加一行，只會多問新加的那一則。最後一行讓程式持續執行，清單才能不斷追加：已經送出的貼文不會再送，無論那一行留著還是刪掉。

「放行」依該應用程式唯一的權限處理：

| 權限 | 程式準備一個動作時 |
| --- | --- |
| 讀寫（Read and write） | 直接放行 |
| 先詢問（Ask first） | 出現在對話的 **待審批（Pending approvals）**，Space 管理員能看到將使用的帳號、內文與附件，然後回答 |
| 唯讀（Read only） | 被拒絕 |

一次批准只對應這一個動作與這份內容，30 天內有效。到時 xMatrix 會再核對一次：連結與帳號仍是批准時的那個，批准的人仍有權批准；任何一項不成立就不送出，程式會讀到原因。結果不確定的動作記為失敗，絕不自動重試。影片附件必須在程式自己的對話裡。

`X.preparePost(account, text)` 準備一則不含影片的貼文。其他應用程式的動作以名稱呼叫，輸入是其命令的兩部分，寫法見 `xmatrix connector list`：

```norn
type command = {target: string, text: string}
type done = {summary: string, url: option<string>}
let post: Actions.action<command, done> = Actions.action("slack", "post")

let ready = Actions.prepare(post, {target: "#releases", text: "4.2 is out."})->wait?
Actions.perform(ready)->wait
```

## Agent 單次提問

如果 Agent 只需要問一個問題取得回覆，不需要特地寫一支程式，直接用指令提問即可，回覆會直接傳回給它：

```sh
xmatrix confirm @alice Ship 4.2 now? --by 1d --otherwise No
xmatrix choose @alice "Which plan?" Monthly Yearly
xmatrix ask @codex What does the migration change?
```

`--by` 設定截止時間，`--otherwise` 設定逾時後的預設回覆。問題會在對話中呈現一次：對人會顯示為互動卡片，標明提問的 Agent 與最終結果；對 Agent 則作為待回覆請求送達。若 Agent 問錯內容或問錯對象，可執行 `xmatrix cancel <request>` 撤回，卡片隨即會顯示該問題已取消。

## 在訊息中執行一次性程式

在一般對話訊息中附帶單一個 `norn run` 區塊，即可針對當下任務啟動一支一次性程式。它的運作方式與頁面程式相同，差別在於送出後無法編輯，且每筆請求都會啟動新的 Agent。

## 限制

- 請求對象目前不能指定特定編號的執行個體（如 `@claude:2`）。
- 程式目前尚無法等待單一特定事實（例如某個指定 PR 是否已合併或包含在某版本中），僅能監聽上述事件流。
- 儲存修改前目前暫無預覽差異的功能。
