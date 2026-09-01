#!/usr/bin/env bash
# generated/ 與 AGENTS.md 的把關:重新生成,然後確認 repo 裡躺的就是生成出來的東西。
#
# 有三種漂移,少問一個就會留下一條靜默的路:
#
#   ① 內容不同         —— git diff 抓得到
#   ② 多了一個檔案     —— gen-types.sh 每次先 rm -rf generated,多出來的那個
#                          (已被 commit 的)檔案會變成 diff 裡的刪除(ADR-002 前提一)
#   ③ 少了一個檔案     —— 生成器產出、但沒 commit 的檔案是「未追蹤」,
#                          而 git diff 看不見未追蹤的檔案。本腳本補的是這一條。
#
# ③ 是 ② 的反方向,實測今天是綠的:
#
#   $ git rm --cached generated/package.json   # 模擬「忘了 commit」
#   $ pnpm check:drift                          → exit 0
#
# 後果是 main 上少一個生成物而沒有任何一條紅線提醒 —— 下一個引用它的人才會發現,
# 而那時錯誤訊息會指向別的地方。
set -euo pipefail

cd "$(dirname "$0")/.."

bash scripts/gen-types.sh
node scripts/sync-agents.mjs

# ①②
if ! git diff --exit-code generated/ AGENTS.md; then
  echo ""
  echo "❌ generated/ 或 AGENTS.md 與重新生成的結果不同。"
  echo "   要嘛有人手改了衍生檔案,要嘛改了生成器的輸入卻忘記重新生成。"
  echo "   跑一次 pnpm gen:types(或 pnpm sync:agents)並一併 commit。"
  exit 1
fi

# ③
#
# 刻意不加 --exclude-standard:gen-types.sh 每次都先 rm -rf generated,所以跑完
# 之後那個目錄裡的東西全部是生成器剛產出的。任何「未追蹤」都代表有一個生成物
# 沒進版控 —— 包含「把 generated/ 加進 .gitignore」這種會讓整個守衛靜默失效的改法。
untracked="$(git ls-files --others -- generated/)"
if [ -n "$untracked" ]; then
  echo "❌ 生成器產出了未進版控的檔案:"
  printf '%s\n' "$untracked" | sed 's/^/   - /'
  echo ""
  echo "   git diff 看不見未追蹤的檔案,所以上面那一步抓不到這種漂移。"
  echo "   把它們 commit 進來;若那些檔案本來就不該存在,改的是生成器。"
  exit 1
fi

echo "✅ generated/ 與 AGENTS.md 沒有漂移"
