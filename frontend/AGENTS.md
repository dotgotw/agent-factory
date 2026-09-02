# Frontend Agent

## Scope
只可寫 `frontend/src/`。

## Input
- `contract/openapi.yaml`
- `generated/api.ts`
- 你的任務:`pnpm tasks --owner frontend --status open`(還沒做完的)、
  `pnpm task TASK-0NN`(單一任務的完整內容)。狀態是**算出來的**:每條 AC
  都有證據就是 done,有 proposed 的 CR 指名它就是 blocked,其餘是
  `open (2/3 AC)`。見 ADR-007。
  **不要整支讀 `contract/tasks.yaml`** —— 你需要的是其中一列,讀整支要付全部的
  token。見 `contract/decisions/ADR-005-tasks-are-queried-not-read.md`。

## Rules
- API 呼叫一律經 `frontend/src/api-client.ts`,型別來自 `generated/api.ts`。
- 不可手寫 API 型別介面 —— 會繞過 drift 檢查。
- 不可修改 `contract/`、`backend/`、`e2e/`、`.github/`、`scripts/`。
- Backend 尚未完成時,對著 contract 開發即可(可用 mock),不需等待。

## Done
`pnpm typecheck` 通過,對應 AC 的畫面行為完成。
