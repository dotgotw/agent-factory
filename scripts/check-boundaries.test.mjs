/**
 * scripts/check-boundaries.test.mjs
 *
 * 測的是「殘留的 fixture 該怎麼處理」與「verify 的順序」。
 *
 * 這裡刻意**不**去真的擺一個殘留檔案來測:那需要寫進 e2e/(不是 infra 的
 * scope),而且「十分鐘的邊界」用真的時間測要嘛等十分鐘、要嘛靠 mtime 造假。
 * triageFixture 是純函式就是為了這個 —— 把讀到的東西餵進去,合成的輸入,
 * 不依賴 repo 當下有沒有殘留物(CR-014 的教訓:拿 production 狀態當 fixture,
 * 等於讓「有沒有人在用這個功能」決定「測不測得到」)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { triageFixture, humanAge, clearStaleFixture, CASES } from './check-boundaries.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE = "import { app } from '@af/backend';\nexport const probe = app;\n";
const MIN = 60 * 1000;
const NOW = 1_700_000_000_000;

/** 一份「內容是我們寫的、年紀是 ageMin 分鐘」的殘留物。 */
const aged = (ageMin, content = SOURCE) => ({
  content,
  mtimeMs: NOW - ageMin * MIN,
  now: NOW,
  source: SOURCE,
});

test('內容不是我們寫的 → 不動它,即使它很舊', () => {
  // 保守的那一半要留著:這支檢查只認得自己的檔案,別人的東西一律不刪。
  const v = triageFixture(aged(60 * 24 * 30, '// 某個人真的在寫的東西\n'));
  assert.equal(v.action, 'refuse');
  assert.equal(v.why, 'foreign');
});

test('內容是我們寫的、而且很新 → 當作有另一個 run 正在跑,不抽掉它', () => {
  const v = triageFixture(aged(2));
  assert.equal(v.action, 'refuse');
  assert.equal(v.why, 'concurrent');
});

test('內容是我們寫的、而且夠舊 → 認定是硬殺的殘留物,清掉', () => {
  // architect 撞到的那一個是 12 小時。
  const v = triageFixture(aged(60 * 12));
  assert.equal(v.action, 'clean');
  assert.equal(v.why, 'stale');
});

test('剛好落在視窗邊界上算舊的 —— 邊界要有一邊是閉的,不能兩邊都開', () => {
  const windowMs = 10 * MIN;
  assert.equal(triageFixture({ ...aged(10), windowMs }).action, 'clean');
  assert.equal(triageFixture({ ...aged(9.9), windowMs }).action, 'refuse');
});

test('視窗可以由呼叫端指定 —— 測試不必等真的十分鐘', () => {
  assert.equal(triageFixture({ ...aged(1), windowMs: 30 * 1000 }).action, 'clean');
});

test('humanAge 在三個級距上都講人話', () => {
  assert.equal(humanAge(5 * MIN), '5 分鐘');
  assert.equal(humanAge(12 * 60 * MIN), '12 小時');
  assert.equal(humanAge(72 * 60 * MIN), '3 天');
});

test('verify 裡 check:boundaries 必須排在 typecheck 之前', () => {
  // 這條順序是有負載的,不是排版。殘留的 fixture 被 .gitignore 蓋住、卻在
  // e2e/tsconfig.json 的 include 裡,所以 typecheck 先跑就會紅在一個
  // 「git status 看不到、自己也沒寫過」的檔案上,而 check-boundaries.mjs 裡
  // 那段專門為此寫的診斷永遠跑不到。architect 撞到的那個殘留物躺了 12 小時。
  //
  // 反過來排,診斷會先說話,而且會順手把殘留物清掉。
  const { scripts } = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const verify = scripts.verify;

  const boundaries = verify.indexOf('check:boundaries');
  const typecheck = verify.indexOf('pnpm typecheck');

  assert.notEqual(boundaries, -1, 'verify 應該包含 check:boundaries');
  assert.notEqual(typecheck, -1, 'verify 應該包含 typecheck');
  assert.ok(
    boundaries < typecheck,
    'check:boundaries 必須排在 typecheck 之前,否則殘留的 fixture 會讓 typecheck ' +
      '先紅在一個看不見的檔案上,而 check-boundaries.mjs 的診斷跑不到。',
  );
});

/** 在 tmpdir 擺一份指定年紀的檔案,回傳它的路徑。 */
function stagedFixture(content, ageMin) {
  const dir = mkdtempSync(join(tmpdir(), 'boundary-fixture-'));
  const path = join(dir, 'ghost.boundary-fixture.ts');
  writeFileSync(path, content, 'utf8');
  const when = new Date(Date.now() - ageMin * 60 * 1000);
  utimesSync(path, when, when);
  return { path, dir };
}

test('殘留物真的會被刪掉 —— 驗的是那條線,不是回傳值', () => {
  // 上一版只驗 triageFixture 回傳 'clean'。那個綠沒有保證任何人真的去刪檔案:
  // 呼叫 rmSync 的那一行被砍掉,測試照樣全綠(這正是 pendingSummary 的形狀)。
  const { path, dir } = stagedFixture(SOURCE, 60 * 12);
  try {
    const v = clearStaleFixture(path, SOURCE);
    assert.equal(v.action, 'clean');
    assert.equal(existsSync(path), false, '判定為殘留物之後,檔案應該已經不在了');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('拒絕的時候不刪 —— 別人的檔案必須原封不動留著', () => {
  const { path, dir } = stagedFixture('// 某個人真的在寫的東西\n', 60 * 12);
  try {
    const v = clearStaleFixture(path, SOURCE);
    assert.equal(v.action, 'refuse');
    assert.equal(existsSync(path), true, '不是我們的檔案,絕對不能刪');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('沒有殘留物時回 proceed,而且不會亂碰不存在的路徑', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boundary-fixture-'));
  try {
    assert.equal(clearStaleFixture(join(dir, 'nope.ts'), SOURCE).action, 'proceed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 幽靈依賴的案例只有在「那個 specifier 逃不到外層 checkout」時才是硬判定,
 * 而讓它逃不出去的是 pnpm 的 hoist 規則:**直接宣告的留在自己的 node_modules,
 * 只有傳遞相依才平鋪到 root。** 保護是附帶的,不是設計的(見 check-boundaries.mjs
 * 選 specifier 那段,以及 AGENTS.md #6)。
 *
 * 所以把「只用直接宣告的 specifier」變成機器檢查的:換成傳遞相依(像 `accepts`)
 * 會讓那個案例在巢狀 worktree 裡解析到外層、降級成 ⚠️,而 ⚠️ 是「這裡問不出答案」,
 * 不是「答案是好的」—— 那等於靜默把鎖拆掉一半,而且沒有任何其他測試會出聲。
 */
test('每個幽靈依賴的 specifier 都必須是某個 workspace 套件直接宣告的', () => {
  const manifests = ['package.json', 'backend/package.json', 'frontend/package.json', 'e2e/package.json'];
  const declared = new Set();
  const workspaceNames = new Set();
  for (const m of manifests) {
    const pkg = JSON.parse(readFileSync(join(rootDir, m), 'utf8'));
    if (pkg.name) workspaceNames.add(pkg.name);
    for (const d of Object.keys(pkg.dependencies ?? {})) declared.add(d);
    for (const d of Object.keys(pkg.devDependencies ?? {})) declared.add(d);
  }

  const ghosts = CASES.filter((c) => c.specifier);
  assert.ok(ghosts.length > 0, '至少要有一個幽靈依賴案例,否則這條測試恆真');

  for (const c of ghosts) {
    assert.ok(
      declared.has(c.specifier) || workspaceNames.has(c.specifier),
      `${c.specifier} 既不是任何 workspace 套件直接宣告的依賴,也不是 workspace 套件本身。` +
        ` 傳遞相依會被 pnpm 平鋪到 root,於是在巢狀 worktree 裡解析得到外層 checkout,` +
        ` 這個案例會降級成 ⚠️ 而不是硬判定。換 specifier 前先讀 check-boundaries.mjs 的 CASES 註解。`,
    );
  }
});
