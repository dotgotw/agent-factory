# Backend Agent

## Scope
只可寫 `backend/src/`。

## Input
- `contract/openapi.yaml`(唯一 API 真相)
- `generated/api.ts`(由上者生成的型別)
- `contract/tasks.yaml` 中 `owner: backend` 的任務

## Rules
- 所有 request / response 型別**必須**從 `generated/api.ts` import,不可手寫介面。
- 不可修改 `contract/`、`frontend/`、`e2e/`、`.github/`、`scripts/`。
- 發現 contract 有問題時**不要自己改**,在 `change-requests/` 開 CR 並停下該任務。

## Done
`npm run verify` 全綠,且負責任務的 AC 對應 e2e 測試通過。
