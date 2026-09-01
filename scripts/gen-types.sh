#!/usr/bin/env bash
# contract/openapi.yaml -> generated/api.ts + generated/package.json
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

# generated/ 的 manifest 也是生成的,不是手寫的。
#
# CR-009 初版的第 1 步是「architect 手寫 generated/package.json」,那與上面的
# `rm -rf generated` 互斥 —— 清空目錄會把手寫的 manifest 一起清掉,下一次
# check:drift 就會以「檔案被刪除」判紅。修法不是別清空,是讓生成器一併產出它:
# 一個生成套件的 manifest,內容當然由生成器決定(ADR-002 的推論,_derived 的
# 第二個實例)。
#
# 形狀是實測過的,不是抄來的。在一個真的 pnpm workspace 裡量過:
#   `import type { components } from '@af/contract'` 在 NodeNext + rootDir 下 exit 0
#   (TypeScript 不對 node_modules 底下的檔案套 rootDir,pnpm 的 workspace 連結
#   正是 node_modules 裡的 symlink),而同一份設定擋得下相對路徑逃逸(TS6059)。
#
# api.ts 是純型別(openapi-typescript 不產出任何 runtime 值),所以四個 import
# 全是 `import type`,"default" 那條實際上不會被載入 —— 留著是為了讓這個 package
# 在 runtime 解析時也有明確答案,而不是留一個洞給人猜。
#
# version 固定 0.0.0:private 套件不會發佈,版號不帶任何資訊。要讓它跟著
# openapi.yaml 的 info.version 走是另一個決定,沒有人要求,就不要無中生有一套
# 版本政策。
cat > generated/package.json <<'JSON'
{
  "_comment": "⚠️  AUTO-GENERATED — 請勿手動修改。由 scripts/gen-types.sh 產出,內容的權威是 pnpm check:drift。見 contract/decisions/ADR-002-derived-artifacts-guarded-by-regeneration.md",
  "name": "@af/contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./api.ts",
      "default": "./api.ts"
    }
  }
}
JSON

echo "✅ generated/api.ts 已更新"
echo "✅ generated/package.json 已更新(@af/contract)"
