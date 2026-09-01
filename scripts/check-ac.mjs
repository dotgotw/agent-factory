#!/usr/bin/env node
/**
 * scripts/check-ac.mjs
 *
 * 「每一條 AC 都有測試」的檢查(CR-005,規格由 CR-006 裁決定死)。
 *
 * 這種漂移跟別的不一樣:少寫一條測試不會讓 CI 變紅,**它讓 CI 變得更綠**
 * —— 沒有測試的 AC 不會失敗。所以它是單向的,只會越漏越多,不會自己修正。
 * verify 裡的其他檢查都在防「壞掉」,這一支在防「悄悄變空」。
 *
 * 規則(CR-006 裁決的那張表,一字不改):
 *
 *   | 觸發時機          | 只對 status: done 的任務強制 AC 覆蓋率
 *   | verified_by: e2e  | e2e/ 裡必須找得到該 AC 編號,否則紅
 *   | verified_by: manual | 跳過覆蓋率,但必須有非空的 verified_note,否則紅
 *   | 欄位缺漏          | 任何 AC 沒有 verified_by 就紅(不給預設值)
 *
 * 「只對 done 強制」是裁決對 CR-005 提案的修正,重要的是它把壓力放在對的
 * 時刻:**要標 done,先讓 AC 有測試。** 對 todo 的任務要求測試會製造噪音,
 * 而噪音的下場是被人加 `|| true` 繞掉,比不做還糟。
 *
 * 刻意沒有 verified_by: none —— 零成本的逃生門會把單向漂移制度化。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { load as parseYaml } from 'js-yaml';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');

const VALID_VERIFIED_BY = ['e2e', 'manual'];

// ---------- 純函式(供 check-ac.test.mjs 使用) ----------

/** 測試檔文字裡出現過的 AC 編號。 */
export function collectAcIds(specText) {
  // (?!\w) 讓 "AC-0XX" 不會被截成 "AC-0" —— 截出來的半個編號會變成一則
  // 假的「這個 AC 不存在」提醒,而提醒一旦不可信就沒有人會讀。
  return new Set(specText.match(/AC-\d+(?!\w)/g) ?? []);
}

/**
 * 比對 tasks.yaml 與測試覆蓋。回傳 { rows, errors, warnings }。
 *
 * rows 是給人看的那張表 —— CR-005 就是靠一段臨時腳本印出這張表才發現
 * TASK-003 的兩條 AC 從來沒被驗過。檢查綠的時候它也該印,不然沒有人會知道
 * 這支腳本到底在看什麼。
 */
export function auditTasks(tasks, covered) {
  const errors = [];
  const warnings = [];
  const rows = [];
  const declared = new Set();

  for (const task of tasks) {
    const acs = task.acceptance ?? [];
    const cells = [];

    for (const ac of acs) {
      declared.add(ac.id);
      const by = ac.verified_by;

      if (!by) {
        errors.push(`${task.id} / ${ac.id}: 缺少 verified_by(不給預設值,見 CR-006)`);
        cells.push(`${ac.id} ✗缺欄位`);
        continue;
      }
      if (!VALID_VERIFIED_BY.includes(by)) {
        errors.push(
          `${task.id} / ${ac.id}: verified_by "${by}" 非法,必須是 ${VALID_VERIFIED_BY.join(' | ')}` +
            `(刻意沒有 none)`,
        );
        cells.push(`${ac.id} ✗非法值`);
        continue;
      }

      if (by === 'manual') {
        const note = (ac.verified_note ?? '').trim();
        if (!note) {
          errors.push(
            `${task.id} / ${ac.id}: verified_by 是 manual,必須用 verified_note 寫明` +
              `為什麼自動化測不到 —— 「還沒空寫」不成立,那種情況任務該留在 review`,
          );
          cells.push(`${ac.id} ✗缺理由`);
        } else {
          cells.push(`${ac.id} manual`);
        }
        continue;
      }

      // verified_by: e2e —— 只在 done 這一刻強制。
      const hit = covered.has(ac.id);
      if (task.status === 'done' && !hit) {
        errors.push(
          `${task.id} / ${ac.id}: 任務標成 done,但 e2e/ 裡找不到這個編號。` +
            `要標 done,先讓 AC 有測試`,
        );
        cells.push(`${ac.id} ✗無測試`);
      } else {
        cells.push(`${ac.id} ${hit ? '✓' : '—'}`);
      }
    }

    rows.push({
      id: task.id,
      owner: task.owner ?? '',
      status: task.status ?? '',
      cells,
    });
  }

  // 反方向:測試引用了 tasks.yaml 沒有的編號。
  //
  // 不在 CR-006 的規格裡,所以只提醒不擋 —— 但它是真的漂移(AC 被改名或刪掉,
  // 測試留在原地繼續綠),而且今天是乾淨的,提醒不會變成噪音。
  for (const id of covered) {
    if (!declared.has(id)) {
      warnings.push(`e2e/ 引用了 ${id},但 tasks.yaml 沒有這條 AC —— 是不是被改名或刪掉了?`);
    }
  }

  return { rows, errors, warnings };
}

// ---------- 主流程 ----------

function main() {
  const tasksPath = join(rootDir, 'contract', 'tasks.yaml');
  const e2eDir = join(rootDir, 'e2e');

  let tasks;
  try {
    tasks = parseYaml(readFileSync(tasksPath, 'utf8')).tasks ?? [];
  } catch (err) {
    console.error(`❌ 無法解析 ${tasksPath}: ${err.message}`);
    process.exit(2);
  }

  const specFiles = readdirSync(e2eDir).filter((f) => f.endsWith('.spec.ts'));
  if (specFiles.length === 0) {
    // 一個測試檔都沒有,卻有 done 的任務 —— 那不是「乾淨」,是檢查失去了對象。
    console.error(`❌ ${e2eDir} 裡沒有任何 *.spec.ts,無法判斷 AC 覆蓋。`);
    process.exit(2);
  }
  const covered = collectAcIds(
    specFiles.map((f) => readFileSync(join(e2eDir, f), 'utf8')).join('\n'),
  );

  const { rows, errors, warnings } = auditTasks(tasks, covered);

  console.log(`檢查 ${tasks.length} 個任務、${specFiles.length} 個測試檔`);
  console.log('');
  const w = { id: 10, owner: 9, status: 8 };
  console.log(`${'任務'.padEnd(w.id)}${'owner'.padEnd(w.owner)}${'status'.padEnd(w.status)}AC`);
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(w.id)}${r.owner.padEnd(w.owner)}${r.status.padEnd(w.status)}${r.cells.join('  ')}`,
    );
  }

  if (warnings.length > 0) {
    console.log(`\n⚠️  ${warnings.length} 項提醒:`);
    for (const x of warnings) console.log(`   - ${x}`);
  }

  if (errors.length > 0) {
    console.error(`\n❌ ${errors.length} 項不一致:`);
    for (const e of errors) console.error(`   - ${e}`);
    console.error('\n   規格見 change-requests/CR-006.md 的裁決。');
    process.exit(1);
  }

  console.log('\n✅ AC 覆蓋與宣告一致');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
