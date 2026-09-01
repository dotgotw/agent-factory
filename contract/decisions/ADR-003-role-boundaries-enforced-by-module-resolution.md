# ADR-003: 角色邊界由「模組解析 + rootDir」執行,不由文件請求

- **狀態**: accepted
- **日期**: 2026-09-01
- **來源**: CR-009(infra 提出的 workspaces 切分)
- **前置**: ADR-002 已 accepted 並實作完成(`_derived` 機制、`gen-types.sh` 的
  `rm -rf generated`)

## 脈絡

這個 repo 的主張是「規則的真相在 repo 裡,由 CI 執行」。**路徑邊界做到了,
依賴邊界沒有。**

`e2e/AGENTS.md` 寫著「不可 import 任何實作模組」。`scope-guard` 與
`check:scope` 只看**寫入路徑**,`tsc` 不管誰 import 誰。實測(現行設定,
`e2e/` 放一個 `import { app } from '../backend/src/index.js'`):

| 組別 | 設定 | 違規的相對 import | contract 型別 |
|---|---|---|---|
| A | 現行 | ✅ **exit 0 —— 編譯通過** | ✅ 過 |
| B | 只加 `rootDir: "."` | ❌ TS6059 | ❌ **合法的 `../generated/api.ts` 也被擋** |
| C | `rootDir` + contract 走 package | ❌ TS6059 | ✅ 過 |
| D | 同 C,移除違規 import | — | ✅ 全綠(typecheck 與 14/14 e2e) |

同一個洞的另一半是幽靈依賴:`express` 掛在 root,所以 `frontend/src/` 現在
import 得到它。frontend 不該碰的東西,只是「沒人這樣寫」,不是「寫不出來」。

## 決策

**依賴邊界改由兩個機制共同執行,兩者缺一不可:**

| 漏洞 | 例子 | 執行者 |
|---|---|---|
| 幽靈依賴(bare specifier) | frontend 解析得到 `express` | **pnpm workspaces + 各 package 自己的 manifest** |
| 相對路徑逃逸 | `../backend/src/index.js` | **各 tsconfig 的 `rootDir`** |

workspaces 管不到相對路徑,`rootDir` 管不到套件解析。單獨做前者,A 組那個
違規 import 照樣過;單獨做後者,B 組連合法的 contract 型別一起擋掉。

`generated/` 成為 workspace package `@af/contract`,其 manifest 由
`gen-types.sh` 產出 —— 一個生成套件的 manifest,內容當然由生成器決定
(ADR-002 的推論,`_derived` 的第二個實例)。

實測 D 組的邊界行為:

```
frontend/src 內 `import express from 'express'`   → TS2307 Cannot find module
e2e 內 `import ... from '../backend/src/index.js'` → TS6059 not under rootDir
e2e 內 `import ... from '@af/backend'`             → TS2307 Cannot find module
```

### 前提條件一:沒有角色可以寫「宣告自己邊界」的檔案

`rootDir` 寫在 `e2e/tsconfig.json`,而 **qa 今天就寫得到那個檔案** ——
`scope.json` 的比對是 `rel.startsWith(prefix)`,沒有優先順序,qa 的 `e2e/`
與 infra 明列的 `e2e/tsconfig.json` 同時命中,兩者皆過。`.github/CODEOWNERS`
沒有涵蓋 `/e2e/`。

於是本 ADR 若照原案落地,結果是:**把鎖裝上,鑰匙留在被鎖的人口袋裡。**
一張 `agent:qa` 的單檔 PR 刪掉 `rootDir`,CI 全綠(A 組),邊界消失。

同一個形狀出現三次:`e2e/AGENTS.md`(qa 擁有自己被賦予的規則)、
`e2e/tsconfig.json`、以及原案要新建的 `e2e/package.json`。

所以本決策包含一條不變式:

> **一個角色不得寫入「宣告該角色能 import 什麼、被什麼約束」的檔案。**
> 這是 AGENTS.md「角色不得改寫自己被賦予的規則」與鐵則 4 的同一條線,
> 只是延伸到 manifest 與 tsconfig。

推論:`e2e/package.json`、`e2e/tsconfig.json`、`e2e/AGENTS.md`、
`backend/package.json`、`frontend/package.json`、`pnpm-workspace.yaml`
一律歸 infra。**這一步必須先於 `rootDir` 落地**,否則中間存在一個
「邊界已宣告、但可被其目標移除」的視窗。

#### 補充(CR-010,實作第 1 步時發現的第四個實例)

上面列了三個實例,漏了一個:**`contract/AGENTS.md`** —— 它在 architect 自己的
`contract/` 底下,內容正是 architect 的 Rules。裁決是**一併收歸 infra**,
四份 AGENTS.md 一致,不留例外。

但要說清楚它跟 `e2e/AGENTS.md` 的強度不同,否則這條記錄會誇大自己。
`contract/AGENTS.md` 的四條規則裡,兩條的執行者在別的檔案(`scope.json`、
`check:drift`),刪掉句子不會讓 architect 因此寫得到實作程式碼。真正沒有備份的
是另外兩條:「每一項架構決策留一份 ADR」與「收到 CR 時裁決並註明結果」。

那兩條不是邊界,是**義務** —— 邊界可以靠拒絕寫入來執行,義務只能靠檢查產出是否
存在。所以收歸 infra 保護的是**義務的敘述**,不是義務本身。兩者要分開記:

| 義務 | 收歸後的狀態 |
|---|---|
| 收到 CR 時裁決並註明結果 | **改由 `check:cr` 執行**(見下) |
| 每一項架構決策留一份 ADR | 仍然沒有執行者,靠 review |

第二條不假裝有解:「什麼算一項架構決策」沒有機器判準,硬做只會做出一個
可以被形式滿足的檢查。留在這裡,是為了讓它是一筆**已知**的欠帳。

第一條可以做,而且今天是個真的洞。實測(探針 CR,狀態 `accepted`、裁決段
留著範本的 `> 由 Architect 填寫。`):

```
CR-999: accepted
✅ CR 與 tasks.yaml 一致        ← exit 0
```

**一份 CR 可以被標成 accepted 而完全沒有裁決,CI 全綠。** 這與 ADR-002 前提一
(drift 只比對內容、不比對檔案集合)是同一類疏漏:檢查看起來涵蓋了那件事,
實際上只涵蓋它的一半。故本 ADR 增訂一條前提:

> `check:cr` 必須驗證:狀態為 `accepted` 或 `rejected` 的 CR,其「Architect 裁決」
> 段落存在且不只有範本佔位。`proposed` 不受此限。

判準怎麼寫是 infra 的決定,但**別只比對範本那一行字** —— 把那行刪掉、留一個
空段落就會過,洞還在原地。

機制怎麼寫是 infra 的決定。建議在 `roles` 之內採**最長前綴勝出**
(`e2e/tsconfig.json` 的 17 字元勝過 `e2e/` 的 4 字元),它不需要新概念,
而且讓 infra 現有的明列清單真的生效。**陷阱**:`_everyone` 與 `_derived`
是加法,不可參與長度比較 —— 全域最長前綴會讓 `change-requests/` 塌縮成
單一角色,五個角色裡有四個從此開不了 CR。

### 前提條件二:負向案例必須是常設檢查

上面三條 TS 錯誤若只在遷移當天跑過一次,這個邊界的壽命就是一次。必須做成
`verify` 的一部分(對一組刻意違規的 fixture 跑 `tsc --noEmit`,期望它紅)。

這不是「更好的做法」,是決策的一部分,理由是**殘留的洞在 root**:root
`package.json` 裡的任何依賴對每個 package 都解析得到。今天那裡只剩
`typescript`、`tsx`、`js-yaml`、`openapi-typescript`,但沒有任何機制阻止
有人把 `express` 加回 root —— 而那會讓 frontend 那半邊的邊界**靜默**復原成
今天的樣子。常設檢查是唯一會出聲的東西。

這與 ADR-002 前提二是同一個形狀:放寬一處的保證,由另一處的檢查承擔,
那個檢查就必須是 required。

#### 補充(#46 實作後):這個檢查在哪裡問得出答案

`check:boundaries` 的完整性取決於 checkout **有沒有上層 `node_modules`**。
模組解析會沿目錄樹往上走,而本機的角色 worktree 位在
`.claude/worktrees/<role>`,上層就是主 checkout —— 於是「frontend 應該解析不到
`express`」這個問題在那裡問不出答案。三組實測:

| 環境 | 結果 |
|---|---|
| 巢狀 worktree(`.claude/worktrees/architect`),主 checkout 尚未瘦身時 | **2/3**,`express` 解析到主 checkout 的 `node_modules`,降級為 ⚠️ 並 exit 0 |
| 同一個巢狀 worktree,主 checkout 重裝之後 | **3/3** |
| 乾淨複本(不在任何 checkout 底下) | **3/3** |
| CI(`/home/runner/work/...`) | **3/3** |

前兩列是同一個目錄、同一支檢查,差別只在**上層那棵 `node_modules` 裡有什麼**。
#41 把 root 的 `dependencies` 清空、主 checkout 重裝之後,`@types/express` 不再
被 hoist 到上層,洩漏就消失了。

**所以結論不是「巢狀時一定驗不到」,是「巢狀時的答案取決於上層裝了什麼」**
—— 而一個取決於工作區之外、且沒有人在管的變數的答案,本身就不算證據。
今天本機碰巧 3/3 不代表明天還是:上層換個分支、裝個套件,同一支檢查就換一個答案。

所以幽靈依賴那半邊的權威在 CI。**鐵則 5 的「送出前 `pnpm verify` 全綠」對這半邊
不再是充分證據** —— 本機綠只代表「這裡問不出答案」,不代表「答案是好的」。
路徑逃逸那半邊(`rootDir`)與 `node_modules` 無關,本機一樣有效。

降級不會遮住真的破洞,這點實測過:把 `express` 加進 `frontend/package.json`
之後,它解析到 **repo 之內**,檢查照樣 exit 1 並印出解析到哪裡。
⚠️ 與 ❌ 的分界是「解析到 repo 外還是 repo 內」,不是「有沒有錯誤碼」。

要守住的耦合,與 ADR-002 前提二同一個形狀:

> **CI 的 checkout 必須沒有上層 `node_modules`。** 哪天 CI 改成在巢狀目錄下跑,
> 這個檢查會降級成警告並通過 —— 綠燈,但什麼都沒驗到,而且不會有任何一條
> 紅線提醒你。

還有一條不得違反的:**看到 ⚠️ 不可放寬 fixture。** 那是把鎖拆掉,不是修檢查。

偵測手法本身(`--traceResolution` 比對解析位置,而不是複製到 repo 之外再跑)
**不寫進本 ADR** —— 那是工具選型,歸 infra。這裡記的只有「這個保證在哪裡成立」,
因為那會改變讀者對本機綠燈的信任程度。

## 理由

死結不在文件寫得不夠清楚,在**文件是唯一的執行者**。`e2e/AGENTS.md` 那句話
寫得毫不含糊,而它的執行率是零。這個 repo 對別的規則都不接受這種安排
—— 路徑邊界有 `check:scope`,contract 漂移有 `check:drift`,CR 狀態有
`check:cr`。依賴邊界沒有理由是例外。

`e2e/package.json` 的副作用值得單獨說。`e2e/server.ts:126` 用
`spawn(process.execPath, [...])` 把 backend 當**行程**啟動,不是當模組 import
—— 這個黑箱性質目前只活在註解裡。切成 package 之後它是 manifest 裡看得見的
事實:依賴有 `@af/contract`,沒有 backend。**依賴關係從默契變成 diff。**

## 被否決的方案

- **只做 workspaces** — 修得了幽靈依賴,修不了相對路徑。A 組實測為證。
- **只做 `rootDir`** — B 組實測:合法的 `../generated/api.ts` 一起被擋,
  `typecheck` 直接紅。四個現有的跨界 import 全走相對路徑。
- **migration 例外:允許標記為遷移的 PR 掛多個 `agent:*` label,
  由 CODEOWNERS 補足**(CR-009 選項 b)— 否決,理由與 ADR-002 否決
  「無條件寫入權 + CODEOWNERS」相同:CODEOWNERS 在本 repo 只是
  「人類知情地合併」,不是第二雙眼睛。額外的問題是**例外的觸發條件在爆炸半徑內**
  —— 「這是遷移」由送 PR 的 agent 自己宣告,而它正是被約束的那一方。
  例外一旦存在就會被援用,而這個例外恰好解除的是本 repo 唯一的邊界機制。
- **不做,把 `e2e/AGENTS.md` 改成「目前無機制執行,靠 review」**(選項 c)—
  誠實,但誠實得沒有著力點:**那份檔案在 qa 自己的 `e2e/` 底下**,規則於是降級
  成一份「被約束者可以隨時改寫的請求」。若要走這條,還是得先做前提條件一,
  而做完之後 (a) 的剩餘成本只有五張 PR。
- **把 `rootDir` 換成 lint 規則(no-restricted-imports)** — 未採用:多一套
  工具鏈,而且擋不了幽靈依賴那半邊;`rootDir` 是 `tsc` 本來就有的能力,
  零新增依賴。

## 代價

- **這是 typecheck 層的邊界,不是 runtime 邊界。** 實測:非字面量的動態
  `import` 完全繞過 `tsc`(exit 0),而 `tsx` 在 runtime 照樣載入 backend
  並拿到 `app`。要擋住那個需要 runtime 沙箱,與收益不成比例。**記錄它,不追它**
  —— 這條寫在這裡,是為了讓往後的人知道這個邊界的強度到哪裡,不要誤以為它是密封的。
- 依賴的宣告權集中到 infra(見下節),實作角色新增外部套件多一次往返。
- `check:drift` 的 `rm -rf generated` 期間,workspace 的
  `node_modules/@af/contract` 會短暫指向不存在的目錄;生成器失敗時本機的
  `typecheck` 會以「找不到 @af/contract」失敗,而真正的原因在上一步。
  這是 ADR-002 已接受的代價的放大版:再跑一次 `gen:types` 即可。
- 六張 PR、四個角色。**這個數字是這次決策的資料點**:角色制度對橫切式重構的
  成本比日常開發高一個數量級。接受它,是因為替代方案(開例外)拆掉的正是
  制度本身。

## manifest 的所有權:為什麼是 infra

`backend/package.json` 今天不在任何角色的可寫範圍內(infra 的
`"package.json"` 只精確涵蓋 root,backend 的 `"backend/src/"` 不涵蓋它)。

歸 infra,但**理由不是「加依賴值得 review」**,而是:切成 package 之後,
manifest 同時裝了兩種東西 ——

1. **「backend 依賴 express」** —— 實作決定
2. **「backend 可以 import `@af/contract`,不能 import `@af/frontend`」** —— 邊界決定

第 2 種就是本 ADR 要機器化的那條線。讓被約束的角色擁有宣告自己 import 邊界的
檔案,等於把剛裝上的鎖交回去(前提條件一的同一個推論)。

為了不讓這個變成日常開發的稅,**分開處理兩種變更**:

| 變更 | 誰決定 | 流程 |
|---|---|---|
| 新增/升級**外部**套件 | infra | 開一份 CR 說明用途,**infra 直接實作,不需要 architect 裁決** |
| 動到 `workspace:*` 的邊(誰能 import 誰) | architect | CR + 裁決,必要時附 ADR |

依賴圖是邊界語意,套件清單不是。這與 ADR-002 的分界線一致:
**工具選型歸 infra,邊界語意歸 contract。**

## 不在本 ADR 範圍

- **runtime 隔離**。見上。
- **`change-requests/` 的多角色協作機制**。六張 PR 的成本這次照付;若橫切式
  重構變成常態,那是另一份 ADR 該回答的問題,而它必須提出一個
  「不依賴自我宣告」的機制,不是一個 label。
