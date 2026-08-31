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
 *
 * ---
 *
 * 比對語意(ADR-003 前提條件一)。這個檔案回答的問題從
 * 「我的清單裡有沒有任何一條命中?」改成「這個檔案是誰的?」:
 *
 *   1. 帶結尾斜線的條目是目錄前綴,不帶的是精確檔名。
 *      (舊的 startsWith 讓 "AGENTS.md" 這條也命中 "AGENTS.md.bak"。)
 *   2. roles 之內**最長前綴勝出**,一個檔案只有一個擁有者。
 *      infra 明列的 "e2e/tsconfig.json"(17)勝過 qa 的 "e2e/"(4),
 *      qa 因此**失去**那個檔案 —— 這是 scope.json 第一次有減法。
 *   3. _everyone 與 _derived 是**加法**,不參與長度比較。
 *
 * 第 3 點是實測出來的陷阱,不是潔癖:allowedPathsFor() 會把 _everyone 併進
 * 每個角色的清單,若讓它參賽,"change-requests/" 在五個角色上等長,勝負
 * 取決於 Object.keys 的順序 —— 四個角色會從此開不了 CR,而開 CR 正是被
 * scope 擋下時唯一的合法出口。把逃生門關掉,剩下的選項只有繞過。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const rootDir = join(here, '..');

/** 兩條規則是否指到重疊的檔案集合。 */
function overlaps(a, b) {
  if (a === b) return true;
  if (b.endsWith('/') && a.startsWith(b)) return true;
  if (a.endsWith('/') && b.startsWith(a)) return true;
  return false;
}

/**
 * 擁有權必須唯一,否則「最長前綴勝出」的勝負會取決於物件鍵的順序 ——
 * 那是會靜默漂移的東西,所以在載入時就判錯,不留到執行期。
 */
export function validateScope(config) {
  const errors = [];
  const owner = new Map();

  for (const [role, info] of Object.entries(config.roles ?? {})) {
    for (const rule of info.allow ?? []) {
      if (owner.has(rule)) {
        errors.push(
          `路徑 "${rule}" 同時列在 ${owner.get(rule)} 與 ${role} 的 allow ——` +
            ` 擁有者不唯一,勝負會取決於鍵順序。`,
        );
      } else {
        owner.set(rule, role);
      }
    }
  }

  const additive = [
    ...(config._everyone ?? []).map((p) => ['_everyone', p]),
    ...Object.keys(config._derived ?? {}).map((p) => ['_derived', p]),
  ];
  for (const [where, prefix] of additive) {
    for (const [rule, role] of owner) {
      if (overlaps(rule, prefix)) {
        errors.push(
          `${role} 的 "${rule}" 與 ${where} 的 "${prefix}" 重疊 ——` +
            ` 加法的路徑不參與擁有權比較,重疊會讓兩套規則同時適用。`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `scripts/scope.json 的規則有衝突:\n` +
        errors.map((e) => `  - ${e}`).join('\n'),
    );
  }
  return config;
}

export function loadScope() {
  return validateScope(JSON.parse(readFileSync(join(here, 'scope.json'), 'utf8')));
}

/** 一條 scope 條目是否命中某個 repo 相對路徑。 */
export function ruleMatches(rel, rule) {
  return rule.endsWith('/') ? rel.startsWith(rule) : rel === rule;
}

/**
 * 這個檔案歸誰(roles 之內最長前綴勝出)。無人擁有回傳 null。
 * 不看 _everyone 與 _derived —— 那兩者是加法,由 classifyPath 先行處理。
 */
export function ownerOf(rel, config = loadScope()) {
  let best = null;
  for (const [role, info] of Object.entries(config.roles)) {
    for (const rule of info.allow) {
      if (!ruleMatches(rel, rule)) continue;
      if (!best || rule.length > best.rule.length) best = { role, rule };
    }
  }
  return best;
}

/** 這個檔案是否落在某個衍生路徑底下。 */
export function derivedFor(rel, config = loadScope()) {
  const hit = Object.keys(config._derived ?? {}).find((p) => ruleMatches(rel, p));
  return hit ? { prefix: hit, info: config._derived[hit] } : null;
}

/**
 * 把一個路徑對某個角色分類。這是 hook 與 CI 共用的唯一判斷。
 *
 * kind:
 *   outside  —— repo 之外,不歸 scope 管
 *   everyone —— _everyone 的加法路徑(CR),所有角色皆可寫
 *   derived  —— 衍生產物;能不能寫由呼叫端決定(手改一律不行,夾帶要看 writers)
 *   owned    —— 這個角色擁有
 *   foreign  —— 別的角色擁有(owner 欄位說是誰)
 *   unowned  —— 沒有任何角色擁有
 *
 * 順序是有意義的:derived 必須先於 ownerOf,否則 generated/ 會被判成 unowned。
 */
export function classifyPath(filePath, role, config = loadScope()) {
  const rel = toRepoRelative(filePath);
  if (rel === null) return { rel: null, kind: 'outside' };

  if ((config._everyone ?? []).some((r) => ruleMatches(rel, r))) {
    return { rel, kind: 'everyone' };
  }

  const derived = derivedFor(rel, config);
  if (derived) return { rel, kind: 'derived', derived };

  const owner = ownerOf(rel, config);
  if (!owner) return { rel, kind: 'unowned' };
  if (owner.role === role) return { rel, kind: 'owned', owner: owner.role, rule: owner.rule };
  return { rel, kind: 'foreign', owner: owner.role, rule: owner.rule };
}

/** 該角色可寫的路徑前綴,含所有角色共用的部分。未知角色回傳 null。 */
export function allowedPathsFor(role, config = loadScope()) {
  if (!role || !config.roles[role]) return null;
  return [...config.roles[role].allow, ...config._everyone];
}

/**
 * 我的目錄前綴底下、但歸別人的檔案。
 *
 * 有了最長前綴勝出,「可寫路徑」不再等於「這個前綴底下的全部」——
 * qa 看到 `e2e/` 卻寫不了 `e2e/tsconfig.json`。這個函式讓 CLI 講實話,
 * 免得文件許一個機制不兌現的承諾。
 */
export function exceptionsFor(role, config = loadScope()) {
  const dirs = (config.roles[role]?.allow ?? []).filter((r) => r.endsWith('/'));
  const out = [];
  for (const [other, info] of Object.entries(config.roles)) {
    if (other === role) continue;
    for (const rule of info.allow) {
      if (dirs.some((d) => rule !== d && rule.startsWith(d))) out.push({ rule, owner: other });
    }
  }
  return out.sort((a, b) => a.rule.localeCompare(b.rule));
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

/** 這個角色能不能寫這個檔案。手改衍生產物一律不行(ADR-002)。 */
export function canWrite(role, filePath, config = loadScope()) {
  const { kind } = classifyPath(filePath, role, config);
  return kind === 'outside' || kind === 'everyone' || kind === 'owned';
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

  const exceptions = exceptionsFor(role, config);
  if (exceptions.length > 0) {
    console.log('');
    console.log('其中這些是例外,歸別人(最長前綴勝出):');
    for (const e of exceptions) console.log(`  ${e.rule} → ${e.owner}`);
  }

  const derived = derivedPathsFor(role, config);
  if (derived.length > 0) {
    console.log('');
    console.log(`可夾帶的衍生路徑: ${derived.join('、')}`);
    console.log('  這些不是你的檔案,是生成器的輸出。你可以在自己的 PR 裡帶著');
    console.log('  重新生成的結果一起送,但內容對不對由 check:drift 說了算。');
  }
}
