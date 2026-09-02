#!/usr/bin/env node
/**
 * scripts/check-pits.mjs —— 坑註解的形狀檢查(ADR-009 補充)
 *
 * 只驗一件事:**用了那個標記,就必須指名一個 scope.json 裡存在的角色。**
 *
 * 不驗「這是不是真的坑」—— 那不可判定,而假裝驗得了的檢查會製造假警報,
 * 噪音的下場這個 repo 已經寫過三次:被人繞掉。
 *
 * 指名是這個機制唯一的必要條件:沒有角色,pnpm role 就不會把它端到任何人面前,
 * 那則註解等於寫在沒有人會經過的地方 —— 也就是 ADR-009 一開始要修的那個問題。
 *
 * 標記字串與掃描範圍都住在 scripts/pits.mjs,這裡不重寫一份。
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadScope } from './role.mjs';
import { scanPits, shapeErrors } from './pits.mjs';

function main() {
  const roles = Object.keys(loadScope().roles);
  const pits = scanPits();
  const errors = shapeErrors(pits, roles);

  console.log(`檢查 ${pits.length} 條坑註解`);
  const byRole = new Map();
  for (const p of pits) byRole.set(p.role, (byRole.get(p.role) ?? 0) + 1);
  for (const [role, n] of [...byRole].sort()) console.log(`  ${role}: ${n}`);

  if (errors.length > 0) {
    console.error(`\n❌ ${errors.length} 條沒有指名角色:`);
    for (const e of errors) console.error(`   - ${e}`);
    console.error(
      `\n   形狀是 // 坑(下一個踩的人:<角色>):說明\n` +
        `   見 contract/decisions/ADR-009-where-knowledge-lives.md`,
    );
    process.exit(1);
  }

  console.log('\n✅ 坑註解都指名了角色');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
