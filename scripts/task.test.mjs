/**
 * scripts/task.test.mjs —— 任務查詢介面的測試(ADR-005)
 *
 * 兩件事特別盯著:
 *   1. decisions 只印路徑,不印內容。那是這份 ADR 的目的本身 —— 印了就等於把
 *      省下來的 token 又花回去,而且「順手也印出來吧」是很自然會被加上的一行。
 *   2. 打錯的輸入要明確失敗,合法但沒結果不算失敗。兩者混在一起,會逼人用
 *      不精確的查詢去避開紅字。
 *
 * 跑法: pnpm test:scripts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  STATUSES,
  filterTasks,
  findAc,
  findTask,
  formatList,
  formatTask,
  loadTasks,
  parseArgs,
} from './task.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROLES = ['architect', 'infra', 'backend', 'frontend', 'qa'];

const task = (over = {}) => ({
  id: 'TASK-900',
  title: '測試用任務',
  owner: 'backend',
  status: 'todo',
  depends_on: [],
  acceptance: [{ id: 'AC-900', text: '某條驗收條件', verified_by: 'e2e' }],
  ...over,
});

// ---------- 參數解析 ----------

test('pnpm task 只吃一個 id', () => {
  assert.deepEqual(parseArgs(['one', 'TASK-003']).errors, []);
  assert.equal(parseArgs(['one', 'TASK-003']).id, 'TASK-003');
  assert.match(parseArgs(['one']).errors[0], /要查哪一個/);
  assert.match(parseArgs(['one', 'A', 'B']).errors[0], /一次只查一個/);
  assert.match(parseArgs(['one', '--owner']).errors[0], /不吃旗標/);
});

test('不認得的旗標、值、位置參數都要報錯,不靜默忽略', () => {
  const roles = ROLES;
  assert.match(parseArgs(['list', '--onwer', 'backend'], { roles }).errors[0], /不認得的旗標/);
  assert.match(parseArgs(['list', 'backend'], { roles }).errors[0], /不認得的參數/);
  assert.match(parseArgs(['list', '--owner'], { roles }).errors[0], /要接一個值/);
  assert.match(parseArgs(['list', '--owner', '--status'], { roles }).errors[0], /要接一個值/);
  assert.match(parseArgs(['list', '--owner', 'nobody'], { roles }).errors[0], /不認得的 owner/);
  assert.match(parseArgs(['list', '--status', 'doen'], { roles }).errors[0], /不認得的 status/);
});

test('錯誤一次收齊,不是修一個跑一次', () => {
  const r = parseArgs(['list', '--onwer', 'x', '--status', 'doen'], { roles: ROLES });
  // 打錯的旗標算一個錯,它的值不會再被當成孤兒參數報第二次 ——
  // 使用者只打錯一個字,不該收到兩行紅字。
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /不認得的旗標/);
  assert.match(r.errors[1], /不認得的 status/);
});

test('合法的條件解析成 filters', () => {
  const r = parseArgs(['list', '--owner', 'backend', '--status', 'done'], { roles: ROLES });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.filters, { owner: 'backend', status: 'done' });
});

test('STATUSES 與 tasks.yaml 檔頭的五個值一致', () => {
  assert.deepEqual(STATUSES, ['todo', 'in_progress', 'blocked', 'review', 'done']);
});

// ---------- 查詢 ----------

test('findTask / findAc / filterTasks', () => {
  const tasks = [
    task(),
    task({ id: 'TASK-901', owner: 'frontend', status: 'done', acceptance: [{ id: 'AC-901', text: 'x' }] }),
  ];
  assert.equal(findTask(tasks, 'TASK-901').owner, 'frontend');
  assert.equal(findTask(tasks, 'TASK-999'), null);
  assert.equal(findAc(tasks, 'AC-901').task.id, 'TASK-901');
  assert.equal(findAc(tasks, 'AC-999'), null);
  assert.equal(filterTasks(tasks, { owner: 'frontend' }).length, 1);
  assert.equal(filterTasks(tasks, { status: 'done' }).length, 1);
  assert.equal(filterTasks(tasks, { owner: 'backend', status: 'done' }).length, 0);
  assert.equal(filterTasks(tasks, { ac: 'AC-900' })[0].id, 'TASK-900');
});

// ---------- 輸出 ----------

test('decisions 只印路徑,不印那些檔案的內容', () => {
  // 這條測試的存在是為了擋一個很自然會被加上的「順手」:既然知道路徑了,
  // 何不把內容也印出來?—— 那就把 ADR-005 省下來的 token 又花回去了。
  const out = formatTask(task({ decisions: ['README.md'] })).join('\n');
  assert.ok(out.includes('README.md'), '路徑要印');

  const readme = readFileSync(join(rootDir, 'README.md'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 20);
  assert.ok(readme.length > 0);
  for (const line of readme) {
    assert.ok(!out.includes(line.trim()), `輸出裡不該出現 README.md 的內容: ${line.trim()}`);
  }
});

test('沒有 decisions 的任務,輸出會說它沒有家', () => {
  const out = formatTask(task()).join('\n');
  assert.match(out, /沒有登記/);
});

test('formatTask 印得出狀態、依賴、AC 與人工驗收紀錄', () => {
  const out = formatTask(
    task({
      status: 'blocked',
      blocked_reason: '等 CR-999',
      depends_on: ['TASK-001'],
      acceptance: [
        {
          id: 'AC-900',
          text: '某條驗收條件',
          verified_by: 'manual',
          verified_note: '打不到畫面',
          verified_record: { at: '2026-09-01', who: 'someone', commit: 'abc1234', saw: '看到某個東西' },
        },
      ],
    }),
  ).join('\n');
  for (const want of ['blocked', '等 CR-999', 'TASK-001', 'AC-900', 'manual', '打不到畫面', 'abc1234', '看到某個東西']) {
    assert.ok(out.includes(want), `輸出應該包含 ${want}`);
  }
});

test('空結果是答案不是錯誤,而且會說清楚為什麼空', () => {
  const tasks = [task({ status: 'done' })];
  const out = formatList(filterTasks(tasks, { status: 'todo' }), { status: 'todo' }, tasks).join('\n');
  assert.match(out, /沒有符合條件的任務/);
});

test('--ac 存在但被其他條件濾掉時,明說它在哪,不是假裝沒有', () => {
  const tasks = [task({ owner: 'backend' })];
  const filters = { owner: 'frontend', ac: 'AC-900' };
  const out = formatList(filterTasks(tasks, filters), filters, tasks).join('\n');
  assert.match(out, /AC-900 存在,屬於 TASK-900/);
});

// ---------- 真實資料 ----------

test('讀得到 contract/tasks.yaml,每個任務都有 id 與 owner', () => {
  const tasks = loadTasks();
  assert.ok(tasks.length > 0);
  for (const t of tasks) {
    assert.match(t.id, /^TASK-\d+$/);
    assert.ok(t.owner, `${t.id} 缺 owner`);
    assert.ok(STATUSES.includes(t.status), `${t.id} 的 status "${t.status}" 不在合法清單裡`);
  }
});

test('真實資料每一個任務都印得出來,不會炸在缺欄位上', () => {
  for (const t of loadTasks()) {
    const out = formatTask(t).join('\n');
    assert.ok(out.startsWith(t.id));
  }
});
