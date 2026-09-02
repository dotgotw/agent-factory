# AGENTS.md

本檔是**目錄**,不是知識庫。細節在各自的檔案裡,別往這裡塞。

## 唯一真相

| 主題 | 位置 |
|---|---|
| API | `contract/openapi.yaml` |
| 任務與依賴 | `contract/tasks.yaml` |
| 架構決策 | `contract/decisions/ADR-*.md` |
| 共用型別 | `generated/api.ts`(自動生成,勿手改) |

## 鐵則

1. **`generated/` 不可手動編輯。** 改 `contract/openapi.yaml`,然後 `pnpm gen:types`。
2. **只有 Architect 能改 `contract/`。** 其他角色如需變更,在 `change-requests/` 開 CR。
3. **實作角色不可改 `e2e/`。** 測試不過就是不過,不能把測試改綠。
4. **實作角色不可改 `.github/` 與 `scripts/`。** 規則的執行者不受被約束者修改。
5. **角色不得寫入宣告自己邊界的檔案。** `AGENTS.md`、`tsconfig.json`、
   `package.json` 說的是「這個角色被什麼約束、能 import 什麼」,一律歸 infra
   —— 把鎖裝上,鑰匙不能留在被鎖的人口袋裡。見 ADR-003。
6. 送出前必須 `pnpm verify` 全綠 —— 但**幽靈依賴那半邊的權威在 CI,不在本機**。
   模組解析會沿目錄樹往上走,所以在巢狀 worktree(`.claude/worktrees/<role>`)
   裡,`check:boundaries` 會把「應該解析不到」的案例降級成 ⚠️ 並通過。
   那代表「這裡問不出答案」,不代表答案是好的。路徑逃逸那半邊(`rootDir`)
   與 `node_modules` 無關,本機一樣有效。見 ADR-003 的 #46 補充。
   **看到 ⚠️ 不可放寬 fixture** —— 那是把鎖拆掉,不是修檢查。

## 角色與可寫路徑

見 `scripts/scope.json`。CI 會強制執行,違反會擋 PR。

**一個檔案只有一個擁有者。** 比對規則是最長前綴勝出:infra 明列的
`e2e/tsconfig.json` 勝過 qa 的 `e2e/`,所以那個檔案歸 infra,qa 寫不到。
帶結尾斜線的條目是目錄前綴,不帶的是精確檔名。

`change-requests/` 與衍生路徑是**加法**,不參與長度比較。前者是所有角色被
擋下時的出口,後者的把關者是重新生成(見下)—— 讓它們參賽會把出口關掉。

不確定某個檔案歸誰,`pnpm role` 會把落在你目錄底下、但歸別人的例外列出來。

<!-- AGENT-FACTORY:START -->
| 角色 | 可寫路徑 | 說明 |
|---|---|---|
| architect | `contract/` | 唯一能改 API contract 與 DB migration 的角色。contract/AGENTS.md 歸 infra —— 角色不得改寫自己被賦予的規則,四份 AGENTS.md 一致(CR-010) |
| infra | `.github/`、`.claude/`、`scripts/`、`CLAUDE.md`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`tsconfig.json`、`backend/tsconfig.json`、`frontend/tsconfig.json`、`e2e/tsconfig.json`、`backend/package.json`、`frontend/package.json`、`e2e/package.json`、`Dockerfile`、`docker-compose.yml`、`.env.example`、`.gitignore`、`.gitattributes`、`README.md`、`AGENTS.md`、`backend/AGENTS.md`、`frontend/AGENTS.md`、`e2e/AGENTS.md`、`contract/AGENTS.md`、`infra/` | 規則的執行者。實作角色不得改動 CI,否則測試紅了可以直接把檢查拿掉。同理,一個角色不得寫入「宣告該角色能 import 什麼、被什麼約束」的檔案 —— AGENTS.md、tsconfig.json、package.json 皆屬此類,見 ADR-003。 |
| backend | `backend/src/` | 不得改 contract、frontend、e2e |
| frontend | `frontend/src/` | 不得改 contract、backend、e2e |
| qa | `e2e/` | 只讀驗收條件與 contract,不讀實作。e2e/ 底下宣告邊界的檔案(tsconfig.json、package.json、AGENTS.md)歸 infra |

所有角色皆可寫 `change-requests/`。

### 衍生路徑

不屬於任何角色 —— 它們是生成器的輸出,不是誰的財產。

| 衍生路徑 | 可夾帶的角色 | 生成自 | 內容把關 |
|---|---|---|---|
| `generated/` | architect、infra | `contract/openapi.yaml`、`scripts/gen-types.sh`、`package.json`、`pnpm-lock.yaml` | `check:drift` |

「可夾帶」不等於擁有:那些角色的 PR 可以帶著重新生成的結果一起送,
但檔案內容不由 scope 決定,由「內容把關」那一欄的檢查重新生成後比對。
見 `contract/decisions/ADR-002-derived-artifacts-guarded-by-regeneration.md`。
<!-- AGENT-FACTORY:END -->

## 本 session 是哪個角色

```bash
pnpm role
```

**不叫 `whoami`。** 那是 pnpm/npm 的內建子指令,會優先於 package.json 的同名
script:`pnpm whoami` 不會跑到這裡,而是去查 registry 的登入狀態,吐一則跟角色
毫無關係的 `ENEEDAUTH`。script 撞到內建指令,錯誤訊息就會騙人 —— 別改回去。

角色的來源有兩個,`AGENT_ROLE` 環境變數優先於 `.claude/role` 檔案(不進版控)。
沒有角色就別動手。

**用環境變數指派,不要讓 session 自己寫檔案。** 兩者的差別不在方便,在誰說了算:

| 方式 | 指派者 | 強度 |
|---|---|---|
| 雲端:每個角色一個環境,環境變數設 `AGENT_ROLE` | 開對話的人選環境 | agent 改不到環境設定 |
| 本機:`AGENT_ROLE=qa claude` | 啟動指令 | agent 改不到自己行程的環境 |
| `echo qa > .claude/role` | session 自己 | agent 隨時可以改成別的角色 |

前兩者的環境變數在 Claude Code 這個行程啟動時就固定了,hook 是它啟動的子行程,
繼承的是同一份環境 —— agent 在 Bash 裡 `export AGENT_ROLE=infra` 影響不到 hook。
第三種是方便的臨時做法,但角色變成 agent 的自我宣告,擋不住想繞的 session。

本機要同時開多個角色,用 `git worktree` 一個角色一個目錄最乾淨:各自有自己的
`.claude/role`,天然隔離。不要把 `export AGENT_ROLE=...` 寫進 shell profile ——
它會跟著你到每一個專案。

越界的寫入會被 `.claude/hooks/scope-guard.mjs` 當場擋下 —— 那是提醒,不是邊界;
邊界是 CI 的 `check:scope` 與 `.github/CODEOWNERS` 要求的人類 review。

角色也不只是路徑權限。qa 的註解寫「不讀實作」,而 hook 只擋得住寫入、擋不住閱讀
—— 已經讀過實作的 session,改一行角色設定不會把那些知識清掉。換角色請換 session。

## 指令

**任務資料用查詢的,不要整支讀 `contract/tasks.yaml`** —— 一個角色需要的是其中
一列,讀整支要付全部的 token(ADR-005)。這與 `scope.json` 從來不必被讀是同一招。

```bash
pnpm role          # 我是誰、我能寫哪裡
pnpm task TASK-042 # 一個任務的完整內容
pnpm tasks --owner backend --status open   # 條件查詢;--ac AC-017 反查
                   # 狀態是算出來的:done / blocked / open (n/m AC),見 ADR-007
pnpm gen:types     # contract -> 型別
pnpm typecheck     # 三個 scope 各自 typecheck
pnpm test:e2e      # 黑箱驗收測試
pnpm verify        # 上面全部 + drift 檢查
pnpm check:scope <role> <base-ref>
```
