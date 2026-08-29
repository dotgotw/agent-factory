#!/bin/bash
# SessionStart hook:讓每個 session 一開始就知道「我是誰、我能寫哪裡」。
#
# stdout 會被加進 session 的 context,所以這裡只印給 agent 看的東西;
# 安裝相依套件的雜訊一律導掉。
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# Claude Code on the web 每次都是全新 container,沒有 node_modules 就沒辦法
# 跑 npm run verify。本機開發不碰,交給開發者自己管。
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && [ ! -d node_modules ]; then
  npm install >/dev/null 2>&1 || true
fi

echo "## agent-factory 角色"
echo ""
node scripts/role.mjs 2>&1 || true
echo ""
echo "越界的寫入會被 .claude/hooks/scope-guard.mjs 擋下。"
echo "規則見 AGENTS.md;跨角色的變更請在 change-requests/ 開 CR。"

exit 0
