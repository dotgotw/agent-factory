# CLAUDE.md

@AGENTS.md

## 你是誰

執行 `pnpm whoami`(等同 `node scripts/role.mjs`)取得本 session 的角色與可寫路徑。

沒有角色就**不要動手**——先問人。越界的寫入會被 PreToolUse hook 擋下,
但那是提醒,不是允許你去試探邊界。

## 這份檔案為什麼這麼短

規則的唯一真相是 `scripts/scope.json`(機器讀)與 `AGENTS.md`(人讀,
由 `pnpm sync:agents` 從 scope.json 生成)。這裡只負責把 AGENTS.md 載入
每個 session,以及指出角色從哪裡查。不要把規則抄到這裡——抄了就會漂移,
而 `pnpm check:drift` 保護不到這個檔案。
