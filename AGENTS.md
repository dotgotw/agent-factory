# AGENTS.md

本檔是**目錄**,不是知識庫。細節在各自的檔案裡,別往這裡塞。

## 唯一真相

| 主題 | 位置 |
|---|---|
| API | `contract/openapi.yaml` |
| 任務與依賴 | `contract/tasks.yaml` |
| 架構決策 | `contract/decisions/ADR-*.md` |
| 共用型別 | `generated/api.ts`(自動生成,勿手改) |

## 鐵則

1. **`generated/` 不可手動編輯。** 改 `contract/openapi.yaml`,然後 `npm run gen:types`。
2. **只有 Architect 能改 `contract/`。** 其他角色如需變更,在 `change-requests/` 開 CR。
3. **實作角色不可改 `e2e/`。** 測試不過就是不過,不能把測試改綠。
4. **實作角色不可改 `.github/` 與 `scripts/`。** 規則的執行者不受被約束者修改。
5. 送出前必須 `npm run verify` 全綠。

## 角色與可寫路徑

見 `scripts/scope.json`。CI 會強制執行,違反會擋 PR。

<!-- AGENT-FACTORY:START -->
| 角色 | 可寫路徑 | 說明 |
|---|---|---|
| architect | `contract/`、`generated/` | 唯一能改 API contract 與 DB migration 的角色 |
| infra | `.github/`、`scripts/`、`package.json`、`package-lock.json`、`tsconfig.json`、`backend/tsconfig.json`、`frontend/tsconfig.json`、`e2e/tsconfig.json`、`Dockerfile`、`docker-compose.yml`、`.env.example`、`.gitignore`、`.gitattributes`、`README.md`、`AGENTS.md`、`backend/AGENTS.md`、`frontend/AGENTS.md`、`infra/` | 規則的執行者。實作角色不得改動 CI,否則測試紅了可以直接把檢查拿掉。同理,AGENTS.md 由 infra 保管 —— 角色不得改寫自己被賦予的規則。 |
| backend | `backend/src/` | 不得改 contract、frontend、e2e |
| frontend | `frontend/src/` | 不得改 contract、backend、e2e |
| qa | `e2e/` | 只讀驗收條件與 contract,不讀實作 |

所有角色皆可寫 `change-requests/`。
<!-- AGENT-FACTORY:END -->

## 指令

```bash
npm run gen:types     # contract -> 型別
npm run typecheck     # 三個 scope 各自 typecheck
npm run test:e2e      # 黑箱驗收測試
npm run verify        # 上面全部 + drift 檢查
npm run check:scope <role> <base-ref>
```
