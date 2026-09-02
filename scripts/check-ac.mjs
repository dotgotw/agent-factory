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
 *
 * ## decisions 指標(ADR-005)
 *
 * 任務的 decisions: 列的是「這張任務的理由住在哪」。指到不存在的檔案 → 紅。
 * ADR-005 自己把這個記成一個洞:路徑相對 repo 根目錄,指錯不會有人出聲。
 * 判紅的理由與 CR-011 的 commit 欄位同一條:打錯字很便宜,而一個指不到東西的
 * 指標比沒有指標更糟 —— 它讓人以為理由有家。
 *
 * (這支的名字只說 AC,但它其實是 tasks.yaml 的整合性檢查。沒改名是因為
 *  CI 的 step 名與大家的肌肉記憶都綁著它,改名值得單獨一張 PR。)
 *
 * ## verified_record 的三條規則(CR-011 裁決)
 *
 *   1. status: done 且 verified_by: manual 的 AC,必須有 verified_record,
 *      且 at / who / commit / saw 四欄皆非空 —— 否則紅。
 *   2. saw 正規化後等於 text —— 紅。抄一遍 text 等於沒驗。
 *      這條很弱(抄完改兩個字就過),它擋的是最懶的那一種,不是造假。
 *   3. commit 解析不出來 —— 紅(打錯字,便宜);
 *      解析得出來但 owner 的路徑在其後改過 —— ⚠️。
 *
 * 規則 1 只對 done 強制「存在」;紀錄一旦存在,規則 2、3 一律適用 ——
 * 否則 review 期間可以先填一筆爛的,而進 done 那天沒有人會再看它一眼。
 *
 * ## 為什麼第 3 條是 ⚠️ 而不是紅
 *
 * verified_by: e2e 的證據每次 CI 重跑一遍,verified_by: manual 的紀錄只在寫下
 * 的那一刻為真 —— **manual 的 done 是快照,e2e 的 done 是活的**。commit 讓
 * 「過期」從看不見變成算得出來,但判紅的話,每次改 frontend/src/ 都要先請人
 * 重驗才能合併。人工複驗花的是人的時間,那個成本落在每一次改動上,而噪音的
 * 下場這個檔頭上面就寫過:被加 || true 繞掉,比不做還糟。
 *
 * ⚠️  第 3 條依賴完整的 git 歷史。CI 兩個 job 都是 fetch-depth: 0,成立。
 *     改成淺 clone 的話,「在其後改過」會因為歷史被截斷而算不出東西 ——
 *     不是紅,是**安靜地不再提醒**,而這正是本檔要防的那種單向漂移。
 *     解析不出 commit 那半會紅,過期那半不會。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { loadScope } from './role.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');

const VALID_VERIFIED_BY = ['e2e', 'manual'];
const RECORD_FIELDS = ['at', 'who', 'commit', 'saw'];

// ---------- 純函式(供 check-ac.test.mjs 使用) ----------

/**
 * 比對 saw 與 text 用的正規化。
 *
 * 去空白、去標點、轉小寫。故意到此為止 —— 這條規則擋的是「把 text 抄一遍」,
 * 不是造假(抄完改兩個字就過得了)。做得更聰明只會讓它的下限看起來比實際高。
 */
export function normalize(text) {
  return (text ?? '')
    .toLowerCase()
    .replace(/[\s、,，。.;;::!!??「」『』()()\[\]-]/g, '');
}

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
export function auditTasks(tasks, covered, deps = {}) {
  // 注入 git 與 scope 的查詢:這個函式因此仍然是純的,測試不必起一個真的 repo。
  const {
    commitExists = () => true,
    changedSince = () => [],
    ownerPaths = () => [],
    decisionExists = () => true,
  } = deps;

  const errors = [];
  const warnings = [];
  const rows = [];
  const declared = new Set();

  for (const task of tasks) {
    const acs = task.acceptance ?? [];
    const cells = [];

    // decisions: 指到的檔案必須存在。
    //
    // ADR-005 把這個欄位定義成「這張任務的理由住在哪」,並且自己記了這是個洞:
    // 路徑相對 repo 根目錄,指錯不會有人出聲。形狀跟 CR-011 的 commit 欄位一樣
    // —— 打錯字很便宜,所以判紅;而一個指不到東西的指標,比沒有指標更糟:
    // 它讓人以為理由有家。
    for (const path of task.decisions ?? []) {
      if (!decisionExists(path)) {
        errors.push(
          `${task.id}: decisions 指到 "${path}",但那個檔案不存在` +
            `(路徑相對 repo 根目錄)`,
        );
      }
    }

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
          continue;
        }

        const record = ac.verified_record;
        const where = `${task.id} / ${ac.id}`;

        // 規則 1:done 才強制「有紀錄」。壓力落在標 done 那一刻,跟覆蓋率同一個理由。
        if (!record) {
          if (task.status === 'done') {
            errors.push(
              `${where}: 標成 done 的 manual AC 必須有 verified_record` +
                `(${RECORD_FIELDS.join(' / ')})—— 沒有紀錄的人工驗收等於沒發生`,
            );
            cells.push(`${ac.id} ✗缺紀錄`);
          } else {
            cells.push(`${ac.id} manual`);
          }
          continue;
        }

        // 紀錄一旦存在,下面的規則不分狀態一律適用。
        const missing = RECORD_FIELDS.filter((f) => !String(record[f] ?? '').trim());
        if (missing.length > 0) {
          errors.push(`${where}: verified_record 的 ${missing.join('、')} 是空的`);
          cells.push(`${ac.id} ✗紀錄不全`);
          continue;
        }

        // 規則 2:saw 抄一遍 text 等於沒驗。
        if (normalize(record.saw) === normalize(ac.text)) {
          errors.push(
            `${where}: verified_record.saw 只是把 text 抄一遍 —— saw 要寫「看到什麼」,` +
              `不是複述驗收條件`,
          );
          cells.push(`${ac.id} ✗saw複述`);
          continue;
        }

        // 規則 3:commit 解析不出來是打錯字(紅);解析得出但之後改過是過期(⚠️)。
        const commit = String(record.commit).trim();
        if (!commitExists(commit)) {
          errors.push(`${where}: verified_record.commit "${commit}" 在這個 repo 裡解析不出來`);
          cells.push(`${ac.id} ✗commit`);
          continue;
        }

        const paths = ownerPaths(task.owner);
        const since = paths.length > 0 ? changedSince(commit, paths) : [];
        if (since.length > 0) {
          warnings.push(
            `${where}: 驗的是 ${commit},但 ${task.owner} 的路徑(${paths.join('、')})` +
              `之後有 ${since.length} 個 commit —— 這筆紀錄可能不再對應現在的程式碼。` +
              `manual 的 done 是快照,不是活的(CR-011)`,
          );
          cells.push(`${ac.id} manual ⚠️`);
        } else {
          cells.push(`${ac.id} manual ✓`);
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

/** 跑 git,失敗回傳 null(commit 不存在、或這裡不是 git repo)。 */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * auditTasks 的真實依賴:git 歷史與 scope.json。
 *
 * 獨立出來是為了讓測試打得到 —— 注入假的 deps 測得了規則,測不到「git 指令
 * 有沒有寫對」,而那正是最容易錯又最安靜的一段(參數錯 → 永遠回空 → 過期
 * 永遠偵測不到,而且是綠的)。
 *
 * owner 的路徑直接讀 scope.json:那份檔案已經是「這個角色的工作放在哪裡」的
 * 唯一真相,不要在 tasks.yaml 再宣告一次(CR-011 裁決)。不含 _everyone ——
 * change-requests/ 改了不代表實作變了。
 */
export function repoDeps(scope = loadScope()) {
  return {
    ownerPaths: (owner) => scope.roles[owner]?.allow ?? [],
    decisionExists: (path) => existsSync(join(rootDir, path)),
    commitExists: (sha) => git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]) !== null,
    changedSince: (sha, paths) =>
      (git(['log', '--format=%h', `${sha}..HEAD`, '--', ...paths]) ?? '')
        .split('\n')
        .filter(Boolean),
  };
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

  const { rows, errors, warnings } = auditTasks(tasks, covered, repoDeps());

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
