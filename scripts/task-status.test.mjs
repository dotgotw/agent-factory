/**
 * scripts/task-status.test.mjs —— 狀態推導的測試(ADR-007)
 *
 * 這份推導同時是 check:ac 的判斷依據與 pnpm tasks 的顯示,所以它錯了會同時
 * 錯兩邊,而且方向一致 —— 一致的錯最難被發現。
 *
 * 跑法: pnpm test:scripts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUSES,
  acEvidence,
  commitExistsInRepo,
  deriveStatus,
  doneSetAt,
  formatStatus,
  loadTasksFrom,
  collectCoverage,
} from './task-status.mjs';

const e2eAc = (id = 'AC-900') => ({ id, text: '某條條件', verified_by: 'e2e' });
const manualAc = (over = {}) => ({
  id: 'AC-901',
  text: '無資料時顯示空狀態',
  verified_by: 'manual',
  verified_note: '打不到畫面',
  ...over,
});
const record = (over = {}) => ({
  at: '2026-09-02',
  who: 'someone',
  commit: 'abc1234',
  saw: '剛啟動時列表位置顯示斜體的「尚無專案」',
  ...over,
});
const derive = (task, over = {}) =>
  deriveStatus(task, { covered: new Set(), commitExists: () => true, ...over });

test('三個值就是三個值', () => {
  assert.deepEqual(STATUSES, ['open', 'blocked', 'done']);
});

test('e2e 的證據是「測試裡出現這個編號」', () => {
  const task = { id: 'T', acceptance: [e2eAc('AC-900')] };
  assert.equal(derive(task).status, 'open');
  assert.equal(derive(task, { covered: new Set(['AC-900']) }).status, 'done');
});

test('manual 的證據是一筆合格的 verified_record', () => {
  const withRecord = (rec) => ({ id: 'T', acceptance: [manualAc({ verified_record: rec })] });

  assert.equal(derive({ id: 'T', acceptance: [manualAc()] }).status, 'open', '沒紀錄 = 還沒有證據');
  assert.equal(derive(withRecord(record())).status, 'done');

  // CR-011 的三條:四欄位、saw 不複述 text、commit 解析得出
  assert.equal(derive(withRecord(record({ who: '' }))).status, 'open');
  assert.equal(derive(withRecord(record({ saw: '無資料時顯示空狀態' }))).status, 'open');
  assert.equal(derive(withRecord(record()), { commitExists: () => false }).status, 'open');
});

test('壞掉的宣告會回報 problem;還沒有證據不會', () => {
  // 這個分界是 ADR-007 的核心:缺證據 = 還不是 done(不是錯),
  // 壞掉的宣告 = 有人打錯字或抄襲(是錯)。
  assert.equal(acEvidence(e2eAc(), { covered: new Set() }).problem, null);
  assert.equal(acEvidence(manualAc(), {}).problem, null);
  assert.match(acEvidence({ id: 'AC-1', text: 'x' }, {}).problem, /缺少 verified_by/);
  assert.match(acEvidence({ id: 'AC-1', text: 'x', verified_by: 'none' }, {}).problem, /非法/);
  assert.match(
    acEvidence(manualAc({ verified_note: '', verified_record: record() }), {}).problem,
    /verified_note/,
  );
});

test('一條都沒證據到全部有證據,open 會把差多遠說出來', () => {
  const task = { id: 'T', acceptance: [e2eAc('AC-1'), e2eAc('AC-2'), e2eAc('AC-3')] };
  assert.equal(formatStatus(derive(task, { covered: new Set(['AC-1', 'AC-2']) })), 'open (2/3 AC)');
  assert.equal(formatStatus(derive(task, { covered: new Set(['AC-1', 'AC-2', 'AC-3']) })), 'done');
});

test('沒有 AC 的任務不是 done —— 空集合不該當成保證', () => {
  const d = derive({ id: 'T', acceptance: [] });
  assert.equal(d.status, 'open');
  assert.equal(formatStatus(d), 'open (0/0 AC)');
});

test('proposed 的 CR 指名它就是 blocked,而且蓋過 done', () => {
  // 判斷:兩者同時成立時 blocked 勝出。理由是可行動性 —— 有人正在提議改這張
  // 任務的條件,那件事比「舊條件都滿足了」更需要被看見。ADR-007 沒有指定,
  // 這是 infra 的選擇,已回報 architect。
  const task = { id: 'T', acceptance: [e2eAc('AC-1')] };
  const d = derive(task, { covered: new Set(['AC-1']), blockedBy: ['CR-014'] });
  assert.equal(d.status, 'blocked');
  assert.equal(formatStatus(d), 'blocked(CR-014)');
});

// ---------- 真實 repo ----------

test('doneSetAt 問得到 git;取不到的 ref 回 null 而不是空集合', () => {
  // 空集合與 null 差很多:空集合會讓退步比對「什麼都沒發現」而靜靜通過,
  // null 讓呼叫端知道這一輪沒有基準可比。
  const here = doneSetAt('HEAD');
  assert.ok(here instanceof Set);
  assert.ok(here.size > 0);
  assert.equal(doneSetAt('沒有這個ref'), null);
});

test('HEAD 上算出來的 done,與直接對工作區算的一致', () => {
  const covered = collectCoverage();
  const now = new Set(
    loadTasksFrom()
      .filter((t) => deriveStatus(t, { covered, commitExists: commitExistsInRepo }).status === 'done')
      .map((t) => t.id),
  );
  assert.deepEqual([...doneSetAt('HEAD')].sort(), [...now].sort());
});
