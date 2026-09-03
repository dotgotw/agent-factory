/**
 * scripts/role.test.mjs
 *
 * 測 CR-016 的保證層:「main 在我不在的時候動了沒」。
 *
 * 擁有權那一大半在 scope.test.mjs,這裡只管 incoming。
 *
 * 全部餵合成的輸入,不看 repo 當下領先幾個 commit —— 那個數字每次合併都會變,
 * 拿它當 fixture 等於讓「今天剛好有沒有人合併」決定測得到什麼(CR-014)。
 * 只有最後一條真的去跑 git,而它斷言的是「問不出答案時不會炸」。
 *
 * 跑法: pnpm test:scripts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { loadScope, readIncoming, incomingForRole, summarizeIncoming, rootDir } from './role.mjs';

const config = loadScope();

test('沒有東西進來 → 不印(不製造常駐噪音)', () => {
  assert.equal(summarizeIncoming({ count: 0, files: [] }, 'infra', config), null);
});

test('問不出答案 → 也不印,而不是印一個假的 0', () => {
  // readIncoming 在沒有 origin/main 時回 null。「不知道」跟「沒有東西」不是同一件事,
  // 印成「main 沒有領先」會是一句謊話。
  assert.equal(summarizeIncoming(null, 'infra', config), null);
});

test('有東西進來 → 一行,同時給總數與「其中多少是我的」', () => {
  const line = summarizeIncoming(
    { count: 3, files: ['scripts/role.mjs', 'backend/src/index.ts'] },
    'infra',
    config,
  );
  assert.match(line, /main 領先 3 個 commit/);
  assert.match(line, /1 個檔案在你的 scope 內/);
});

test('只數自己的:別人的、共用的、衍生的都不算進「你的 scope」', () => {
  // change-requests/ 是 _everyone(加法),generated/ 是衍生產物 —— 兩者都不是
  // 「你的東西被動了」,混進去會讓這個數字失去意義:每一份 CR 都會讓它跳。
  const files = [
    'scripts/role.mjs', // 我的
    'backend/src/index.ts', // backend 的
    'change-requests/CR-013.md', // 共用
    'generated/api.ts', // 衍生
    'contract/openapi.yaml', // architect 的
  ];
  assert.deepEqual(incomingForRole({ count: 5, files }, 'infra', config), ['scripts/role.mjs']);
});

test('同一份輸入換個角色,算出來的是那個角色的東西', () => {
  const files = ['scripts/role.mjs', 'backend/src/index.ts'];
  assert.deepEqual(incomingForRole({ count: 2, files }, 'backend', config), [
    'backend/src/index.ts',
  ]);
});

test('那一行必須帶著測量範圍 —— 沒標範圍的數字在 ref 過期時就是謊話', () => {
  // 這條守的是 CR-016 裡那個「刻意不 fetch」的取捨:漏報可以接受,前提是
  // 輸出自己講清楚它量的是哪個 ref。把這句話拿掉,漏報就變成誤導。
  const line = summarizeIncoming({ count: 1, files: [] }, 'infra', config);
  assert.match(line, /未 fetch/);
  assert.match(line, /origin\/main/);
});

test('永遠只有一行,不論碰到幾個檔案(ADR-009:105-113 的常數長度)', () => {
  // 開場輸出是每個 session 都要付、注意力最稀缺的那一刻。坑註解同一條規則:
  // 一條很有用,二十條是一面牆,而牆會被跳過 —— 連同它上面那幾行一起。
  const many = Array.from({ length: 200 }, (_, i) => `scripts/f${i}.mjs`);
  const line = summarizeIncoming({ count: 200, files: many }, 'infra', config);
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /--incoming/, '細節要有地方查,否則一行計數就只是把資訊丟掉');
});

test('readIncoming 在沒有 origin/main 的地方回 null,不是拋錯', () => {
  // 乾淨 clone、還沒設 remote、根本不是 git 工作區 —— 這些都是「這裡問不出答案」,
  // 而 pnpm role 跑在 SessionStart hook 裡,炸掉會擋住整個開場。
  const dir = mkdtempSync(join(tmpdir(), 'role-incoming-'));
  try {
    assert.equal(readIncoming(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 一個合成的 git repo:HEAD 停在第一個 commit,origin/main 指到第二個。
 * 用真的 git,因為 readIncoming 要驗的正是「git 問得出來嗎」——
 * 把 git 換成假的,測到的就只剩我自己寫的 mock。
 */
function repoWithIncoming(files) {
  const dir = mkdtempSync(join(tmpdir(), 'role-git-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'test']);

  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'seed']);
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  for (const f of files) {
    mkdirSync(join(dir, dirname(f)), { recursive: true });
    writeFileSync(join(dir, f), 'x\n');
  }
  git(['add', '-A']);
  git(['commit', '-qm', 'ahead']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(['reset', '--hard', '-q', base]);
  return dir;
}

test('readIncoming 真的從 git 算出 main 領先幾個 commit、碰了哪些檔案', () => {
  const dir = repoWithIncoming(['scripts/role.mjs', 'backend/src/index.ts']);
  try {
    const incoming = readIncoming(dir);
    assert.equal(incoming.count, 1);
    assert.deepEqual(incoming.files.sort(), ['backend/src/index.ts', 'scripts/role.mjs']);
    // 端到端:git → 分類 → 那一行
    const line = summarizeIncoming(incoming, 'infra', config);
    assert.match(line, /main 領先 1 個 commit,其中 1 個檔案在你的 scope 內/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI 開場真的印出「一個任務一條 session」那句(CR-015 的第三處落地)', () => {
  // 斷言的是**那條線**,不是某個函式的回傳值:這句話是寫死在 CLI 裡的,
  // 沒有函式可測,而它被刪掉時不會有任何其他測試出聲。
  const out = execFileSync('node', [join(rootDir, 'scripts/role.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_ROLE: 'infra' },
  });
  // 用 includes 不用 regex:這句話裡有全形問號,寫成 regex 時 ASCII 的 ? 會變成量詞,
  // 而那種失敗看起來像「功能壞了」,實際上是斷言自己寫錯 —— 白追一輪。
  assert.ok(out.includes('這條 session 要做哪個任務?做完就關'), out);
});

test('CLI 的 incoming 行與 lib 算出來的一致 —— 兩邊都不准自己編', () => {
  // 雙向:lib 說有,輸出就必須有那一行;lib 說沒有,輸出就不准出現。
  // 這條擋的是「接線被砍掉」與「CLI 自己另外算一份」兩種漂移。
  const out = execFileSync('node', [join(rootDir, 'scripts/role.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_ROLE: 'infra' },
  });
  const expected = summarizeIncoming(readIncoming(), 'infra', config);
  if (expected) {
    assert.ok(out.includes(expected), `開場應該包含:${expected}`);
  } else {
    assert.doesNotMatch(out, /main 領先/);
  }
});
