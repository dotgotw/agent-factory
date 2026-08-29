#!/usr/bin/env node
/**
 * 用法: node scripts/check-scope.mjs <role> [base-ref]
 *
 * 比對本分支相對 base-ref 更動的檔案,確認全都落在該角色的 scope 內。
 * 這是「邊界用機制擋、不用 prompt 擋」的實作。
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, 'scope.json'), 'utf8'));

const role = process.argv[2];
const baseRef = process.argv[3] ?? 'origin/main';

if (!role || !config.roles[role]) {
  console.error(`❌ 未知角色: ${role ?? '(未提供)'}`);
  console.error(`   可用角色: ${Object.keys(config.roles).join(', ')}`);
  process.exit(2);
}

const allowed = [...config.roles[role].allow, ...config._everyone];

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

const violations = changed.filter(
  (file) => !allowed.some((prefix) => file.startsWith(prefix)),
);

console.log(`角色: ${role}`);
console.log(`可寫路徑: ${allowed.join(', ')}`);
console.log(`本次更動 ${changed.length} 個檔案`);

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
