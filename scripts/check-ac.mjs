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
 * ## tasks.yaml 的欄位
 *
 *   status                          **不得存在**(ADR-007:狀態是算出來的)
 *   owner: backend → backedn        打錯字會靜默通過,見下,最嚴重的一個
 *   depends_on: [TASK-808]          依賴指向不存在的任務,沒有人出聲
 *
 * owner 那個會**把既有的檢查無聲停用**:下面 verified_record 的過期偵測是
 * `ownerPaths(task.owner)` 回空就整條跳過,而未知的 owner 正好回空。一個錯字
 * 就能讓 CR-011 裁決寫進去的守衛不再出聲,且沒有任何紅線提醒。
 *
 * 三條都判紅,理由與 decisions 指標同一條:打錯字很便宜。
 *
 * 合法值一律**引用既有的來源,不新寫一份**:status 從 task.mjs import,
 * owner 讀 scope.json(本檔本來就在讀),depends_on 對照同一份 tasks.yaml 的
 * id 集合。前例是 check-scope.mjs import role.mjs 的 classifyPath —— 兩邊各寫
 * 一份,遲早會出現一邊放行、另一邊擋下的組合。
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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { loadScope } from './role.mjs';
import { blockedByCrs } from './check-cr.mjs';
import {
  acEvidence,
  collectAcIds,
  collectCoverage,
  commitExistsInRepo,
  deriveStatus,
  acceptanceStructure,
  snapshotAt,
  formatStatus,
  git,
} from './task-status.mjs';

export { collectAcIds, normalize } from './task-status.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');


// ---------- 純函式(供 check-ac.test.mjs 使用) ----------

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
    // null = 呼叫端沒給,不驗 owner。repoDeps() 一定會給;沒給而靜默跳過的風險
    // 由「repoDeps 真的問得到 scope.json」那條測試守著。
    roles = null,
    // 哪些任務被 proposed 的 CR 擋著。Map(taskId -> [CR id])。
    blockedBy = new Map(),
    // base ref 的快照 { done, acceptance };null = 取不到那個 ref(見退步比對)。
    base = null,
    baseRef = 'origin/main',
  } = deps;

  const errors = [];
  const warnings = [];
  const rows = [];
  const declared = new Set();
  const doneNow = new Set();

  const taskIds = new Set(tasks.map((t) => t.id));

  for (const task of tasks) {
    const acs = task.acceptance ?? [];
    const cells = [];

    // status 不得存在(ADR-007 第 5 拍)。
    //
    // 欄位拿掉之後,誰再貼一個回去都不會有人出聲 —— 那是一句沒有人讀的謊,
    // 而且它看起來像資訊。連「說對話」的也不行:狀態是算出來的,重複一份就是
    // 等著漂移,而漂移的方向永遠是「寫的人忘了改」。
    if (task.status !== undefined) {
      errors.push(
        `${task.id}: 有 status 欄位。狀態是算出來的(ADR-007),tasks.yaml 不再宣告它 —— ` +
          `想知道現在算成什麼,跑 pnpm task ${task.id}`,
      );
    }

    // 另外兩個欄位的錯字檢查。
    if (roles && !roles.includes(task.owner)) {
      errors.push(
        `${task.id}: owner "${task.owner ?? '(缺)'}" 不是 scope.json 裡的角色` +
          `(${roles.join('、')})—— 未知的 owner 會讓 verified_record 的過期偵測靜默關掉`,
      );
    }
    for (const dep of task.depends_on ?? []) {
      if (!taskIds.has(dep)) {
        errors.push(`${task.id}: depends_on 指到不存在的 ${dep}`);
      }
    }

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

    // 每條 AC 有沒有證據。規則住在 task-status.mjs —— pnpm tasks 用的是同一份,
    // 不是兩份(前例:check-scope.mjs import role.mjs 的 classifyPath)。
    for (const ac of acs) {
      declared.add(ac.id);
      const { ok, problem } = acEvidence(ac, { covered, commitExists });

      if (problem) {
        // 宣告本身壞掉:缺欄位、非法值、saw 抄一遍、commit 打錯字。判紅。
        //
        // 「還沒有證據」不在這裡 —— 那不是錯誤,只是還不是 done。這條線是
        // ADR-007 的核心:狀態用算的之後,缺證據的後果是「不算 done」,
        // 而不是「有人說謊」。壞掉的宣告仍然是說謊。
        errors.push(`${task.id} / ${ac.id}: ${problem}`);
        cells.push(`${ac.id} ✗`);
        continue;
      }

      if (ac.verified_by === 'e2e') {
        cells.push(`${ac.id} ${ok ? '✓' : '—'}`);
        continue;
      }

      if (!ac.verified_record) {
        cells.push(`${ac.id} manual`);
        continue;
      }

      // 紀錄合格。再問它有沒有過期 —— CR-011:manual 的 done 是快照,e2e 的是活的。
      const commit = String(ac.verified_record.commit).trim();
      const paths = ownerPaths(task.owner);
      const since = paths.length > 0 ? changedSince(commit, paths) : [];
      if (since.length > 0) {
        warnings.push(
          `${task.id} / ${ac.id}: 驗的是 ${commit},但 ${task.owner} 的路徑` +
            `(${paths.join('、')})之後有 ${since.length} 個 commit —— 這筆紀錄可能不再` +
            `對應現在的程式碼。manual 的 done 是快照,不是活的(CR-011)`,
        );
        cells.push(`${ac.id} manual ⚠️`);
      } else {
        cells.push(`${ac.id} manual ✓`);
      }
    }

    const derived = deriveStatus(task, {
      covered,
      commitExists,
      blockedBy: blockedBy.get(task.id) ?? [],
    });
    if (derived.status === 'done') doneNow.add(task.id);

    rows.push({
      id: task.id,
      owner: task.owner ?? '',
      status: formatStatus(derived),
      cells,
    });
  }

  // 退步比對 —— ADR-007 唯一的陷阱,漏掉它整個決策就是淨損失。
  //
  // 推導之前,「done 的任務掉了測試」會紅。推導之後,同一件事只會讓那張任務
  // 安靜地從 done 變回 open —— 把一條紅線換成一次無聲的狀態變化,方向跟這個
  // repo 的每一條規則都相反。所以要有基準:在 base ref 上是 done、在這裡不是,
  // 就是退步。要合法地退出 done,得動那張任務的 AC —— 那是 contract 變更,
  // 本來就該被看見。
  if (base) {
    for (const id of base.done) {
      if (doneNow.has(id)) continue;

      const now = tasks.find((t) => t.id === id);
      const 結構變了 = !now || base.acceptance.get(id) !== acceptanceStructure(now);

      if (結構變了) {
        // 動了 AC 的**結構**而退出 done —— 那是 contract 變更,只有 architect 改得到,
        // 而且 CODEOWNERS 要求人類看過。ADR-007 說這是**合法**的退出方式,
        // 所以這裡出聲但不擋。
        //
        // 判紅的話會產生一個沒有人解得開的死結:architect 在一張 done 的任務上
        // 新增一條 AC,那張 PR 就是紅的,而測試在 e2e/(qa 的),一張 PR 只能掛
        // 一個角色 —— 沒有任何一個人補得起來。
        warnings.push(
          `${id} 在 ${baseRef} 上是 done,在這裡不是 —— 但它的 AC 結構也動了` +
            (now ? '(id 集合或 verified_by)' : '(整張任務被刪掉)') +
            `,當成刻意的 contract 變更。若不是刻意的,那是一次無聲的退步。`,
        );
        continue;
      }

      errors.push(
        `${id} 在 ${baseRef} 上是 done,在這裡不是,而它的 AC 結構沒變` +
          `(id 集合與 verified_by 都一樣)—— 是不是掉了測試,或 verified_record 壞了?`,
      );
    }
  } else {
    // 取不到基準時要出聲。安靜跳過等於這一輪沒有退步偵測,而沒有人會知道。
    warnings.push(
      `取不到 ${baseRef},這一輪沒有做退步比對 —— 淺 clone 或缺少 remote 都會這樣。` +
        `CI 兩個 job 都是 fetch-depth: 0,若這行出現在 CI 上,那是設定退化了。`,
    );
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
    roles: Object.keys(scope.roles),
    decisionExists: (path) => existsSync(join(rootDir, path)),
    commitExists: commitExistsInRepo,
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
    // 一個測試檔都沒有 —— 那不是「乾淨」,是檢查失去了對象:每一張任務都會
    // 算成 open,而退步比對會把它們全部判紅。與其那樣,不如直說。
    console.error(`❌ ${e2eDir} 裡沒有任何 *.spec.ts,無法判斷 AC 覆蓋。`);
    process.exit(2);
  }
  const covered = collectCoverage(e2eDir);

  // base ref 可以覆寫,方便在別的分支上手動比對;預設是 origin/main。
  const baseRef = process.env.AC_BASE_REF ?? 'origin/main';

  const { rows, errors, warnings } = auditTasks(tasks, covered, {
    ...repoDeps(),
    blockedBy: blockedByCrs(),
    base: snapshotAt(baseRef),
    baseRef,
  });

  console.log(`檢查 ${tasks.length} 個任務、${specFiles.length} 個測試檔`);
  console.log('');
  const w = { id: 10, owner: 9, status: 16 };
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
