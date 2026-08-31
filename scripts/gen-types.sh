#!/usr/bin/env bash
# contract/openapi.yaml -> generated/api.ts
#
# 這個腳本是「文件變成約束」的關鍵。
# generated/ 需要 commit 進 repo,CI 會重跑本腳本並比對 diff,
# 因此手改 generated/ 或改了 contract 卻忘記重生成,都會讓 CI 失敗。
set -euo pipefail

cd "$(dirname "$0")/.."

# 先清空整個目錄再生成 —— 這是 ADR-002 的前提條件,不是潔癖。
#
# check:drift 的把關是 `git diff --exit-code generated/`,而 git diff 比對的是
# 「工作區 vs index」的檔案內容。多塞一個檔案進 generated/ 並 commit,
# 生成器不會覆寫它,git diff 也看不見它 —— 檢查照樣綠燈。
#
# 清空之後,生成器沒產出的檔案會變成 diff 裡的「刪除」,於是被抓到。
# generated/ 的權威從此是「重新生成的結果」,而不是「生成器剛好會覆寫的那幾個檔案」。
rm -rf generated
mkdir -p generated

pnpm exec openapi-typescript contract/openapi.yaml -o generated/api.ts

# 加上防手改的標頭
tmp="$(mktemp)"
{
  echo "// ⚠️  AUTO-GENERATED — 請勿手動修改。"
  echo "// 來源: contract/openapi.yaml"
  echo "// 重新生成: pnpm gen:types"
  cat generated/api.ts
} > "$tmp"
mv "$tmp" generated/api.ts

echo "✅ generated/api.ts 已更新"
