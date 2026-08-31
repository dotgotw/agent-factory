#!/usr/bin/env node
/**
 * scripts/role.mjs
 *
 * 角色的單一來源。CLI 用法:
 *   node scripts/role.mjs          # 印出目前 session 的角色與可寫路徑
 *
 * 也作為 lib 給 check-scope.mjs 與 .claude/hooks/scope-guard.mjs 使用,
 * 避免「可寫路徑」這件事在三個地方各寫一份而漂移。
 *
 * 角色來源(依序):
 *   1. AGENT_ROLE 環境變數
 *   2. .claude/role 檔案(不進版控)
 *
 * 注意:這兩者 agent 自己都改得到,所以這是「早期回饋」而不是「邊界」。
 * 真正的邊界在 CI(PR label + check-scope.mjs)與 CODEOWNERS。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const rootDir = join(here, '..');

export function loadScope() {
  return JSON.parse(readFileSync(join(here, 'scope.json'), 'utf8'));
}

/** 該角色可寫的路徑前綴,含所有角色共用的部分。未知角色回傳 null。 */
export function allowedPathsFor(role, config = loadScope()) {
  if (!role || !config.roles[role]) return null;
  return [...config.roles[role].allow, ...config._everyone];
}

/**
 * 該角色的變更集可以「帶著一起送」的衍生路徑。
 *
 * 衍生產物不屬於任何角色 —— 它是生成器的輸出,不是誰的財產(ADR-002)。
 * writers 因此不是「誰擁有它」,而是「誰的 PR 可以夾帶重新生成的結果」,
 * 名單由 inputs 的擁有者推導:改得到輸入的人,就改得到輸出。
 *
 * 內容的權威不在這裡,在每個項目的 guard(目前是 check:drift)。
 * 這個函式只回答「這個檔案出現在這個角色的 diff 裡合不合理」。
 */
export function derivedPathsFor(role, config = loadScope()) {
  if (!role) return [];
  return Object.entries(config._derived ?? {})
    .filter(([, info]) => info.writers.includes(role))
    .map(([path]) => path);
}

/** 該角色的變更集允許出現的所有路徑 = 自己的 + 可夾帶的衍生。未知角色回傳 null。 */
export function writablePathsFor(role, config = loadScope()) {
  const owned = allowedPathsFor(role, config);
  if (!owned) return null;
  return [...owned, ...derivedPathsFor(role, config)];
}

/** 目前 session 的角色;未指派回傳 null。 */
export function resolveRole() {
  const fromEnv = process.env.AGENT_ROLE?.trim();
  if (fromEnv) return fromEnv;

  const roleFile = join(rootDir, '.claude', 'role');
  if (existsSync(roleFile)) {
    const fromFile = readFileSync(roleFile, 'utf8').trim();
    if (fromFile) return fromFile;
  }
  return null;
}

/**
 * 轉成相對 repo 根目錄的路徑;repo 之外回傳 null。
 * 接受絕對或相對路徑。
 */
export function toRepoRelative(filePath) {
  const abs = resolve(rootDir, filePath);
  return abs.startsWith(rootDir + '/') ? abs.slice(rootDir.length + 1) : null;
}

/** 路徑是否落在 allow 清單內。接受絕對或相對路徑。 */
export function isPathAllowed(filePath, allowed) {
  const rel = toRepoRelative(filePath);
  // repo 之外的檔案不歸 scope 管(暫存檔、~/.claude 等)。
  if (rel === null) return true;
  return allowed.some((prefix) => rel.startsWith(prefix));
}

// --- CLI ---
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const config = loadScope();
  const role = resolveRole();

  if (!role) {
    console.log('角色: (未指派)');
    console.log(`可用角色: ${Object.keys(config.roles).join(', ')}`);
    console.log('');
    console.log('指派方式(由開 session 的人決定,不是由 agent 自己挑):');
    console.log('  雲端: 每個角色一個環境,環境變數設 AGENT_ROLE');
    console.log('  本機: AGENT_ROLE=backend claude');
    console.log('  臨時: echo backend > .claude/role  # 方便,但 agent 改得到');
    process.exit(3);
  }

  const allowed = allowedPathsFor(role, config);
  if (!allowed) {
    console.error(`❌ 未知角色: ${role}`);
    console.error(`   可用角色: ${Object.keys(config.roles).join(', ')}`);
    process.exit(2);
  }

  console.log(`角色: ${role}`);
  console.log(`可寫路徑: ${allowed.join('、')}`);
  console.log(`說明: ${config.roles[role].note}`);

  const derived = derivedPathsFor(role, config);
  if (derived.length > 0) {
    console.log('');
    console.log(`可夾帶的衍生路徑: ${derived.join('、')}`);
    console.log('  這些不是你的檔案,是生成器的輸出。你可以在自己的 PR 裡帶著');
    console.log('  重新生成的結果一起送,但內容對不對由 check:drift 說了算。');
  }
}
