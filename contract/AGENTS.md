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

## 發現坑怎麼辦

**先問:下一個人會不會在同樣的地方再踩一次?**
不會 → 寫進 PR 描述,結束。一次性的事建檔只會稀釋真正該讀的東西。

會 → 再問「他再踩的時候,眼睛在看什麼」,答案就是家:

| 他正在做什麼 | 家 |
|---|---|
| 改 `openapi.yaml` 的那一段 | 那一段的註解 —— **不是 `description`**,那會流進 `generated/api.ts` 變成 API 消費者讀的文件,受眾對不上 |
| 寫下一條規則 | ADR,但門檻是兩個條件同時成立:**是我們自己造成的形狀**(不是工具的行為),而且**重複出現過**(一個實例還不夠) |
| 裁決一份 CR | 那份 CR 的裁決段 |

**踩到的地方不在你的 scope 裡 → 開 CR。** 不要只傳訊息給對方:訊息不在 repo 裡,
對方的 session 一壓縮就沒了。**訊息可以通知,不能保存。**

第一個實例就地留註解,而且指名下一個會踩的人:

```
// 坑(下一個踩的人:qa):e2e 的 port 寫死,兩個 session 同時跑會互撞
```

`pnpm role` 會在那個角色開場時提醒他(`pnpm role --pits` 看內容)。
完整的表與理由見 `contract/decisions/ADR-009-where-knowledge-lives.md`。
