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
import { readFileSync } from 'node:fs';
import { load as parseYaml } from 'js-yaml';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { auditTasks, collectAcIds, normalize, repoDeps } from './check-ac.mjs';
import { STATUSES } from './task.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const audit = (tasks, ids = [], deps = {}) => auditTasks(tasks, new Set(ids), deps);

/** 一筆合格的人工驗收紀錄。 */
const record = (over = {}) => ({
  at: '2026-09-01',
  who: 'zozo0526',
  commit: 'abc1234',
  saw: '建一筆後列表顯示名稱、active、2026/9/1',
  ...over,
});
/** 一條 manual 的 AC。 */
const manualAc = (over = {}) => ({
  id: 'AC-900',
  text: '無資料時顯示空狀態',
  verified_by: 'manual',
  verified_note: '黑箱 e2e 打不到畫面',
  ...over,
});
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

test('manual 不要求 e2e 覆蓋率(有 note、有紀錄就過)', () => {
  // CR-011 之前這條寫的是「done + manual + 有 note 就過」—— 那是當時的行為,
  // 加上 verified_record 的規則之後它應該紅,而它也真的紅了。原本要測的意圖是
  // 「manual 跳過覆蓋率」,所以補上紀錄,讓它繼續測那件事而不是測舊行為。
  const r = audit(
    [task({ owner: 'frontend', acceptance: [manualAc({ verified_record: record() })] })],
    [],
    { ownerPaths: () => ['frontend/src/'], changedSince: () => [] },
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
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

// ---------- CR-011:verified_record 的三條規則 ----------

test('規則 1:done + manual + 沒有 verified_record → 紅', () => {
  const r = audit([task({ owner: 'frontend', acceptance: [manualAc()] })]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /必須有 verified_record/);
});

test('規則 1 只對 done:review 期間沒有紀錄不算漂移', () => {
  for (const status of ['todo', 'in_progress', 'review']) {
    const r = audit([task({ status, owner: 'frontend', acceptance: [manualAc()] })]);
    assert.deepEqual(r.errors, [], `status=${status} 不該被要求紀錄`);
  }
});

test('規則 1:四個欄位任一為空 → 紅', () => {
  for (const field of ['at', 'who', 'commit', 'saw']) {
    for (const empty of [undefined, '', '   ']) {
      const r = audit([
        task({ owner: 'frontend', acceptance: [manualAc({ verified_record: record({ [field]: empty }) })] }),
      ]);
      assert.equal(r.errors.length, 1, `${field}=${JSON.stringify(empty)} 應該紅`);
      assert.match(r.errors[0], new RegExp(field));
    }
  }
});

test('規則 2:saw 抄一遍 text → 紅(標點與大小寫不算差異)', () => {
  for (const saw of ['無資料時顯示空狀態', '無資料時顯示空狀態。', ' 無資料時,顯示空狀態 ']) {
    const r = audit([
      task({ owner: 'frontend', acceptance: [manualAc({ verified_record: record({ saw }) })] }),
    ]);
    assert.equal(r.errors.length, 1, `saw=${saw} 應該紅`);
    assert.match(r.errors[0], /抄一遍/);
  }
});

test('規則 3:commit 解析不出來 → 紅', () => {
  const r = audit(
    [task({ owner: 'frontend', acceptance: [manualAc({ verified_record: record() })] })],
    [],
    { commitExists: () => false },
  );
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /解析不出來/);
});

test('規則 3:commit 之後 owner 路徑改過 → ⚠️ 而不是紅', () => {
  // 判紅的話,每次改 frontend/src/ 都要先請人重驗才能合併 —— 噪音的下場是被繞掉。
  const r = audit(
    [task({ owner: 'frontend', acceptance: [manualAc({ verified_record: record() })] })],
    [],
    { ownerPaths: () => ['frontend/src/'], changedSince: () => ['aaa1111', 'bbb2222'] },
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /快照/);
});

test('規則 3:commit 之後沒改過 → 乾淨通過', () => {
  const r = audit(
    [task({ owner: 'frontend', acceptance: [manualAc({ verified_record: record() })] })],
    [],
    { ownerPaths: () => ['frontend/src/'], changedSince: () => [] },
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('紀錄一旦存在,規則 2、3 不分狀態一律適用', () => {
  // 否則 review 期間可以先填一筆爛的,進 done 那天沒有人會再看它一眼。
  const r = audit([
    task({
      status: 'review',
      owner: 'frontend',
      acceptance: [manualAc({ verified_record: record({ saw: '無資料時顯示空狀態' }) })],
    }),
  ]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /抄一遍/);
});

test('normalize 只做到「去空白標點大小寫」為止', () => {
  assert.equal(normalize(' A、B。 '), 'ab');
  assert.equal(normalize('無資料時顯示空狀態'), normalize('無資料時,顯示空狀態!'));
  // 改兩個字就過得了 —— 這條規則的下限就是這樣,不假裝更高。
  assert.notEqual(normalize('無資料時顯示空狀態'), normalize('無資料時顯示空白狀態'));
});

test('repoDeps 真的問得到 git —— 注入假 deps 測不到指令有沒有寫對', () => {
  const deps = repoDeps();
  assert.equal(deps.commitExists('HEAD'), true);
  assert.equal(deps.commitExists('0000000000000000000000000000000000000000'), false);
  assert.equal(deps.commitExists('這不是一個 sha'), false);
  // HEAD 之後不可能有 commit
  assert.deepEqual(deps.changedSince('HEAD', ['scripts/']), []);
  // repo 的第一個 commit 之後,scripts/ 一定改過
  const first = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
    encoding: 'utf8',
    cwd: rootDir,
  }).trim().split('\n')[0];
  assert.ok(deps.changedSince(first, ['scripts/']).length > 0);
  assert.deepEqual(deps.ownerPaths('frontend'), ['frontend/src/']);
  assert.deepEqual(deps.ownerPaths('沒這個角色'), []);
});

// ---------- ADR-005:decisions 指標 ----------

test('decisions 指到不存在的檔案 → 紅', () => {
  const r = audit(
    [task({ decisions: ['contract/decisions/ADR-999-不存在.md'] })],
    [],
    { decisionExists: () => false },
  );
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /decisions 指到/);
});

test('decisions 指到存在的檔案 → 過;沒有 decisions 也不強制', () => {
  assert.deepEqual(audit([task({ decisions: ['README.md'] })], [], { decisionExists: () => true }).errors, []);
  assert.deepEqual(audit([task()]).errors, []);
});

test('repoDeps.decisionExists 問的是真的檔案系統', () => {
  const deps = repoDeps();
  assert.equal(deps.decisionExists('README.md'), true);
  assert.equal(deps.decisionExists('contract/tasks.yaml'), true);
  assert.equal(deps.decisionExists('這個檔案不存在.md'), false);
});

test('現況的 decisions 全部指得到 —— 這條檢查上線不需要遷移', () => {
  const tasks = parseYaml(readFileSync(join(rootDir, 'contract', 'tasks.yaml'), 'utf8')).tasks;
  const deps = repoDeps();
  for (const t of tasks) {
    for (const d of t.decisions ?? []) {
      assert.equal(deps.decisionExists(d), true, `${t.id} 的 ${d} 指不到`);
    }
  }
});

// ---------- tasks.yaml 的三個欄位不能打錯字 ----------

test('status 打錯字 → 紅', () => {
  const r = audit([task({ status: 'doen' })]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /status "doen" 不是合法值/);
  // 五個合法值都要過
  for (const status of STATUSES) {
    assert.deepEqual(audit([task({ status })]).errors, [], `${status} 應該合法`);
  }
});

test('缺 status → 紅(不給預設值)', () => {
  const t = task();
  delete t.status;
  assert.match(audit([t]).errors[0], /status "\(缺\)"/);
});

test('owner 打錯字 → 紅,而且說出它會關掉什麼', () => {
  // 這條不只是「查不到」:未知的 owner 讓 ownerPaths 回 [],
  // verified_record 的過期偵測就整條跳過 —— 一個錯字停用一個既有的守衛。
  const r = audit([task({ owner: 'backedn' })], [], { roles: ['backend', 'frontend'] });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /owner "backedn"/);
  assert.match(r.errors[0], /過期偵測/);
});

test('沒給 roles 就不驗 owner —— 但 repoDeps 一定會給', () => {
  assert.deepEqual(audit([task({ owner: 'backedn' })]).errors, []);
  assert.ok(repoDeps().roles.includes('backend'));
  assert.ok(repoDeps().roles.includes('qa'));
  assert.equal(repoDeps().roles.length, 5);
});

test('depends_on 指到不存在的任務 → 紅', () => {
  const tasks = [task({ id: 'TASK-900', depends_on: ['TASK-808'] })];
  assert.match(audit(tasks).errors[0], /depends_on 指到不存在的 TASK-808/);

  // 指得到就過(對照的是同一份 tasks.yaml 的 id,不需要外部來源)
  const ok = [task({ id: 'TASK-900' }), task({ id: 'TASK-901', depends_on: ['TASK-900'] })];
  assert.deepEqual(audit(ok).errors, []);
});

test('現況的 status / owner / depends_on 全部合法 —— 上線不需要遷移', () => {
  const tasks = parseYaml(readFileSync(join(rootDir, 'contract', 'tasks.yaml'), 'utf8')).tasks;
  const ids = new Set(tasks.map((t) => t.id));
  const roles = repoDeps().roles;
  for (const t of tasks) {
    assert.ok(STATUSES.includes(t.status), `${t.id} 的 status`);
    assert.ok(roles.includes(t.owner), `${t.id} 的 owner`);
    for (const d of t.depends_on ?? []) assert.ok(ids.has(d), `${t.id} 的 depends_on ${d}`);
  }
});
