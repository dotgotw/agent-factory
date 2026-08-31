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

`npm run check:drift` 重跑生成器並比對 diff。擋掉兩種常見死法:
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
npm install
npm run verify        # drift + typecheck + e2e,全綠才算過
npm run dev:backend   # localhost:3000
```

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
# ...改 code
npm run verify                                          # 全綠才送
gh pr create --label agent:backend                      # label 必須跟資料夾的角色一致
```

**沒有「切到 main 再 pull」這個步驟。** 所有 worktree 共用同一個 `.git`,
`git fetch` 在任何一個資料夾跑一次,全部立刻看得到最新的 main。

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

**3. 被 scope 擋下來時不要繞。** 去 `change-requests/` 開一張 CR 說明你需要什麼,
由 Architect 裁決。這條路徑是整個設計的核心,見下一節。

### 跨角色的改動:拆,但不用排隊

拆成多張 PR 是必要的,但**第二棒不必等第一棒合併**。
把第二張 PR 的目標設成第一張的分支,而不是 main:

```bash
gh pr create --base 第一棒的分支名 --label agent:qa
```

CI 比對邊界時看的是你的目標分支(`.github/workflows/ci.yml` 裡的
`check-scope.mjs "$ROLE" "origin/$base_ref"`),所以兩張 PR 可以疊著跑。
第一張合併後,GitHub 會自動把第二張的目標改成 main。

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
