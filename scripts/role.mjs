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

/** 路徑是否落在 allow 清單內。接受絕對或相對路徑。 */
export function isPathAllowed(filePath, allowed) {
  const abs = resolve(rootDir, filePath);
  const rel = abs.startsWith(rootDir + '/') ? abs.slice(rootDir.length + 1) : null;
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
    console.log('指派方式(擇一):');
    console.log('  echo backend > .claude/role     # 這個 checkout 一直有效');
    console.log('  export AGENT_ROLE=backend       # 只在目前 shell 有效');
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
}
