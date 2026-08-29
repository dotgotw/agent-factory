# ADR-001: 以 OpenAPI 作為 API 唯一真相

- **狀態**: accepted
- **日期**: 2026-08-28

## 脈絡
多個 Agent 平行開發,需要一個交接介面。

## 決策
`contract/openapi.yaml` 為唯一 API 真相。前後端型別皆由其生成並 commit,
CI 重跑生成器並比對 diff。

## 理由
Markdown 寫的 API 規格無法驗證。三個角色各自閱讀、各自理解,不一致要到整合
才會爆炸。改成生成型別後,不一致變成**編譯錯誤**,在 PR 階段就擋下。

副作用同樣重要:contract 一定案,frontend 不需等 backend 就能開工。
平行開發是分工真正的收益,而不是「更專業」。

## 被否決的方案
- **Markdown API 規格 + 人工審查** — 無法機器驗證,且文件漂移無人察覺。
- **Backend 程式碼為真相、自動產生文件** — frontend 必須等 backend 完成,
  失去平行性,且 contract 變更沒有審查點。

## 代價
`generated/` 要 commit 進版控,PR diff 會變吵。以 `.gitattributes` 標記
`linguist-generated` 緩解。
