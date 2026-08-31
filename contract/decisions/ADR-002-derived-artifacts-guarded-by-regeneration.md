# ADR-002: 衍生產物由「重新生成」保證,不由「路徑所有權」保證

- **狀態**: accepted
- **日期**: 2026-08-31
- **來源**: CR-008(infra 提出的 pnpm 遷移撞到這個缺口)

## 脈絡

`scripts/scope.json` 把 `generated/` 列為 architect 的可寫路徑。這句話從一開始
就是半真的:architect 不撰寫 `generated/`,生成器撰寫它。architect 只是恰好
擁有生成器的其中一個輸入(`contract/openapi.yaml`)。

在生成器的輸出從來不需要改變之前,這個半真的說法無害。CR-008 讓它變成死結:

1. 表頭文字的來源是 `scripts/gen-types.sh` —— **infra 的路徑**
2. 改了腳本,`generated/api.ts` 就會變 —— **architect 的路徑**
3. `check:drift` 要求兩者同時 commit
4. CI 的 `scope` job 要求**恰好一個** `agent:*` label

於是任何改變生成器輸出的變更,都塞不進單一角色的 PR。

**這不是 pnpm 特有的,也不限於表頭文字。** 最常見的實例是升 `openapi-typescript`
的版本 —— `package.json`(infra)一動,`generated/api.ts`(architect)就跟著變。
那是遲早會發生、而且會反覆發生的例行維護。

## 決策

`generated/` 從 architect 的 `allow` 移出,改列為**衍生路徑**(`_derived`):

- **沒有任何角色「擁有」它。** `check:scope` 回答的是「誰有資格撰寫這個檔案」,
  對衍生檔案,正確答案是「沒有人」。
- **內容的唯一權威是 `check:drift`**(重新生成後比對),不是 `check:scope`。
- `check:scope` 只決定**誰的 PR 可以帶著它一起送**,名單由規則推導:
  **生成器輸入的擁有者**。以 `generated/` 為例,輸入是 `contract/openapi.yaml`
  (architect)與 `scripts/gen-types.sh` + `package.json`(infra),
  故 writers 為 `architect`、`infra`。

往後新增任何 codegen,分類方式是照這條規則推,不是再開一個例外。

### 兩個前提條件

這個決策的安全性建立在 `check:drift` 真的是 `generated/` 的完整權威。
今天不是,所以以下兩點是決策的一部分,不是附註:

1. **`check:drift` 必須比對檔案集合,不只比對檔案內容。** 現行的
   `git diff --exit-code generated/` 只看得到生成器會覆寫的那個檔案 ——
   實測把 `generated/zz-probe.ts` commit 進去,`check:drift` 綠燈通過。
   生成前先清空目錄即可修復(同一個探針在該路徑下 exit=1)。
2. **`verify` 與 `scope` 兩個 job 必須都是 required check。** 放寬 scope 之後,
   `generated/` 的保證改由另一個 job 提供;哪天 `verify` 不再 required,
   這個放寬會**靜默**變成漏洞。這個耦合關係必須留在記錄裡。

## 理由

死結的根因不是 label 規則太嚴,而是 `scope.json` 描述錯了一件事的性質:
把「函數的輸出」寫成「某人的財產」。用例外去繞開一個描述錯誤,會留下一個
需要被記住的特例;把描述改對,規則自己就通了。

副作用同樣重要:`generated/` 的守衛從「相信 PR label 宣告的角色」換成
「重新跑一次生成器」。後者不依賴任何人的宣告為真 —— 而 `.github/CODEOWNERS`
自己承認,在只有一個協作者的現況下,它擋不住「agent 自稱 infra」。

## 被否決的方案

- **表頭文字不動(CR-008 選項 b)** — 零成本,但只是這一次不觸發死結。
  下次升版照樣撞,而且留下一句錯的文件,正好是 `check:drift` 要消滅的漂移。
- **拆成兩張 PR(選項 a)** — 中間狀態必然有一次 `check:drift` 紅燈,
  等於承認 main 可以短暫是紅的。這個 repo 的整套設計就是為了讓紅燈有意義。
- **把表頭抽成 `contract/` 底下的資料(選項 d)** — 決定性的問題不是成本,
  是它修不了同一個死結最常見的實例:升 `openapi-typescript` 版本跟表頭文字
  一個字都沒關係,照樣撞。它只修了這次撞到的那一行。
- **給 infra 對 `generated/` 的無條件寫入權 + CODEOWNERS 補足(選項 c 的原話)** —
  方向對,但把「沒有人擁有它」寫成「多一個人擁有它」,並把安全性押在
  CODEOWNERS 上。CODEOWNERS 在本 repo 只是「人類知情地合併」,不是第二雙眼睛。

## 代價

- `check:scope` 對 `generated/` 的把關變弱,改由 `check:drift` 承擔。兩個檢查
  分屬不同 job,保證只在「兩者皆 required」時成立(見前提 2)。
- `scope.json` 多一個概念(`_derived`),`role.mjs`、`check-scope.mjs`、
  `sync-agents.mjs`、`.claude/hooks/scope-guard.mjs` 都要認得它。
- `check:drift` 每次會重新生成整個目錄而不是覆寫單檔,生成器失敗時本機會
  短暫少掉 `generated/`。可接受 —— 那是衍生目錄,再跑一次就回來。

## 不在本 ADR 範圍

**套件管理器的選擇不是架構決策。** CR-008 問過這件事該不該寫成 ADR:
不該。工具選型歸 infra,把它搬進 `contract/decisions/` 反而讓所有權糊掉。
分界線是:**工具選型歸 infra,邊界語意歸 contract。**

依同一條線,CR-008 提到的後續 workspaces 切分**需要另一份 ADR** ——
它改變的是哪個角色能 import 到什麼,那是邊界語意。
