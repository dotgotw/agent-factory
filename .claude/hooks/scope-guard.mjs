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
 *
 * 判斷邏輯不在這裡,在 role.mjs 的 classifyPath() —— 與 CI 的 check-scope.mjs
 * 共用同一份,免得出現 hook 放行、CI 擋下的組合。
 */
import { readFileSync } from 'node:fs';
import { classifyPath, exceptionsFor, loadScope, resolveRole } from '../../scripts/role.mjs';

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

// 探索期的逃生門:設 AGENT_SCOPE_ENFORCE=warn 就只提示不擋。
const enforcing = (process.env.AGENT_SCOPE_ENFORCE ?? 'deny') !== 'warn';

// 規則檔本身壞掉時擋下,不放行。
//
// 上面那個 payload 解析失敗是「hook 自己的故障」,放行是對的;這裡不是 ——
// scope.json 是規則的來源,它不合法(或擁有權撞名)的時候,沒有任何一條
// 邊界是可信的。這種時候自由寫入是最不該發生的事。
let config;
try {
  config = loadScope();
} catch (err) {
  if (!enforcing) allow();
  deny(
    `scripts/scope.json 無法載入,邊界目前不可信:\n${err.message}\n\n` +
      `先修好規則檔再繼續。`,
  );
}

const role = resolveRole();
const roles = Object.keys(config.roles).join(', ');
const verdict = classifyPath(filePath, role, config);

// 衍生產物:對所有角色一律擋手改,與角色無關(ADR-002)。
//
// scope.json 的 writers 管的是「誰的 PR 可以夾帶重新生成的結果」,那是
// check-scope 在 PR 層級的判斷。這個 hook 攔的是 Edit/Write —— 也就是
// 手改本身,而手改衍生檔案對任何角色都是錯的:內容會在下一次重新生成時
// 被覆蓋,然後 check:drift 判紅。早點講比讓他改完再紅好。
if (verdict.kind === 'derived') {
  if (!enforcing) allow();
  const { prefix, info } = verdict.derived;
  deny(
    `\`${filePath}\` 是衍生產物,不由任何角色手動撰寫。\n` +
      `${info.note}\n\n` +
      `要改它,改生成器的輸入再重新生成:\n` +
      `${info.inputs.map((i) => `  - ${i}`).join('\n')}\n\n` +
      `內容的權威是 \`${info.guard}\`,不是 scope。手改會在下一次檢查被覆蓋並判紅。\n` +
      `見 contract/decisions/ADR-002-derived-artifacts-guarded-by-regeneration.md(衍生路徑 ${prefix})`,
  );
}

if (!role) {
  if (!enforcing) allow();
  deny(
    `這個 session 還沒有指派角色,不確定你可以寫哪些檔案。\n` +
      `先執行 \`pnpm role\` 看說明,或請人類指派。\n` +
      `可用角色: ${roles}`,
  );
}

if (!config.roles[role]) {
  if (!enforcing) allow();
  deny(`角色 "${role}" 不存在於 scripts/scope.json。可用角色: ${roles}`);
}

// outside(repo 之外的暫存檔)、everyone(change-requests/)、owned 都放行。
if (verdict.kind !== 'foreign' && verdict.kind !== 'unowned') allow();
if (!enforcing) allow();

const allowed = [...config.roles[role].allow, ...config._everyone];
const exceptions = exceptionsFor(role, config);

// 最長前綴勝出:被擋下的原因可能不是「不在你的清單裡」,而是
// 「有一條更精確的規則歸別人」。這兩者的下一步不同,所以要講清楚。
const why =
  verdict.kind === 'foreign'
    ? `它歸 ${verdict.owner} —— 命中的規則是 "${verdict.rule}",` +
      `比你的前綴更精確,所以勝出(最長前綴勝出,見 ADR-003)。`
    : `沒有任何角色擁有這個路徑。要新增檔案的話,擁有權要先在 scripts/scope.json 裡講清楚。`;

deny(
  `\`${filePath}\` 不在 ${role} 角色的可寫範圍內。\n` +
    `${why}\n\n` +
    `可寫路徑: ${allowed.join('、')}\n` +
    (exceptions.length > 0
      ? `例外(在你的目錄底下但歸別人): ${exceptions.map((e) => `${e.rule} → ${e.owner}`).join('、')}\n`
      : '') +
    `${config.roles[role].note}\n\n` +
    `若這個變更確實必要,在 change-requests/ 開一份 CR,不要直接改。`,
);
