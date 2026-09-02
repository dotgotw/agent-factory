# ADR-005: 任務資料用查詢的,不整支讀;`tasks.yaml` 只放資料

- **狀態**: accepted
- **日期**: 2026-09-01
- **來源**: 「這支 repo 要當未來專案的骨架」這個前提下,對 `tasks.yaml` 的擴充性檢查

## 脈絡

`contract/tasks.yaml` 現在 11 個任務、15.7KB。實測密度:

```
含註解  1,428 bytes/任務
純資料    519 bytes/任務      ← 64% 的體積是決策散文,不是資料
```

外推(以下 token 數為估算,不是量測):現在整支約 4,000–6,000 token,
**每個任務 400–550 token**。

```
 50 個任務  ≈  20k–28k token
100 個任務  ≈  40k–55k token
```

**一百個任務就吃掉幾萬 token,而一個 agent 需要的只是其中一列。**
(常被提到的 10MB 是 7,300 個任務,那個規模不會發生;真正的門檻早 70 倍。)

而現在的文件正在教 agent 養成整支讀的習慣:

```
backend/AGENTS.md:9   - contract/tasks.yaml 中 owner: backend 的任務
frontend/AGENTS.md:9  - contract/tasks.yaml 中 owner: frontend 的任務
e2e/AGENTS.md:7       - contract/tasks.yaml 的 acceptance 欄位
```

**同一個問題,這個 repo 已經解對過一次。** `scripts/scope.json` 從來不需要
agent 去讀 —— 它有 `pnpm role`,印出的是那個角色要的答案。scope.json 沒有變成
token 問題不是因為它小,是因為沒有人叫 agent 讀它。

## 決策

**兩條,一起才有效:**

### 一、任務資料一律經查詢介面取得,不整支讀

```bash
pnpm task TASK-042                      # 一個任務的完整內容
pnpm tasks --owner backend --status todo   # 該角色待辦
                                           # (ADR-007 之後 todo 併入 open,
                                           #  這行保留原貌作為記錄)
pnpm tasks --ac AC-017                  # 反查某條 AC 屬於誰
```

三份角色 `AGENTS.md` 的 Input 從「讀 `contract/tasks.yaml`」改成跑指令。
形狀照抄 `pnpm role`:**輸出是給那個角色看的答案,不是資料庫傾印。**

`tasks.yaml` 仍然是唯一真相,仍然由 architect 撰寫,仍然由 `check:ac` /
`check:cr` 整支讀 —— **腳本整支讀不花 token,agent 整支讀才花。**

### 二、`tasks.yaml` 只放資料;決策理由住在 CR 或 ADR

任務項目帶一個 `decisions:` 欄位,列出這張任務的理由住在哪:

```yaml
- id: TASK-009
  title: 壞掉的 JSON 也要回 Error schema
  owner: backend
  status: done
  decisions:
    - "contract/decisions/ADR-006-no-silent-acceptance.md"
    - "change-requests/CR-012.md"
```

**沒有家的散文不可以直接刪 —— 要先給它一個家。** 本 ADR 落地時,
TASK-007 到 TASK-011 的註解講的其實是同一條原則被套用了六次,所以先寫了
ADR-006 收容它們,再把註解換成指標。

## 理由

**檔案大小不是問題,取用方式才是。** 拆成 12 支檔改變不了這件事:agent 還是
得先找出 TASK-042 在哪一支,再讀那一支。拆檔買到的是寫入衝突與炸裂半徑,
不是 token。

**骨架真正在定義的是存取模式,不是檔案佈局。** 11 個任務時建立習慣,成本是
幾十行腳本;700 個任務時再改,得先讓五個角色忘掉舊習慣。這是現在做的唯一理由
—— 現在做不是因為現在需要,是因為現在便宜。

第二條的理由是成長率:64% 的體積是散文,而散文本來就有家。它們被寫進
`tasks.yaml` 只是因為當下順手。

## 代價

- 多一支腳本要維護,而且它的輸出格式會變成 agent 依賴的介面 —— 改它等於改
  五個角色讀到的東西。
- `decisions:` 欄位是一個沒有機器保證的指標:路徑相對 repo 根目錄,指到不存在的
  檔案不會有人出聲。
  **可以補一個檢查**(檔案存在即可),不必現在做,但值得記著這是個洞。
- 散文搬走之後,`tasks.yaml` 讀起來會變得乾但不好懂 —— 那正是 `decisions:`
  存在的原因,代價是多跳一次。

## 不在本 ADR 範圍

- **按 phase 拆檔。** 判準是**寫入衝突**(兩個 session 同時要改 tasks),
  不是行數。還沒發生。
- **完成的 phase 歸檔到 `contract/tasks/archive/`。** 等第一個 phase 真的收尾
  再說;腳本照讀,查詢預設不含歸檔。
- **status 改成推導。** `done` 與 `blocked` 其實是算得出來的(`check:ac` 與
  `check:cr` 已經在算),`todo` / `in_progress` / `review` 才是宣告。那是另一份
  ADR,而且要先回答「意圖狀態放哪裡」—— 它的動機是 85 張合併 PR 裡有 9 張
  內容只有 `tasks.yaml` 的狀態欄位。
- **`openapi.yaml` 的拆分。** 實作角色 import 的是 `generated/api.ts`,不讀
  YAML;整支讀的只有 architect。`$ref` 拆檔是排版,不是機制,長到讀不動再拆。
