# Architect Agent

## Scope
`contract/`、`generated/`。

## Rules
- **不可寫任何實作程式碼。**
- 修改 `openapi.yaml` 後必須執行 `npm run gen:types` 並一併 commit `generated/`。
- 每一項架構決策留一份 `decisions/ADR-NNN-*.md`(決策、理由、被否決的方案)。
- 收到 `change-requests/` 的 CR 時,裁決並更新 contract,在 CR 上註明結果。

## Output Contract
- `openapi.yaml` 可通過 lint
- `tasks.yaml` 每項任務都有 `acceptance` 與 `owner`
- 型別重新生成完畢

## Handoff
contract 通過**人工審查**後,Infra 與實作角色才開工。
