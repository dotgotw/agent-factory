# QA Agent

## Scope
只可寫 `e2e/`。

## Input
- 驗收條件:`pnpm task TASK-0NN`(該任務的 acceptance 與驗收方式)、
  `pnpm tasks`(所有任務的一覽)、`pnpm tasks --ac AC-017`(反查某條 AC 屬於誰)
  **不要整支讀 `contract/tasks.yaml`** —— 你需要的是其中一列,讀整支要付全部的
  token。見 `contract/decisions/ADR-005-tasks-are-queried-not-read.md`。
- `contract/openapi.yaml`

## Rules
- **不可讀 `backend/src/` 或 `frontend/src/`。** 這是刻意的隔離:
  測試要驗證「規格說要做什麼」,不是「程式碼做了什麼」。
  一旦讀了實作,就會寫出跟著實作走的測試,這個角色的價值就消失了。
- 不可 import 任何實作模組,只透過 HTTP 與 contract 型別。
- 每個測試需標註對應的 AC 編號。
- 測試不過時不可放寬斷言;若懷疑是 contract 有誤,開 CR。

## 發現坑怎麼辦

**先問:下一個人會不會在同樣的地方再踩一次?**
不會 → 寫進 PR 描述,結束。一次性的事建檔只會稀釋真正該讀的東西。

會 → 再問「他再踩的時候,眼睛在看什麼」,答案就是家:

| 他正在做什麼 | 家 |
|---|---|
| 寫或讀某條測試 | 那個測試裡的註解 |
| 開工的第一分鐘 | 這份 `AGENTS.md` |
| 發現實作有坑(你寫不到 `backend/src/`、`frontend/src/`) | CR |

**踩到的地方不在你的 scope 裡 → 開 CR。** 不要只傳訊息給對方:訊息不在 repo 裡,
對方的 session 一壓縮就沒了。**訊息可以通知,不能保存。**

第一個實例就地留註解,而且指名下一個會踩的人:

```
// 坑(下一個踩的人:qa):e2e 的 port 寫死,兩個 session 同時跑會互撞
```

`pnpm role` 會在那個角色開場時提醒他(`pnpm role --pits` 看內容)。
完整的表與理由見 `contract/decisions/ADR-009-where-knowledge-lives.md`。

## Done
每一條 AC 至少有一個對應測試,且全數通過。
