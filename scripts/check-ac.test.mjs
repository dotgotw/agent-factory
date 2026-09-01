/**
 * scripts/check-ac.test.mjs
 *
 * CR-006 裁決那張規格表的逐條測試。
 *
 * 這支檢查防的是「單向漂移」——少一條測試不會讓 CI 變紅,只會讓它更綠。
 * 所以它自己壞掉的時候也不會有人發現:一個永遠回傳 0 個錯誤的 check:ac,
 * 從外面看跟「一切正常」長得一模一樣。下面每一條都必須真的紅過。
 *
 * 跑法: pnpm test:scripts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { auditTasks, collectAcIds } from './check-ac.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const audit = (tasks, ids = []) => auditTasks(tasks, new Set(ids));
const task = (over = {}) => ({ id: 'TASK-900', owner: 'backend', status: 'done', ...over });

test('done + e2e + 有測試 → 過', () => {
  const r = audit([task({ acceptance: [{ id: 'AC-900', verified_by: 'e2e' }] })], ['AC-900']);
  assert.deepEqual(r.errors, []);
});

test('done + e2e + 沒測試 → 紅', () => {
  const r = audit([task({ acceptance: [{ id: 'AC-900', verified_by: 'e2e' }] })]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /要標 done,先讓 AC 有測試/);
});

test('todo + e2e + 沒測試 → 過(還沒開工不是漂移)', () => {
  // CR-006 對 CR-005 提案的修正:壓力落在 done 那一刻,不是開工前。
  for (const status of ['todo', 'in_progress', 'blocked', 'review']) {
    const r = audit([task({ status, acceptance: [{ id: 'AC-900', verified_by: 'e2e' }] })]);
    assert.deepEqual(r.errors, [], `status=${status} 不該被要求覆蓋率`);
  }
});

test('manual + 有 verified_note → 過,且不要求測試', () => {
  const r = audit([
    task({ acceptance: [{ id: 'AC-900', verified_by: 'manual', verified_note: '打不到畫面' }] }),
  ]);
  assert.deepEqual(r.errors, []);
});

test('manual + 沒有 verified_note → 紅', () => {
  for (const note of [undefined, '', '   ']) {
    const r = audit([task({ acceptance: [{ id: 'AC-900', verified_by: 'manual', verified_note: note }] })]);
    assert.equal(r.errors.length, 1, `verified_note=${JSON.stringify(note)} 應該紅`);
    assert.match(r.errors[0], /寫明/);
  }
});

test('缺 verified_by → 紅(不給預設值)', () => {
  const r = audit([task({ acceptance: [{ id: 'AC-900' }] })]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /缺少 verified_by/);
});

test('verified_by: none → 紅(那個逃生門是刻意不存在的)', () => {
  const r = audit([task({ acceptance: [{ id: 'AC-900', verified_by: 'none' }] })]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /非法/);
});

test('測試引用了不存在的 AC → 提醒,不擋', () => {
  const r = audit([task({ acceptance: [{ id: 'AC-900', verified_by: 'e2e' }] })], ['AC-900', 'AC-999']);
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /AC-999/);
});

test('collectAcIds 認得測試檔裡的編號,且不截半個編號', () => {
  const ids = collectAcIds("it('AC-001: 建立', ...); // 另見 AC-012\nAC-001 重複");
  assert.deepEqual([...ids].sort(), ['AC-001', 'AC-012']);
  // "AC-0XX" 截成 "AC-0" 會變成一則假提醒。
  assert.deepEqual([...collectAcIds('AC-0XX 是打錯的編號')], []);
});

test('現況是綠的 —— 這個檢查在乾淨的狀態上線(CR-006 裁決的預期)', () => {
  const out = execFileSync('node', [join(rootDir, 'scripts/check-ac.mjs')], {
    encoding: 'utf8',
    cwd: rootDir,
  });
  assert.match(out, /✅ AC 覆蓋與宣告一致/);
  // 裁決預言的那三個 done 任務,覆蓋率都是滿的。
  for (const id of ['TASK-001', 'TASK-002', 'TASK-006']) assert.match(out, new RegExp(id));
});
