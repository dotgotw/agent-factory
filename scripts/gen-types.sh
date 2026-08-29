#!/usr/bin/env bash
# contract/openapi.yaml -> generated/api.ts
#
# 這個腳本是「文件變成約束」的關鍵。
# generated/ 需要 commit 進 repo,CI 會重跑本腳本並比對 diff,
# 因此手改 generated/ 或改了 contract 卻忘記重生成,都會讓 CI 失敗。
set -euo pipefail

cd "$(dirname "$0")/.."

npx --yes openapi-typescript contract/openapi.yaml -o generated/api.ts

# 加上防手改的標頭
tmp="$(mktemp)"
{
  echo "// ⚠️  AUTO-GENERATED — 請勿手動修改。"
  echo "// 來源: contract/openapi.yaml"
  echo "// 重新生成: npm run gen:types"
  cat generated/api.ts
} > "$tmp"
mv "$tmp" generated/api.ts

echo "✅ generated/api.ts 已更新"
