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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { load as parseYaml } from 'js-yaml';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { auditTasks, collectAcIds, normalize, repoDeps } from './check-ac.mjs';
import {
  acceptanceStructure,
  collectCoverage,
  commitExistsInRepo,
  deriveStatus,
  loadTasksFrom,
} from './task-status.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// baseDone 預設給空集合:大多數測試不驗退步,不該每一條都收到「取不到 base ref」
// 的提醒。要驗退步的測試自己傳。
const audit = (tasks, ids = [], deps = {}) =>
  auditTasks(tasks, new Set(ids), { base: { done: new Set(), acceptance: new Map() }, ...deps });

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
// 沒有 status —— 那個欄位不得存在,fixture 帶著它會讓每一條測試都紅在同一個
// 地方,而不是紅在它各自要驗的那件事上。
const task = (over = {}) => ({ id: 'TASK-900', owner: 'backend', ...over });

test('done + e2e + 有測試 → 過', () => {
  const r = audit([task({ acceptance: [{ id: 'AC-900', verified_by: 'e2e' }] })], ['AC-900']);
  assert.deepEqual(r.errors, []);
});

test('e2e 的 AC 沒有測試 → 不是錯,只是還不算 done(ADR-007)', () => {
  // 推導之前這裡是紅的:「你標了 done,但沒有測試」。推導之後 done 不是宣告,
  // 所以缺測試的後果變成「這張任務算不到 done」,而不是「有人說謊」。
  // 真正該紅的那件事(本來 done、現在不是)由退步比對負責,見下面那組。
  const r = audit([task({ acceptance: [{ id: 'AC-900', text: 'x', verified_by: 'e2e' }] })]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows[0].status, 'open (0/1 AC)');
});

test('還沒有測試不是漂移', () => {
  // CR-006 對 CR-005 的修正是「壓力落在 done 那一刻」;ADR-007 之後那一刻是
  // 算出來的,所以缺測試只影響算出來的狀態,不產生錯誤。
  //
  // 上一版這裡窮舉 status 的值來證明它不影響結果 —— 那個窮舉現在本身就是違規,
  // 見下面的「不得存在」。
  const r = audit([task({ acceptance: [{ id: 'AC-900', text: 'x', verified_by: 'e2e' }] })]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows[0].status, 'open (0/1 AC)');
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

test('manual 的 AC 沒有紀錄 → 不是錯,只是還沒有證據(ADR-007)', () => {
  const r = audit([task({ owner: 'frontend', acceptance: [manualAc()] })]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows[0].status, 'open (0/1 AC)');
});

test('沒有紀錄不算漂移,只是還不算 done', () => {
  // ADR-007 最容易被誤解的一點:想標 done 只有一條路 —— 拿出證據。
  // 「手寫一個 done」這條路現在連寫都寫不得,見下面的「不得存在」。
  const r = audit([task({ owner: 'frontend', acceptance: [manualAc()] })]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows[0].status, 'open (0/1 AC)');
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

test('紀錄一旦存在,規則 2、3 一律適用', () => {
  // 否則可以先填一筆爛的,而那張任務永遠不會有人再看它一眼。
  const r = audit([
    task({
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

// ---------- tasks.yaml 的欄位不能打錯字 ----------
//
// status 那兩條在 ADR-007 之後刪掉了:沒有人讀那個欄位,architect 的下一張會把它
// 從 tasks.yaml 整個拿掉。owner 與 depends_on 與本決策無關,仍然有效。

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

test('現況的 owner / depends_on 全部合法', () => {
  const tasks = parseYaml(readFileSync(join(rootDir, 'contract', 'tasks.yaml'), 'utf8')).tasks;
  const ids = new Set(tasks.map((t) => t.id));
  const roles = repoDeps().roles;
  for (const t of tasks) {
    assert.ok(roles.includes(t.owner), `${t.id} 的 owner`);
    for (const d of t.depends_on ?? []) assert.ok(ids.has(d), `${t.id} 的 depends_on ${d}`);
  }
});

test('status 欄位不得存在 —— 沒有人讀的欄位不可以留著說謊', () => {
  // ADR-007 的最後一拍。第 4 拍拿掉那 11 個欄位之後,誰再貼一個回去都不會有人
  // 出聲,而它看起來像資訊。
  const r = audit([task({ status: 'done' })]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /有 status 欄位/);
  assert.match(r.errors[0], /pnpm task TASK-900/, '訊息要告訴人下一步去哪裡問');

  // 連「說對話」的也不行:狀態是算出來的,重複一份就是等著漂移。
  assert.equal(audit([task({ status: 'open' })]).errors.length, 1);

  assert.deepEqual(audit([task()]).errors, []);
});

test('現況的 tasks.yaml 一個 status 都沒有', () => {
  const tasks = loadTasksFrom();
  assert.ok(tasks.length > 0);
  for (const t of tasks) assert.equal(t.status, undefined, `${t.id} 還有 status`);
});

// ---------- ADR-007:退步比對 ----------

/** base 快照:哪些任務在 base 上是 done,以及它們當時的 AC 結構。 */
const base = (done, acceptance = []) => ({
  done: new Set(done),
  acceptance: new Map(acceptance.map(([id, acs]) => [id, acceptanceStructure({ acceptance: acs })])),
});

test('AC 結構沒變卻退出 done → 紅', () => {
  // 這是 ADR-007 唯一的陷阱:推導把「done 掉了測試」從一條紅線變成一次
  // 無聲的狀態變化。沒有這條比對,整個決策是淨損失。
  const acs = [{ id: 'AC-900', text: 'x', verified_by: 'e2e' }];
  const r = audit(
    [task({ id: 'TASK-900', acceptance: acs })],
    [], // 沒有測試涵蓋 AC-900 → 現在不是 done
    { base: base(['TASK-900'], [['TASK-900', acs]]) },
  );
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /AC 結構沒變/);
});

test('動了 AC 而退出 done → 提醒,不擋(否則會是個解不開的死結)', () => {
  // architect 在一張 done 的任務上新增一條 AC:那張 PR 若判紅,測試在 e2e/
  // (qa 的),而一張 PR 只能掛一個角色 —— 沒有任何一個人補得起來。
  // contract 變更由 CODEOWNERS 的人類 review 把關,這裡出聲就夠。
  const before = [{ id: 'AC-900', text: 'x', verified_by: 'e2e' }];
  const after = [...before, { id: 'AC-901', text: '新的一條', verified_by: 'e2e' }];
  const r = audit(
    [task({ id: 'TASK-900', acceptance: after })],
    ['AC-900'],
    { base: base(['TASK-900'], [['TASK-900', before]]) },
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /AC 結構也動了/);
});

test('任務被整個刪掉 → 提醒(那也是 contract 變更),訊息要說得出來', () => {
  const r = audit([], [], { base: base(['TASK-900'], [['TASK-900', []]]) });
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings[0], /整張任務被刪掉/);
});

test('沒有退步就不吭聲', () => {
  const acs = [{ id: 'AC-900', text: 'x', verified_by: 'e2e' }];
  const r = audit([task({ id: 'TASK-900', acceptance: acs })], ['AC-900'], {
    base: base(['TASK-900'], [['TASK-900', acs]]),
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('取不到 base ref → 出聲,但不擋', () => {
  // 安靜跳過等於這一輪沒有退步偵測,而沒有人會知道。判紅則會讓離線或
  // 淺 clone 的環境完全動不了 —— 那不是這支腳本能決定的事。
  const r = auditTasks([task()], new Set(), { base: null });
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /沒有做退步比對/);
  assert.match(r.warnings[0], /fetch-depth/);
});

test('blocked 由 proposed 的 CR 算出來,顯示在那張表上', () => {
  const r = audit([task({ id: 'TASK-900' })], ['AC-900'], {
    blockedBy: new Map([['TASK-900', ['CR-014']]]),
  });
  assert.equal(r.rows[0].status, 'blocked(CR-014)');
});

// ---------- 分流的判準是「結構」,不是「有沒有變」 ----------

test('只改 text 這類散文,不能讓真正的退步降級成提醒', () => {
  // 這是收緊的核心:改一個字元 + 拿掉測試,原本會從 ❌ 掉成 ⚠️。
  const before = [{ id: 'AC-900', text: '原本的敘述', verified_by: 'e2e' }];
  const after = [{ id: 'AC-900', text: '原本的敘述。', verified_by: 'e2e' }];
  const r = audit([task({ id: 'TASK-900', acceptance: after })], [], {
    base: base(['TASK-900'], [['TASK-900', before]]),
  });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /AC 結構沒變/);
});

test('verified_by 改了算結構變了 → ⚠️(否則是死結一的變種)', () => {
  // manual → e2e:id 集合一個字沒變,但證據規則變了,而那條 e2e 測試還不存在。
  // 判紅的話,改 verified_by 的是 architect、寫測試的是 qa —— 一張 PR 補不起來。
  const before = [{ id: 'AC-900', text: 'x', verified_by: 'manual' }];
  const after = [{ id: 'AC-900', text: 'x', verified_by: 'e2e' }];
  const r = audit([task({ id: 'TASK-900', acceptance: after })], [], {
    base: base(['TASK-900'], [['TASK-900', before]]),
  });
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings[0], /verified_by/);
});

test('verified_record 不算結構 —— 刪掉一筆紀錄就是證據消失,該紅', () => {
  // 補得回來的人跟刪掉的人是同一個角色(architect),不構成死結。
  const rec = { at: '2026-09-02', who: 'someone', commit: 'abc1234', saw: '看到某個東西' };
  const withRec = [{ ...manualAc(), verified_record: rec }];
  const withoutRec = [manualAc()];
  const r = audit([task({ id: 'TASK-900', owner: 'frontend', acceptance: withoutRec })], [], {
    base: base(['TASK-900'], [['TASK-900', withRec]]),
  });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /AC 結構沒變/);
});

test('AC 換順序不算結構變了 —— 集合一樣就是一樣', () => {
  const before = [
    { id: 'AC-900', text: 'a', verified_by: 'e2e' },
    { id: 'AC-901', text: 'b', verified_by: 'e2e' },
  ];
  const after = [before[1], before[0]];
  const r = audit([task({ id: 'TASK-900', acceptance: after })], ['AC-900'], {
    base: base(['TASK-900'], [['TASK-900', before]]),
  });
  assert.equal(r.errors.length, 1, '少了 AC-901 的測試 → 真的退步,不該因為換順序就降級');
});

// ---------- 接線:blockedByCrs 有沒有真的接進推導 ----------

test('CLI 真的把 blockedByCrs 接進推導 —— 用合成的任務與 CR', () => {
  // 這條線在現行資料上**沒有可觀察的效果**:11 張任務全是 done,而 done 蓋過
  // blocked(見 deriveStatus 的註解)。所以它被誤刪也不會有人出聲 —— 跟
  // pendingSummary 同一個形狀(CR-014),只是更難發現,因為連「輸出少一行」都沒有。
  //
  // 要測它就得餵一張算得出 open 的任務進去。實測:有接線是 blocked(CR-900),
  // 沒接線是 open (0/1 AC)。
  const dir = mkdtempSync(join(tmpdir(), 'ac-wire-'));
  try {
    mkdirSync(join(dir, 'crs'));
    writeFileSync(
      join(dir, 'tasks.yaml'),
      'tasks:\n' +
        '  - id: TASK-900\n    title: 合成的任務\n    owner: backend\n    depends_on: []\n' +
        '    acceptance:\n      - id: AC-900\n        text: 一條還沒有測試的驗收條件\n        verified_by: e2e\n',
    );
    writeFileSync(
      join(dir, 'crs', 'CR-900.md'),
      '# CR-900: 合成的\n\n- **提出者**: qa\n- **狀態**: proposed\n- **阻擋任務**: TASK-900\n\n## 問題\n略\n',
    );

    const out = execFileSync('node', [join(rootDir, 'scripts/check-ac.mjs')], {
      encoding: 'utf8',
      cwd: rootDir,
      env: { ...process.env, TASKS_FILE: join(dir, 'tasks.yaml'), CR_DIR: join(dir, 'crs') },
    });
    assert.match(out, /TASK-900\s+backend\s+blocked\(CR-900\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
