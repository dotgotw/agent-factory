#!/usr/bin/env node
/**
 * scripts/check-boundaries.mjs
 *
 * 對刻意違規的 fixture 跑 tsc,期望它紅。
 *
 * ADR-003 前提條件二:上面那三條 TS 錯誤若只在遷移當天跑過一次,這個邊界的
 * 壽命就是一次。殘留的洞在 root —— root package.json 裡的任何依賴對每個
 * package 都解析得到,而沒有任何機制阻止有人把 express 加回 root。那會讓
 * frontend 那半邊的邊界**靜默**復原成遷移前的樣子。這支檢查是唯一會出聲的東西。
 *
 * ## 兩個斷言上的講究
 *
 * 一、**斷言「以某個錯誤碼失敗」,而且把它綁在 fixture 那一行上。**
 * 不斷言「只有 fixture 報錯」—— 違規的 import 會把別的檔案一起拉進 program,
 * 連帶產生別的錯誤(architect 複驗 C 組時就撞到),那樣的斷言會 flaky。
 * 但也不能只看「有沒有這個錯誤碼」:那樣 fixture 沒被編譯到也會過。
 * 綁在檔名上兩件事一起解決。
 *
 * 二、**tsc 意外通過時,要先分清楚是設定壞了還是環境洩漏。**
 * 巢狀 worktree(.claude/worktrees/<role>)的上層就是主 checkout,而模組解析
 * 會沿目錄樹往上走 —— 於是 `import express` 可能解析到 repo 之外的
 * node_modules,fixture 因此不紅。那不是這個 repo 的設定有問題,是這個
 * 環境回答不了「應該解析不到」這種問題。
 *
 * 所以意外通過時再跑一次 --traceResolution 看它到底解析到哪裡:
 *   解析到 repo 之內 → 邊界真的破了,紅。
 *   解析到 repo 之外 → 環境洩漏,大聲說出來但不判紅(CI 沒有上層 node_modules,
 *                      那裡才是這件事的權威)。
 *
 * 這個分法比「複製到 repo 之外再跑」便宜,而且更準:設定真的壞掉時
 * (例如有人把 express 加進 frontend/package.json),它會解析到 repo 之內,
 * 照樣紅。
 *
 * ⚠️  撞到「環境洩漏」時不要放寬 fixture。放寬 fixture 等於把鎖拆掉。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSC = join(rootDir, 'node_modules', '.bin', 'tsc');

/** 三個負向案例,對應 ADR-003 決策表的兩種漏洞。 */
const CASES = [
  {
    name: 'frontend 不該解析得到 express(幽靈依賴)',
    project: 'frontend/tsconfig.json',
    fixture: 'frontend/src/ghost.boundary-fixture.ts',
    source: "import express from 'express';\nexport const probe = express;\n",
    code: 'TS2307',
    specifier: 'express',
  },
  {
    name: 'e2e 不該用相對路徑 import 實作(路徑逃逸)',
    project: 'e2e/tsconfig.json',
    fixture: 'e2e/escape.boundary-fixture.ts',
    source: "import { app } from '../backend/src/index.js';\nexport const probe = app;\n",
    code: 'TS6059',
    // 路徑逃逸與 node_modules 無關,不會被環境洩漏影響。
    specifier: null,
  },
  {
    name: 'e2e 不該解析得到 @af/backend(幽靈依賴)',
    project: 'e2e/tsconfig.json',
    fixture: 'e2e/ghost.boundary-fixture.ts',
    source: "import { app } from '@af/backend';\nexport const probe = app;\n",
    code: 'TS2307',
    specifier: '@af/backend',
  },
];

/** 跑 tsc,回傳輸出(不論成敗)。 */
function tsc(args) {
  try {
    return { ok: true, out: execFileSync(TSC, args, { cwd: rootDir, encoding: 'utf8' }) };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** 這個 specifier 解析到哪裡;回答不了就回傳 null。 */
function resolvedPath(project, specifier) {
  const { out } = tsc(['-p', project, '--traceResolution']);
  const marker = `Resolving module '${specifier}'`;
  const from = out.indexOf(marker);
  if (from === -1) return null;
  const hit = out.slice(from).match(/successfully resolved to '([^']+)'/);
  return hit ? hit[1] : null;
}

const failures = [];
const leaks = [];

for (const c of CASES) {
  const fixturePath = join(rootDir, c.fixture);
  if (existsSync(fixturePath)) {
    console.error(`❌ ${c.fixture} 已經存在 —— 不覆蓋別人的檔案。先確認它不是殘留物再重跑。`);
    process.exit(2);
  }

  let verdict;
  try {
    writeFileSync(fixturePath, c.source, 'utf8');
    const { out } = tsc(['-p', c.project]);

    // 錯誤碼必須出現在 fixture 那一行上:同時證明「錯了」與「fixture 真的被編譯」。
    const anchored = out
      .split('\n')
      .some((line) => line.includes(c.fixture) && line.includes(c.code));

    if (anchored) {
      verdict = { kind: 'pass' };
    } else if (c.specifier) {
      const where = resolvedPath(c.project, c.specifier);
      const inside = where && where.startsWith(rootDir + '/');
      verdict = where && !inside
        ? { kind: 'leak', where }
        : { kind: 'fail', out, where };
    } else {
      verdict = { kind: 'fail', out };
    }
  } finally {
    rmSync(fixturePath, { force: true });
  }

  if (verdict.kind === 'pass') {
    console.log(`✅ ${c.name} —— ${c.code}`);
  } else if (verdict.kind === 'leak') {
    leaks.push({ ...c, where: verdict.where });
    console.log(`⚠️  ${c.name} —— 這個環境驗不了(見下)`);
  } else {
    failures.push({ ...c, out: verdict.out, where: verdict.where });
    console.log(`❌ ${c.name} —— 期望 ${c.code},沒有出現`);
  }
}

if (leaks.length > 0) {
  console.log(`\n⚠️  ${leaks.length} 個案例在這個環境驗不了:`);
  for (const l of leaks) {
    console.log(`   - ${l.specifier} 解析到 repo 之外:`);
    console.log(`     ${l.where}`);
  }
  console.log('');
  console.log('   模組解析會沿目錄樹往上走。若這個工作區在另一個 checkout 底下');
  console.log('   (例如 .claude/worktrees/<role>),上層的 node_modules 會被撈到,');
  console.log('   於是「應該解析不到」這種問題在這裡問不出答案。');
  console.log('');
  console.log('   CI 是乾淨 checkout,沒有上層,那裡才是這件事的權威。');
  console.log('   **不要因此放寬 fixture** —— 那是把鎖拆掉,不是修檢查。');
}

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} 個邊界沒有守住:`);
  for (const f of failures) {
    console.error(`   - ${f.name}`);
    console.error(`     期望 ${f.fixture} 出現 ${f.code}`);
    if (f.where) console.error(`     實際解析到 repo 之內: ${f.where}`);
    const head = (f.out ?? '').split('\n').filter(Boolean).slice(0, 3);
    for (const line of head) console.error(`     | ${line}`);
  }
  console.error('\n   邊界的來源是各 tsconfig 的 rootDir 與各 package.json 的依賴宣告。');
  console.error('   見 contract/decisions/ADR-003-role-boundaries-enforced-by-module-resolution.md');
  process.exit(1);
}

console.log(`\n✅ ${CASES.length - leaks.length}/${CASES.length} 個邊界已驗證`);
