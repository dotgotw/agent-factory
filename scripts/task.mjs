#!/usr/bin/env node
/**
 * scripts/task.mjs —— 任務資料的查詢介面(ADR-005)
 *
 *   pnpm task TASK-042                        一個任務的完整內容
 *   pnpm tasks --owner backend --status open  條件查詢
 *   pnpm tasks --ac AC-017                    反查某條 AC 屬於哪個任務
 *
 * ## 為什麼有這支
 *
 * contract/tasks.yaml 是唯一真相,但**不該被 agent 整支讀**:一個角色需要的
 * 是其中一列,讀整支要付全部的 token。這個 repo 已經解對過一次同樣的問題 ——
 * scope.json 從來沒有變成 token 問題,不是因為它小,是因為沒有人叫 agent 讀它,
 * 它有 pnpm role。這支是 tasks.yaml 的那個 pnpm role。
 *
 * 腳本整支讀不花 token,agent 整支讀才花。所以 check:ac / check:cr 照舊整支讀。
 *
 * ## 兩條規格上的線
 *
 * **decisions: 只印路徑,不印內容。** 印了就等於把省下來的 token 又花回去,
 * 而且會讓「要不要讀理由」這個判斷從 agent 手上被拿走。指標在這裡,要不要跳
 * 由讀的人決定 —— scripts/task.test.mjs 有一條測試盯著這件事。
 *
 * **找不到就明確失敗,不靜默回空。** 打錯的 id、不存在的 owner、拼錯的旗標
 * 一律報錯並列出可用值(exit 2)。這是 ADR-006 那條線的 CLI 版本:未宣告的
 * 輸入不得被靜默吞掉。
 *
 * 「條件合法但沒有東西符合」不是錯誤 —— 那是一個真實的答案(exit 0)。
 * 兩者要分得開:把空結果當錯誤,會逼人用不精確的查詢去避開紅字。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { loadScope } from './role.mjs';
import { blockedByCrs } from './check-cr.mjs';
import {
  STATUSES,
  collectCoverage,
  commitExistsInRepo,
  deriveStatus,
  formatStatus,
} from './task-status.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 合法的狀態值。ADR-007 之後這三個是**算出來的**,不是 tasks.yaml 裡寫的:
 *
 *   done     每一條 AC 都有證據
 *   blocked  有一份 proposed 的 CR 指名它
 *   open     其餘,顯示成 open (2/3 AC)
 *
 * 舊的五個值裡,todo / in_progress / review 不再是合法的查詢條件 —— 它們是
 * 意圖不是保證,ADR-007 把它們移出 contract。想知道「誰正在做」,看開著的
 * PR 上的 agent:<role> label,那個訊號有人維護。
 *
 * 清單與推導都住在 task-status.mjs,這裡只是轉出去給 CLI 用。
 */
export { STATUSES } from './task-status.mjs';

const FLAGS = ['--owner', '--status', '--ac'];

export function loadTasks(file = join(rootDir, 'contract', 'tasks.yaml')) {
  return parseYaml(readFileSync(file, 'utf8')).tasks ?? [];
}

/**
 * 解析命令列。回傳 { mode, id, filters, errors }。
 * 錯誤不丟例外 —— 一次把所有問題收齊再印,免得使用者修一個跑一次。
 */
export function parseArgs(argv, { roles = [], statuses = STATUSES } = {}) {
  const [mode, ...rest] = argv;
  const errors = [];
  const filters = {};
  let id = null;

  if (mode === 'one') {
    if (rest.length === 0) errors.push('要查哪一個任務?用法: pnpm task TASK-042');
    else if (rest.length > 1) errors.push(`一次只查一個任務,但收到 ${rest.length} 個參數`);
    else if (rest[0].startsWith('-')) errors.push(`pnpm task 不吃旗標;條件查詢請用 pnpm tasks`);
    else id = rest[0];
    return { mode: 'one', id, filters, errors };
  }

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('-')) {
      errors.push(`不認得的參數 "${arg}" —— 條件要用旗標,例如 --owner ${arg}`);
      continue;
    }
    if (!FLAGS.includes(arg)) {
      errors.push(`不認得的旗標 "${arg}"。可用: ${FLAGS.join('、')}`);
      // 把它的值一起吃掉。否則 `--onwer backend` 會報兩次(旗標錯 + backend 是
      // 孤兒參數),而使用者只打錯了一個字。
      if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('-')) i++;
      continue;
    }
    const value = rest[++i];
    if (value === undefined || value.startsWith('-')) {
      errors.push(`${arg} 後面要接一個值`);
      continue;
    }
    filters[arg.slice(2)] = value;
  }

  if (filters.owner && roles.length > 0 && !roles.includes(filters.owner)) {
    errors.push(`不認得的 owner "${filters.owner}"。可用: ${roles.join('、')}`);
  }
  if (filters.status && !statuses.includes(filters.status)) {
    errors.push(`不認得的 status "${filters.status}"。可用: ${statuses.join('、')}`);
  }

  return { mode: 'list', id, filters, errors };
}

/**
 * 把算出來的狀態掛到每張任務上。
 *
 * 之後的純函式只讀 task.derived —— 推導的規則留在 task-status.mjs 一份,
 * 這裡不重算,測試也不必為了測顯示而去準備 git 與 e2e 的環境。
 */
export function withDerived(tasks, { covered, commitExists, blockedBy = new Map() } = {}) {
  return tasks.map((task) => ({
    ...task,
    derived: deriveStatus(task, { covered, commitExists, blockedBy: blockedBy.get(task.id) ?? [] }),
  }));
}

export function findTask(tasks, id) {
  return tasks.find((t) => t.id === id) ?? null;
}

/** 某條 AC 屬於哪個任務。回傳 { task, ac } 或 null。 */
export function findAc(tasks, acId) {
  for (const task of tasks) {
    const ac = (task.acceptance ?? []).find((a) => a.id === acId);
    if (ac) return { task, ac };
  }
  return null;
}

export function filterTasks(tasks, filters) {
  return tasks.filter((t) => {
    if (filters.owner && t.owner !== filters.owner) return false;
    if (filters.status && t.derived?.status !== filters.status) return false;
    if (filters.ac && !(t.acceptance ?? []).some((a) => a.id === filters.ac)) return false;
    return true;
  });
}

/** 一條 AC 的細節,縮排交給呼叫端。 */
function formatAc(ac) {
  const out = [`${ac.id}  ${ac.text ?? ''}`];
  const by = ac.verified_by ?? '(未宣告)';
  out.push(`        驗收方式: ${by}${ac.verified_note ? ` —— ${ac.verified_note}` : ''}`);
  const rec = ac.verified_record;
  if (rec) {
    out.push(`        紀錄: ${rec.at} / ${rec.who} / ${rec.commit}`);
    out.push(`              看到: ${rec.saw}`);
  }
  return out;
}

/**
 * 一個任務的完整內容。
 *
 * decisions 只列路徑 —— 不讀那些檔案,更不印它們的內容(ADR-005)。
 */
export function formatTask(task) {
  const out = [];
  out.push(`${task.id}  ${task.title ?? ''}`);
  out.push(
    `  owner: ${task.owner ?? '(未指定)'}    status: ${task.derived ? formatStatus(task.derived) : '(未算)'}` +
      `    depends_on: ${(task.depends_on ?? []).join('、') || '(無)'}`,
  );
  if (task.derived?.status === 'blocked') {
    out.push(`  卡在: ${task.derived.blockedBy.join('、')}(proposed 的 CR)`);
  }
  if (task.blocked_reason) out.push(`  卡在: ${task.blocked_reason}`);

  if ((task.contract_refs ?? []).length > 0) {
    out.push('', '  contract:');
    for (const ref of task.contract_refs) out.push(`    ${ref}`);
  }

  const acs = task.acceptance ?? [];
  out.push('', `  驗收條件(${acs.length}):`);
  if (acs.length === 0) out.push('    (無)');
  for (const ac of acs) {
    for (const line of formatAc(ac)) out.push(`    ${line}`);
  }

  const decisions = task.decisions ?? [];
  out.push('', '  理由住在:');
  if (decisions.length === 0) {
    out.push('    (沒有登記) —— 若這張任務有非顯而易見的取捨,它應該有個家');
  } else {
    for (const d of decisions) out.push(`    ${d}`);
    out.push('    (只給路徑;要不要讀由你決定 —— 印內容就等於把省下的 token 又花掉)');
  }
  return out;
}

/** 查詢結果的一覽。每個任務一行,細節請用 pnpm task。 */
export function formatList(tasks, filters, all) {
  const out = [];
  const cond = Object.entries(filters)
    .map(([k, v]) => `${k}=${v}`)
    .join('  ');
  out.push(`條件: ${cond || '(無,列出全部)'}`);
  out.push('');

  if (tasks.length === 0) {
    // 條件合法但沒有東西符合 —— 這是答案,不是錯誤。
    out.push('沒有符合條件的任務。');
    if (filters.ac) {
      const hit = findAc(all, filters.ac);
      if (hit) {
        out.push(
          `(${filters.ac} 存在,屬於 ${hit.task.id} —— owner: ${hit.task.owner}、` +
            `status: ${hit.task.derived ? formatStatus(hit.task.derived) : '(未算)'},` +
            `但不符合你給的其他條件)`,
        );
      }
    }
    return out;
  }

  const w = Math.max(...tasks.map((t) => t.id.length), 8);
  for (const t of tasks) {
    const acs = (t.acceptance ?? []).map((a) => a.id).join(' ') || '(無 AC)';
    out.push(
      `${t.id.padEnd(w)}  ${(t.derived ? formatStatus(t.derived) : '').padEnd(16)}${String(t.owner ?? '').padEnd(9)}` +
        `${t.title ?? ''}`,
    );
    out.push(`${''.padEnd(w)}  ${acs}`);
  }
  out.push('', `${tasks.length} 個任務。完整內容: pnpm task ${tasks[0].id}`);
  return out;
}

// --- CLI ---
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const tasks = withDerived(loadTasks(), {
    covered: collectCoverage(),
    commitExists: commitExistsInRepo,
    blockedBy: blockedByCrs(),
  });
  const roles = Object.keys(loadScope().roles);
  const { mode, id, filters, errors } = parseArgs(process.argv.slice(2), { roles });

  const die = (lines) => {
    for (const l of lines) console.error(l);
    process.exit(2);
  };

  if (errors.length > 0) die(errors.map((e) => `❌ ${e}`));

  if (mode === 'one') {
    const task = findTask(tasks, id);
    if (!task) {
      die([
        `❌ 找不到 ${id}。`,
        `   可用的 id: ${tasks.map((t) => t.id).join('、')}`,
      ]);
    }
    console.log(formatTask(task).join('\n'));
    process.exit(0);
  }

  if (filters.ac && !findAc(tasks, filters.ac)) {
    die([
      `❌ 找不到 ${filters.ac}。`,
      `   可用的 AC: ${tasks.flatMap((t) => (t.acceptance ?? []).map((a) => a.id)).join('、')}`,
    ]);
  }

  console.log(formatList(filterTasks(tasks, filters), filters, tasks).join('\n'));
}
