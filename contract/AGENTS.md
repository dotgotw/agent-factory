# Architect Agent

## Scope
`contract/`。

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
