#!/usr/bin/env node
/**
 * 用法: node scripts/check-scope.mjs <role> [base-ref]
 *
 * 比對本分支相對 base-ref 更動的檔案,確認全都落在該角色的 scope 內。
 * 這是「邊界用機制擋、不用 prompt 擋」的實作。
 *
 * 判斷本身不在這裡 —— 在 role.mjs 的 classifyPath(),與 scope-guard hook
 * 共用同一份。兩邊各寫一份比對邏輯的話,遲早會出現 hook 放行、CI 擋下
 * (或反過來)的組合,那比沒有檢查更難查。
 *
 * 衍生路徑(scope.json 的 _derived)是例外,但不是放寬:本檢查只確認
 * 這個角色有資格夾帶它,不確認內容 —— 內容的權威是 check:drift。
 * 兩者分屬不同 job,所以兩個都必須是 required check,見 ADR-002。
 */
import { execSync } from 'node:child_process';
import {
  allowedPathsFor,
  classifyPath,
  derivedPathsFor,
  exceptionsFor,
  loadScope,
} from './role.mjs';

const config = loadScope();

const role = process.argv[2];
const baseRef = process.argv[3] ?? 'origin/main';

if (!role || !config.roles[role]) {
  console.error(`❌ 未知角色: ${role ?? '(未提供)'}`);
  console.error(`   可用角色: ${Object.keys(config.roles).join(', ')}`);
  process.exit(2);
}

const allowed = allowedPathsFor(role, config);
const derived = derivedPathsFor(role, config);
const exceptions = exceptionsFor(role, config);

let changed;
try {
  changed = execSync(`git diff --name-only ${baseRef}...HEAD`, {
    encoding: 'utf8',
  })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
} catch {
  console.error(`❌ 無法比對 ${baseRef};請確認 base ref 存在。`);
  process.exit(2);
}

const owned = [];
const carried = [];
const violations = [];

for (const file of changed) {
  const verdict = classifyPath(file, role, config);
  switch (verdict.kind) {
    case 'owned':
    case 'everyone':
    case 'outside':
      owned.push(file);
      break;
    case 'derived':
      if (verdict.derived.info.writers.includes(role)) carried.push(file);
      else
        violations.push({
          file,
          why: `衍生路徑 ${verdict.derived.prefix},可夾帶的角色: ${verdict.derived.info.writers.join('、')}`,
        });
      break;
    case 'foreign':
      violations.push({ file, why: `歸 ${verdict.owner}(規則 "${verdict.rule}")` });
      break;
    default:
      violations.push({ file, why: '沒有任何角色擁有這個路徑' });
  }
}

console.log(`角色: ${role}`);
console.log(`可寫路徑: ${allowed.join(', ')}`);
if (exceptions.length > 0) {
  // 最長前綴勝出之後,「可寫路徑」不再等於「這個前綴底下的全部」。
  console.log(
    `  例外(歸別人): ${exceptions.map((e) => `${e.rule} → ${e.owner}`).join(', ')}`,
  );
}
if (derived.length > 0) {
  console.log(`可夾帶的衍生路徑: ${derived.join(', ')}`);
}
console.log(`本次更動 ${changed.length} 個檔案(自己的 ${owned.length}、衍生 ${carried.length})`);

if (carried.length > 0) {
  // 不是違規,但值得說出來 —— 讓 review 的人知道這些檔案的把關者是另一個 job。
  console.log(`\nℹ️  夾帶 ${carried.length} 個衍生檔案:`);
  for (const c of carried) console.log(`   - ${c}`);
  const guards = [...new Set(derived.map((p) => config._derived[p].guard))];
  console.log(`   內容不由本檢查負責,由 ${guards.join('、')} 重新生成後比對。`);
}

if (violations.length > 0) {
  console.error(`\n❌ 越界 ${violations.length} 個檔案:`);
  for (const v of violations) console.error(`   - ${v.file} —— ${v.why}`);
  console.error(
    `\n   ${config.roles[role].note}` +
      `\n   若確實需要改動這些檔案,請在 change-requests/ 開一份 CR。`,
  );
  process.exit(1);
}

console.log('\n✅ 全部落在 scope 內');
