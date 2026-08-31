#!/usr/bin/env node
/**
 * PreToolUse hook:在寫入發生的當下擋掉越界,而不是等到 CI。
 *
 * 這是「早期回饋」不是「邊界」—— agent 改得到 .claude/role,也能繞過 Edit/Write
 * 改用 Bash 寫檔(PreToolUse 的 matcher 涵蓋不到 shell 內容)。真正擋得住的是
 * CI 的 check-scope.mjs 與 .github/CODEOWNERS 要求的人類 review。
 *
 * 這個 hook 的價值在於把「越界」的回饋從幾分鐘(CI)縮短到零秒,
 * 並且在 deny 的理由裡直接告訴 agent 該走 CR 流程。
 */
import { readFileSync } from 'node:fs';
import {
  allowedPathsFor,
  isPathAllowed,
  loadScope,
  resolveRole,
  toRepoRelative,
} from '../../scripts/role.mjs';

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

/** 放行:不輸出任何東西,交回正常的權限流程。 */
function allow() {
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  // 讀不到或解析失敗時放行 —— hook 壞掉不該讓 session 動彈不得。
  allow();
}

const input = payload.tool_input ?? {};
const filePath = input.file_path ?? input.notebook_path;
if (!filePath) allow();

// 指派角色本身必須放行,否則沒有角色時連設定角色都做不到。
if (filePath.endsWith('/.claude/role') || filePath === '.claude/role') allow();

const config = loadScope();
const role = resolveRole();
const roles = Object.keys(config.roles).join(', ');

// 探索期的逃生門:設 AGENT_SCOPE_ENFORCE=warn 就只提示不擋。
const enforcing = (process.env.AGENT_SCOPE_ENFORCE ?? 'deny') !== 'warn';

// 衍生產物:對所有角色一律擋手改,與角色無關(ADR-002)。
//
// scope.json 的 writers 管的是「誰的 PR 可以夾帶重新生成的結果」,那是
// check-scope 在 PR 層級的判斷。這個 hook 攔的是 Edit/Write —— 也就是
// 手改本身,而手改衍生檔案對任何角色都是錯的:內容會在下一次重新生成時
// 被覆蓋,然後 check:drift 判紅。早點講比讓他改完再紅好。
const rel = toRepoRelative(filePath);
const derivedHit = rel
  ? Object.keys(config._derived ?? {}).find((prefix) => rel.startsWith(prefix))
  : null;

if (derivedHit) {
  if (!enforcing) allow();
  const info = config._derived[derivedHit];
  deny(
    `\`${filePath}\` 是衍生產物,不由任何角色手動撰寫。\n` +
      `${info.note}\n\n` +
      `要改它,改生成器的輸入再重新生成:\n` +
      `${info.inputs.map((i) => `  - ${i}`).join('\n')}\n\n` +
      `內容的權威是 \`${info.guard}\`,不是 scope。手改會在下一次檢查被覆蓋並判紅。\n` +
      `見 contract/decisions/ADR-002-derived-artifacts-guarded-by-regeneration.md`,
  );
}

if (!role) {
  if (!enforcing) allow();
  deny(
    `這個 session 還沒有指派角色,不確定你可以寫哪些檔案。\n` +
      `先執行 \`node scripts/role.mjs\` 看說明,或請人類指派。\n` +
      `可用角色: ${roles}`,
  );
}

const allowed = allowedPathsFor(role, config);
if (!allowed) {
  if (!enforcing) allow();
  deny(`角色 "${role}" 不存在於 scripts/scope.json。可用角色: ${roles}`);
}

if (isPathAllowed(filePath, allowed)) allow();

if (!enforcing) allow();
deny(
  `\`${filePath}\` 不在 ${role} 角色的可寫範圍內。\n` +
    `可寫路徑: ${allowed.join('、')}\n` +
    `${config.roles[role].note}\n\n` +
    `若這個變更確實必要,在 change-requests/ 開一份 CR,不要直接改。`,
);
