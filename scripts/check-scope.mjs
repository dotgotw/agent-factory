#!/usr/bin/env node
/**
 * 用法: node scripts/check-scope.mjs <role> [base-ref]
 *
 * 比對本分支相對 base-ref 更動的檔案,確認全都落在該角色的 scope 內。
 * 這是「邊界用機制擋、不用 prompt 擋」的實作。
 *
 * 衍生路徑(scope.json 的 _derived)是例外,但不是放寬:本檢查只確認
 * 這個角色有資格夾帶它,不確認內容 —— 內容的權威是 check:drift。
 * 兩者分屬不同 job,所以兩個都必須是 required check,見 ADR-002。
 */
import { execSync } from 'node:child_process';
import { allowedPathsFor, derivedPathsFor, loadScope } from './role.mjs';

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

const matches = (file, prefixes) => prefixes.some((p) => file.startsWith(p));

const owned = changed.filter((f) => matches(f, allowed));
const carried = changed.filter((f) => !matches(f, allowed) && matches(f, derived));
const violations = changed.filter(
  (f) => !matches(f, allowed) && !matches(f, derived),
);

console.log(`角色: ${role}`);
console.log(`可寫路徑: ${allowed.join(', ')}`);
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
  for (const v of violations) console.error(`   - ${v}`);
  console.error(
    `\n   ${config.roles[role].note}` +
      `\n   若確實需要改動這些檔案,請在 change-requests/ 開一份 CR。`,
  );
  process.exit(1);
}

console.log('\n✅ 全部落在 scope 內');
