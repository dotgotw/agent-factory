#!/usr/bin/env node
/**
 * scripts/task-status.mjs —— 任務狀態是算出來的,不是寫出來的(ADR-007)
 *
 * 這支沒有 CLI,它只回答一個問題:**這張任務現在是什麼狀態?**
 * check:ac 用它判斷退步,pnpm tasks 用它顯示 —— 同一份推導,不是兩份。
 *
 * 前例是 check-scope.mjs import role.mjs 的 classifyPath:兩邊各寫一份比對邏輯,
 * 遲早會出現「CLI 說 done、檢查說不是」的組合,而那比沒有推導更難查。
 *
 * ## 三個值
 *
 *   done     每一條 AC 都有證據
 *   blocked  還不是 done,而且有一份 proposed 的 CR 指名它
 *   open     其餘 —— 附上 (n/m AC) 說明差多遠
 *
 * `open (2/3 AC)` 表達的正是原本 `review` 想表達的東西,差別在它是量出來的。
 * todo / in_progress / review 不在這裡:它們是意圖不是保證,ADR-007 把它們移出
 * contract。「誰正在做」的可信來源是一張開著的、掛著 agent:<role> label 的 PR。
 *
 * ## 證據是什麼
 *
 *   verified_by: e2e     測試檔裡出現該 AC 編號
 *   verified_by: manual  一筆合格的 verified_record(CR-011):四個欄位皆非空、
 *                        saw 不是把 text 抄一遍、commit 在 repo 裡解析得出來
 *
 * 「沒有紀錄」不是錯誤,是還沒有證據 —— 那張任務就還不是 done。但「紀錄有了
 * 卻是壞的」是錯誤:那是打錯字或抄襲,由 check:ac 判紅(規則仍是 CR-011 那三條)。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { load as parseYaml } from 'js-yaml';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export const VALID_VERIFIED_BY = ['e2e', 'manual'];
export const RECORD_FIELDS = ['at', 'who', 'commit', 'saw'];

/** pnpm tasks --status 的合法值。ADR-007 之後這三個是算出來的,不是寫出來的。 */
export const STATUSES = ['open', 'blocked', 'done'];

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
 * 一條 AC 有沒有證據,以及(如果有問題)問題是什麼。
 *
 * 回傳 { ok, problem }。problem 非 null 代表這是**宣告本身壞掉**(打錯字、
 * 抄襲、缺欄位),由呼叫端決定要不要判紅;ok === false 而 problem === null
 * 只是「還沒有證據」,那不是錯誤。
 */
export function acEvidence(ac, { covered = new Set(), commitExists = () => true } = {}) {
  const by = ac.verified_by;
  if (!by) return { ok: false, problem: '缺少 verified_by(不給預設值,見 CR-006)' };
  if (!VALID_VERIFIED_BY.includes(by)) {
    return {
      ok: false,
      problem: `verified_by "${by}" 非法,必須是 ${VALID_VERIFIED_BY.join(' | ')}(刻意沒有 none)`,
    };
  }

  if (by === 'e2e') return { ok: covered.has(ac.id), problem: null };

  // manual
  if (!(ac.verified_note ?? '').trim()) {
    return {
      ok: false,
      problem: 'verified_by 是 manual,必須用 verified_note 寫明為什麼自動化測不到',
    };
  }
  const record = ac.verified_record;
  if (!record) return { ok: false, problem: null }; // 還沒驗,不是錯

  const missing = RECORD_FIELDS.filter((f) => !String(record[f] ?? '').trim());
  if (missing.length > 0) {
    return { ok: false, problem: `verified_record 的 ${missing.join('、')} 是空的` };
  }
  if (normalize(record.saw) === normalize(ac.text)) {
    return {
      ok: false,
      problem: 'verified_record.saw 只是把 text 抄一遍 —— saw 要寫「看到什麼」,不是複述驗收條件',
    };
  }
  const commit = String(record.commit).trim();
  if (!commitExists(commit)) {
    return { ok: false, problem: `verified_record.commit "${commit}" 在這個 repo 裡解析不出來` };
  }
  return { ok: true, problem: null };
}

/**
 * 一張任務算出來的狀態。回傳 { status, done, total, blockedBy, problems }。
 *
 * 沒有 AC 的任務不是 done —— 「所有 AC 都有證據」在零條 AC 時形式上成立,
 * 但那代表沒有人說得出它做完是什麼樣子。空集合不該當成保證。
 */
export function deriveStatus(task, { covered, commitExists, blockedBy = [] } = {}) {
  const acs = task.acceptance ?? [];
  const problems = [];
  let done = 0;
  for (const ac of acs) {
    const { ok, problem } = acEvidence(ac, { covered, commitExists });
    if (ok) done++;
    if (problem) problems.push({ ac: ac.id, problem });
  }

  // done 蓋過 blocked,不是反過來。
  //
  // 第一版寫成 blocked 優先,實測撞到一個死結:對一張 done 的任務開一份
  // proposed CR,它就不再是 done,退步比對當場判紅 —— 而開 CR 的人補不了任何
  // 東西。**開 CR 是這套制度的逃生門,不能讓它把 CI 弄紅。**
  //
  // 而且 done 優先才是實話:證據還在那裡,提議改規格並不會讓已經存在的證據
  // 消失。blocked 的用途是「別動手,這張還沒定案」,對一張已經完成的任務沒有
  // 那個意思。擋著它的 CR 不會因此看不見 —— pnpm task 一律列出來,check:cr
  // 也會報「N 份 CR 仍為 proposed」。
  const isDone = acs.length > 0 && done === acs.length;
  const status = isDone ? 'done' : blockedBy.length > 0 ? 'blocked' : 'open';
  return { status, done, total: acs.length, blockedBy, problems };
}

/** 顯示用的一行字:done / blocked(CR-014)/ open (2/3 AC)。 */
export function formatStatus(derived) {
  if (derived.status === 'blocked') return `blocked(${derived.blockedBy.join('、')})`;
  if (derived.status === 'done') return 'done';
  return `open (${derived.done}/${derived.total} AC)`;
}

// ---------- 真實來源 ----------

/** e2e/ 的測試檔裡出現過的所有 AC 編號。 */
export function collectCoverage(e2eDir = join(rootDir, 'e2e')) {
  const covered = new Set();
  for (const file of readdirSync(e2eDir).filter((f) => f.endsWith('.spec.ts'))) {
    for (const id of collectAcIds(readFileSync(join(e2eDir, file), 'utf8'))) covered.add(id);
  }
  return covered;
}

export function loadTasksFrom(file = join(rootDir, 'contract', 'tasks.yaml')) {
  return parseYaml(readFileSync(file, 'utf8')).tasks ?? [];
}

/** 跑 git,失敗回傳 null。 */
export function git(args) {
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

export function commitExistsInRepo(sha) {
  return git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]) !== null;
}

/**
 * 某個 git ref 上的快照:算出來的 done 集合,以及每張任務的 AC 正規形式。
 * 取不到那個 ref 回傳 null。
 *
 * 為什麼要帶 AC 的結構:退步比對要分得出兩件事 —— 「done 掉了測試」(結構沒動,
 * 是退步)與「AC 的結構被改了所以不再 done」(contract 變更,是刻意的)。
 * 見 check-ac.mjs 的退步比對那段與 acceptanceStructure 的註解。
 *
 * ⚠️  依賴完整的 git 歷史。CI 兩個 job 都是 fetch-depth: 0,所以成立。
 *     改成淺 clone 會讓這裡取不到 base ref —— 退步偵測從「抓得到」變成
 *     「抓不到」,而那是 ADR-007 唯一的陷阱:推導把「done 掉了測試」從一條
 *     紅線變成一次無聲的狀態變化。取不到時呼叫端要出聲,不要安靜跳過。
 *     (同 CR-011 裁決對 commit 欄位的那句提醒。)
 */
export function snapshotAt(ref, { commitExists = commitExistsInRepo } = {}) {
  const yaml = git(['show', `${ref}:contract/tasks.yaml`]);
  if (yaml === null) return null;

  const files = (git(['ls-tree', '-r', '--name-only', ref, '--', 'e2e']) ?? '')
    .split('\n')
    .filter((f) => f.endsWith('.spec.ts'));

  const covered = new Set();
  for (const file of files) {
    for (const id of collectAcIds(git(['show', `${ref}:${file}`]) ?? '')) covered.add(id);
  }

  const done = new Set();
  const acceptance = new Map();
  for (const task of parseYaml(yaml).tasks ?? []) {
    acceptance.set(task.id, acceptanceStructure(task));
    if (deriveStatus(task, { covered, commitExists }).status === 'done') done.add(task.id);
  }
  return { done, acceptance };
}

/**
 * 比對「AC 的**結構**有沒有被動過」用的正規形式。
 *
 * 只取 id 與 verified_by,而且排序 —— 這兩樣決定了「要拿什麼才算證據」。
 * 散文(text、verified_note)不在裡面:改一個字元不該讓一次真正的退步降級成提醒。
 *
 * verified_by 一定要算進來,否則會長出死結一的變種:把一條 AC 從 manual 改成
 * e2e,id 集合一個字沒變,但那條 e2e 測試還不存在 —— 判紅的話,改 verified_by
 * 的是 architect、寫測試的是 qa,又是一張 PR 補不起來的組合。
 *
 * verified_record **不算結構**:刪掉一筆人工驗收紀錄就是證據消失,本來就該紅,
 * 而且補得回來的人跟刪掉的人是同一個角色,不構成死結。
 */
export function acceptanceStructure(task) {
  return JSON.stringify(
    (task?.acceptance ?? [])
      .map((ac) => [ac.id, ac.verified_by ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}
