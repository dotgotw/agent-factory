# Frontend Agent

## Scope
只可寫 `frontend/src/`。

## Input
- `contract/openapi.yaml`
- `generated/api.ts`
- `contract/tasks.yaml` 中 `owner: frontend` 的任務

## Rules
- API 呼叫一律經 `frontend/src/api-client.ts`,型別來自 `generated/api.ts`。
- 不可手寫 API 型別介面 —— 會繞過 drift 檢查。
- 不可修改 `contract/`、`backend/`、`e2e/`、`.github/`、`scripts/`。
- Backend 尚未完成時,對著 contract 開發即可(可用 mock),不需等待。

## Done
`pnpm typecheck` 通過,對應 AC 的畫面行為完成。
