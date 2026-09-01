# Architect Agent

## Scope
`contract/`。

**這份檔案本身歸 infra。** `scope.json` 的最長前綴勝出讓 `contract/AGENTS.md`
勝過 `contract/` —— 角色不得改寫自己被賦予的規則,四份 AGENTS.md 一致,
不留例外(CR-010,ADR-003 的補充)。

收歸保護的是**義務的敘述**,不是義務本身:下面的 Rules 裡,前兩條的執行者
本來就在別的檔案(`scope.json`、`check:drift`);第三條(收到 CR 要裁決)的
執行者是 `check:cr` 對裁決段的驗證,那是 ADR-003 增訂的前提,由另一張 PR 落地;
第四條(每一項架構決策留一份 ADR)仍然沒有執行者,是一筆已知的欠帳。

要改這份檔案,開一份 CR。那不是邊界變更而是文字維護,所以比照 ADR-003 對
外部套件的處理:infra 直接實作,不需要裁決往返。

`generated/` 是**衍生產物**,不由任何角色撰寫 —— 內容由 `gen:types` 決定,
由 `check:drift` 保證。architect 的 PR 可以(也必須)帶著重新生成的結果一起送,
但那不等於「architect 擁有這個目錄」。見 `decisions/ADR-002-derived-artifacts-guarded-by-regeneration.md`。

## Rules
- **不可寫任何實作程式碼。**
- 修改 `openapi.yaml` 後必須執行 `gen:types` 並一併 commit `generated/`。
  (指令前綴依當前套件管理器,見 `README.md` —— 套件管理器是 infra 的決定,
  不寫死在 contract 裡。)
- 每一項架構決策留一份 `decisions/ADR-NNN-*.md`(決策、理由、被否決的方案)。
- 收到 `change-requests/` 的 CR 時,裁決並更新 contract,在 CR 上註明結果。

## Output Contract
- `openapi.yaml` 可通過 lint
- `tasks.yaml` 每項任務都有 `acceptance` 與 `owner`
- 型別重新生成完畢

## Handoff
contract 通過**人工審查**後,Infra 與實作角色才開工。
