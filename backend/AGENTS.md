# Backend Agent

## Scope
只可寫 `backend/src/`。

## Input
- `contract/openapi.yaml`(唯一 API 真相)
- `generated/api.ts`(由上者生成的型別)
- 你的任務:`pnpm tasks --owner backend --status open`(還沒做完的)、
  `pnpm task TASK-0NN`(單一任務的完整內容)。狀態是**算出來的**:每條 AC
  都有證據就是 done,有 proposed 的 CR 指名它就是 blocked,其餘是
  `open (2/3 AC)`。見 ADR-007。
  **不要整支讀 `contract/tasks.yaml`** —— 你需要的是其中一列,讀整支要付全部的
  token。見 `contract/decisions/ADR-005-tasks-are-queried-not-read.md`。

## Rules
- 所有 request / response 型別**必須**從 `generated/api.ts` import,不可手寫介面。
- 不可修改 `contract/`、`frontend/`、`e2e/`、`.github/`、`scripts/`。
- 發現 contract 有問題時**不要自己改**,在 `change-requests/` 開 CR 並停下該任務。

## 發現坑怎麼辦

**先問:下一個人會不會在同樣的地方再踩一次?**
不會 → 寫進 PR 描述,結束。一次性的事建檔只會稀釋真正該讀的東西。

會 → 再問「他再踩的時候,眼睛在看什麼」,答案就是家:

| 他正在做什麼 | 家 |
|---|---|
| 改 `backend/src/` 的那段程式 | 那一行 / 那個函式的註解 |
| 開工的第一分鐘 | 這份 `AGENTS.md` |
| 修不掉,要別人動手(contract 錯了、e2e 有坑) | CR |

**踩到的地方不在你的 scope 裡 → 開 CR。** 不要只傳訊息給對方:訊息不在 repo 裡,
對方的 session 一壓縮就沒了。**訊息可以通知,不能保存。**

第一個實例就地留註解,而且指名下一個會踩的人:

```
// 坑(下一個踩的人:qa):e2e 的 port 寫死,兩個 session 同時跑會互撞
```

`pnpm role` 會在那個角色開場時提醒他(`pnpm role --pits` 看內容)。
完整的表與理由見 `contract/decisions/ADR-009-where-knowledge-lives.md`。

## Done
`pnpm verify` 全綠,且負責任務的 AC 對應 e2e 測試通過。
