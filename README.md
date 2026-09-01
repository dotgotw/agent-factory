# Agent Software Factory — 骨架 MVP

演示三個讓 Agent 分工真的成立的機制,功能只是用來證明機制有效的最小載體。

## 三個機制

### ① Contract 是可執行的,不是文件

`contract/openapi.yaml` → `generated/api.ts` → 前後端與測試全部 import 它。

驗證過:把 `Project.name` 改成 `title` 之後 ——

```
backend:  5 個型別錯誤
frontend: 2 個型別錯誤
e2e:      2 個型別錯誤
```

一次 contract 變更的波及範圍在幾秒內全部現形。用 markdown 寫規格做不到這件事。

### ② Drift 會讓 CI 失敗

`pnpm check:drift` 重跑生成器並比對 diff。擋掉兩種常見死法:
手改 `generated/`,以及改了 contract 卻忘記重新生成。

驗證過:改 contract 未重新生成 → 離開碼 1。

### ③ 邊界用機制擋,不用 prompt 擋

`scripts/scope.json` 定義每個角色可寫的路徑,CI 強制執行。

驗證過:模擬 Backend Agent 把失敗的斷言放寬、順手把 CI 檢查註解掉 ——

```
❌ 越界 2 個檔案:
   - .github/workflows/ci.yml
   - e2e/projects.spec.ts
```

這兩招是 Agent 遇到紅燈時最省事的走法,而且它會這麼做:它的目標函數是
「讓 CI 變綠」,關掉檢查完全符合這個目標。所以 CI 設定檔必須由不受 CI
約束的角色持有。

## 目錄

```
contract/          Architect 專屬。API、任務、ADR
generated/         自動生成,勿手改
backend/src/       Backend Agent
frontend/src/      Frontend Agent
e2e/               QA Agent。不讀實作,只讀驗收條件
scripts/           Infra Agent。生成器 + 邊界檢查
.github/workflows/ Infra Agent。規則的執行者
change-requests/   所有角色皆可寫。contract 的唯一修改入口
```

## 跑起來

```bash
corepack enable       # 一次就好,讓 Node 依 packageManager 欄位自動備妥 pnpm
pnpm install
pnpm verify           # drift + typecheck + e2e,全綠才算過
pnpm dev:backend      # localhost:3000
```

**沒裝 pnpm 會怎樣。** `package.json` 的 `packageManager` 欄位釘死 pnpm 版本,
`corepack enable` 之後 Node 會自己備妥它。若跳過這一步,症狀是
`.claude/hooks/session-start.sh` 在**每次開 session 時**靜默失敗 ——
看起來像 Claude Code 壞了,實際上只是 pnpm 沒就位。

遇到的時候修 corepack,**不要去關掉 hook**。

## 怎麼在這裡工作

這一節是給人看的操作手冊。**規則本身不在這裡** —— 誰能寫哪些路徑,
唯一真相是 `scripts/scope.json`(機器讀)與 `AGENTS.md`(人讀)。
這裡只講「每天實際要打什麼」。

### 一句話原則

**資料夾 = 你是誰,分支 = 你在做什麼。**

角色綁在資料夾上,不是綁在分支上 —— 因為角色來自資料夾裡的 `.claude/role`,
而那個檔案在 `.gitignore` 裡,不會跟著分支跑。

所以:**worktree 用角色命名,不要用任務命名。** 一個角色一個資料夾,
建好就不刪;任務來來去去的是分支。

### 一次性設定(每台機器做一次)

```bash
git worktree add .claude/worktrees/backend -b role/backend origin/main
echo backend > .claude/worktrees/backend/.claude/role
```

五個角色各做一次(`architect`、`infra`、`backend`、`frontend`、`qa`)。
設完就不再碰。

雲端環境或 CI 用環境變數 `AGENT_ROLE` 指派,那比檔案強 —— 差別見 `AGENTS.md`。

### 每天

```bash
cd .claude/worktrees/backend                            # ← 這一步就是「指派角色」
git fetch origin && git checkout -b 我的分支 origin/main   # 從最新的 main 長出來
pnpm install                                            # 見下:node_modules 不進版控
# ...改 code
pnpm verify                                             # 全綠才送
gh pr create --label agent:backend                      # label 必須跟資料夾的角色一致
```

**沒有「切到 main 再 pull」這個步驟。** 所有 worktree 共用同一個 `.git`,
`git fetch` 在任何一個資料夾跑一次,全部立刻看得到最新的 main。

**每個 checkout 都要自己 `pnpm install`。** `node_modules/` 不進版控,而
`git pull` 只會把 `pnpm-workspace.yaml` 與各 package 的 `package.json` 拉下來,
不會幫你建連結。少了這一步的症狀是 tsc 說

```
Cannot find module '@af/contract'
```

—— 那句話看起來像 workspace 設定壞了,實際上設定沒問題,只是這個目錄沒裝過。
主 checkout 特別容易中:平常不在那裡開發,拉完就直接跑指令。

### 三條一定會撞到的規矩

**1. 角色的 worktree 不要切到 `main`。** 同一個分支不能被兩個 worktree 同時打開,
主目錄已經佔著 `main`,你會看到:

```
fatal: 'main' is already used by worktree at ...
```

這是保護不是故障。永遠用 `origin/main`(遠端的唯讀快照)當起點就不會遇到。

**2. 一張 PR 只能掛一個 `agent:*` label。** 因為 CI 要檢查「你改的檔案有沒有
超出你的權限」,一張 PR 同時宣稱是兩個角色,等於沒有權限這回事。
跨角色的改動必須拆成多張 PR。

**4. worktree 在 repo 底下,所以它看得到主 checkout 的 `node_modules`。**
Node 與 TypeScript 解析模組時會一路往上層目錄找 `node_modules`,而
`.claude/worktrees/<role>` 的上層正是主 checkout。

後果是:**「這個 package 不該解析得到某個套件」這類負向檢查,在 worktree 裡
跑可能是假綠** —— 套件從主 checkout 漏了進來。實測過:`frontend/src` 裡放一個
`import express from 'express'`,在 worktree 裡 typecheck 通過,在乾淨的複本裡
是 `TS2307 Cannot find module 'express'`。

CI 是乾淨 checkout,沒有這個上游,所以**這件事的權威是 CI**。要在本機重現
CI 的答案,把工作區複製到 repo 樹之外再跑:

```bash
tar --exclude=node_modules --exclude=.git -cf - . | (mkdir -p /tmp/cleanroom && cd /tmp/cleanroom && tar xf -)
cd /tmp/cleanroom && pnpm install --frozen-lockfile && pnpm verify
```

正向的檢查(typecheck、e2e、drift、scope)不受影響 —— 多看得到一些東西不會讓
它們變綠。只有「應該解析不到」這一類會。

**3. 被 scope 擋下來時不要繞。** 去 `change-requests/` 開一張 CR 說明你需要什麼,
由 Architect 裁決。這條路徑是整個設計的核心,見下一節。

### 人工驗收怎麼做

`contract/tasks.yaml` 裡標 `verified_by: manual` 的 AC,意思是**由人看過**,
不是「不必驗收」。今天只有 TASK-003 的 AC-005/AC-006 是這一類。

```bash
pnpm dev:frontend
```

它會編譯 frontend、把 backend 起在另一個 port、開一個同源的頁面把兩者接起來。
自己挑空的 port,不跟任何服務搶。

- **AC-006(無資料時顯示空狀態)** —— 剛啟動時 backend 是空的(in-memory),
  打開就是這個狀態。
- **AC-005(顯示名稱、狀態、建立日期)** —— 用畫面上的表單建一筆,看列表那一列。

看完之後**留下紀錄**(誰、什麼時候、看到什麼),再請 architect 把 TASK-003
從 `review` 改成 `done`。紀錄要放哪目前沒有欄位,見 `change-requests/`。

這支是驗收用的 harness,不是產品:HTML 在腳本裡,`frontend/src/` 沒有被改動。

### 跨角色的改動:拆,但不用排隊

拆成多張 PR 是必要的,但**第二棒不必等第一棒合併**。
把第二張 PR 的目標設成第一張的分支,而不是 main:

```bash
gh pr create --base 第一棒的分支名 --label agent:qa
```

CI 比對邊界時看的是你的目標分支(`.github/workflows/ci.yml` 裡的
`check-scope.mjs "$ROLE" "origin/$base_ref"`),所以兩張 PR 可以疊著跑。

**合併時有一個會咬人的地方:由下往上合,而且合完第一張要先確認第二張的
base 真的變成 main,再按下去。**

第一張合併後 GitHub 會自動把第二張的目標改成 main,但那需要幾秒。
在它改完之前按下合併,第二張會併進一個**已經沒人要的分支** ——
GitHub 顯示「已合併」,CI 也是綠的,但改動根本沒進 main。

真的發生過:#28 在 17:02:35 併進 main,#29 在 43 秒後併進了
`claude/pnpm-scope-lockfile`,整個 pnpm 遷移就這樣卡在半路。

合完之後養成習慣檢查一次:

```bash
git fetch origin && git log --oneline origin/main -3
```

看不到你的 commit 就是沒進去。補救方式是從 `origin/main` 開一個新分支、
`git cherry-pick` 那個 commit,再開一張以 main 為目標的 PR。

## 一個刻意留下的狀態

`contract/tasks.yaml` 的 TASK-004 是 `blocked`,對應
`change-requests/CR-001.md`:Backend Agent 發現要做封存功能,但 contract
沒有能改 status 的端點。

它沒有自己加端點,也沒有硬幹一個隱藏 API,而是停下來開 CR。

這條路徑不打通,Agent 只剩兩種行為:做出爛實作,或偷改 contract。這是整個
設計裡最容易被忽略、但最常決定成敗的一環。

## 這個骨架**還沒有**的東西

誠實列一下,免得你以為可以直接上生產:

- 沒有資料庫(記憶體 Map),沒有 migration
- 沒有認證授權,沒有多租戶隔離
- 沒有前端建置(Vite/框架)與畫面
- 沒有真的部署(Dockerfile、staging)
- 沒有 lint、依賴掃描、secret 掃描

這些都是 Infra Agent 的工作,而且大多可以模板化 —— 第二個客戶時 80% 直接複製。

先把上面三個機制跑順,再補這些。反過來做的話,你會有一套很完整的基礎建設,
在保護一個沒有約束力的 contract。
