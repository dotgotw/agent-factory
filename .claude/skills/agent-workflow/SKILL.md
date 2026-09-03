---
name: agent-workflow
description: agent-factory 的角色工作流程 —— 確認自己的角色、被 scope 擋下來時怎麼開 CR、跑探針驗證與回報數字時要小心什麼、送 PR 前跑什麼、PR label 怎麼掛、怎麼定址到別的 session、CI 紅燈怎麼處理。當你在這個 repo 要開始一項任務、被 scope-guard 擋下、要跑探針驗證某件事或把實測數字回報給別人、要交辦或回覆別的 session、要送出 PR,或 PR 的 CI 紅燈時使用。
---

# agent-factory 工作流程

規則本身在 `AGENTS.md` 與 `scripts/scope.json`。這份 skill 只講**程序**:
遇到某個情況該做什麼動作。

> 這份 skill 不是邊界。邊界是 CI 的 `check-scope.mjs` 與 `.github/CODEOWNERS`。
> 你照不照做,機制那邊都會驗一次。

## 1. 開工前

```bash
pnpm role
```

沒有角色就停下來問人,不要猜。角色決定你能寫哪些路徑,猜錯的代價是
整條分支重做。

角色應該由**開這個 session 的人**指派,不是由你自己決定:雲端用每個角色一個
環境並設 `AGENT_ROLE`,本機用 `AGENT_ROLE=qa claude`。若人類只在對話裡口頭
指定,你可以 `echo <role> > .claude/role` 記下來 —— 但那是記錄他的指派,不是
你自行挑一個。**永遠不要為了讓某個檔案寫得進去而改角色。**

你也不是換個角色就變成那個角色。qa 的規則是「不讀實作」,而 hook 只擋寫入、
不擋閱讀。已經讀過 `backend/src/` 的 session 改成 qa,寫出來的仍然是「配合
實作」而非「驗證 contract」的測試。需要換角色,請人類開新 session。

## 2. 被 scope 擋下來時

代表你想改的東西不歸你管。**不要繞過**——不要改 `.claude/role` 換一個角色,
不要改 `scripts/scope.json` 把路徑加進來,不要改用 Bash 寫檔避開 hook。
這些都做得到,而且都會在 review 被看見。

正確做法是開一份 CR:

```bash
cp change-requests/TEMPLATE.md change-requests/CR-00N.md
```

必填欄位(`pnpm check:cr` 會驗):

- `- **提出者**: <你的角色>`
- `- **狀態**: proposed`(只有 architect 能改成 accepted / rejected)
- `- **阻擋任務**: TASK-00N`(要存在於 `contract/tasks.yaml`)

內文要寫清楚:問題是什麼、不改的話你有哪些爛選項、建議怎麼改、波及到誰。
CR-001 是好範例。

寫完就**停下這個任務**,等裁決。不要一邊等一邊先做「暫時的版本」。

## 3. 送 PR 前

```bash
pnpm verify
```

涵蓋 contract drift、CR 一致性、三個 scope 的 typecheck、e2e。全綠才送。

再自己確認一次邊界:

```bash
pnpm check:scope <role> origin/main
```

## 4. 送 PR 時

**一定要掛 `agent:<role>` label**,而且**恰好一個**。沒掛 label 的 PR,
`scope` job 會直接紅。

label 要誠實反映你這個 session 被指派的角色。掛一個「剛好能讓 diff 通過」
的 label 是作弊——CI 分辨不出來,但這正是 CODEOWNERS 要求人類 review
`.github/`、`scripts/`、`contract/` 的原因。

跨角色的變更**拆成多個 PR**,不要掛多個 label(CI 會擋)。

## 5. 自己驗自己:探針與數字

這個 repo 的協作方式是「我實測給你看」——PR 描述裡的探針、回報給別的 session 的
數字。**探針壞掉的時候,產出的不是錯誤,是一個假的結論**,而它會直接進到別人的
判斷裡。三個真的例子,都發生在這個 repo:

```bash
printf "exit=%s\n" "$(echo "$line" | cut -c1-38)" "$?"   # $( ) 先跑,把 $? 洗成 0
cmd | grep -c .                                          # 錯誤訊息被吞掉,只看到 0
echo "${PIPESTATUS[0]}"                                  # zsh 是 $pipestatus[1],印出空字串
```

第一個讓四種探針全部顯示 exit=0,差一點就回報「這個修正沒有生效」;第二個讓一次
失敗的刪除顯示成「成功刪除 0 個」;第三個只是印不出來,但它讓一輪驗證白跑。

三條規矩:

- **先接住再處理。** `cmd; rc=$?` 寫在下一行,不要讓 `$( )`、管線或 `printf` 的參數
  求值插在中間。
- **要測的東西不要在看過之前就丟給計數器。** 先讓輸出出現,再數它。
- **clone 出去驗證之前,確認 HEAD 真的有你要驗的東西。** 未 commit 的改動不會被
  `git clone` 帶走,而症狀是「新版沒生效」——結論會整個反過來。這個坑咬過兩次。

報數字的時候**把量的範圍寫出來**(排除了什麼、在哪個 ref 上)。同一句「有幾行」,
排除 `.md` 之前與之後差了七倍,而兩個人各自報一個數字卻沒說範圍時,爭的會是錯的東西。

## 6. 交辦給別的 session

兩條通道,各答一個問題:

| 工具 | 回答的問題 | 用在 |
|---|---|---|
| `ListAgents` / `SendMessage` | **誰現在活著、能立刻處理** | 來回討論 |
| `list_sessions` / `send_message` | **這台機器上有哪些 session** | 對方沒在跑時交辦 |

**交辦前先跑一次 `ListAgents` 拿當下的名字。** peer name 是「這一輪的把手」,
session 重啟就換一個 —— 沿用上一輪的名字會得到 `No agent named ... is reachable`,
而那不代表對方不在。跨輪穩定的是 `list_sessions` 給的 `sessionId`(`local_…`)。

對方沒在跑時用 `send_message` 帶 sessionId 直送,訊息會排隊等它被喚醒。

**列表裡沒有 ≠ 不存在。** 實測(同一台機器、同一個時間點):停著的 session 在
`list_sessions` 一直看得到(`isRunning: false`),在 `ListAgents` 裡可能以
`offline` 出現、也可能整列不見。

只查一條通道就下結論「那個 session 沒了」,是把**工具的視野**當成事實本身 ——
跟上一節那三個探針同一個形狀,差別只在這次咬到的不是數字,是「有沒有這個東西」。

## 7. CI 紅燈

先看是哪個 job:

| Job | 常見原因 | 做法 |
|---|---|---|
| `scope` | 沒掛 label / 掛了多個 / 路徑越界 | 補上正確 label;越界就回到第 2 步開 CR |
| `verify` → Contract drift | 改了 `contract/` 沒重新生成 | `pnpm gen:types` 後 commit |
| `verify` → CR consistency | CR 狀態與 `tasks.yaml` 對不上 | 修 CR 或請 architect 裁決 |
| `verify` → Typecheck / E2E | 實作問題 | 修實作。**不准改 `e2e/`** 讓測試變綠 |

`e2e/` 只有 qa 能改。測試不過就是不過。
