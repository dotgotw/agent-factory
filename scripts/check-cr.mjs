#!/usr/bin/env node
/**
 * scripts/check-cr.mjs
 *
 * 驗證 change-requests/ 與 contract/tasks.yaml 的一致性。
 *
 * CR 的狀態是 markdown 文字,沒有型別、沒有 schema,靠人眼看不出漂移。
 * 本腳本補上這個缺口:讓「流程狀態」跟 contract 一樣受 CI 保護。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, resolve } from 'node:path';
import { load as parseYaml } from 'js-yaml';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');

const VALID_STATUSES = ['proposed', 'accepted', 'rejected'];
const RULING_HEADING = 'Architect 裁決';

/**
 * 裁決段的內容下限(去掉空白後的字數)。
 *
 * 這個數字不是在防造假 —— 想造假的人打 20 個字比刪一行還容易。它防的是
 * 「忘了寫」:標成 accepted、裁決段卻留著範本或空白。造假由 CODEOWNERS
 * 那層的人類 review 負責,不是這裡。
 *
 * 實測十份已 accepted 的 CR,最短的裁決段是 CR-002 的 155 字,離下限有七倍,
 * 所以這條檢查上線不需要任何遷移。
 */
const MIN_RULING_CHARS = 20;

// ---------- 純函式(供 check-cr.test.mjs 使用) ----------

/** 取出 `- **欄位**: 值` 的值。 */
export function field(text, name) {
  const m = text.match(new RegExp(`^-\\s*\\*\\*${name}\\*\\*\\s*[::]\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

/** 取出某個 `## 標題` 底下到下一個同級標題(或檔尾)的內容;找不到回傳 null。 */
export function sectionOf(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\s*$`).test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * 這份 CR 到底有沒有裁決。
 *
 * 陷阱在於「只比對範本那一行字」是不夠的:把那行刪掉、留一個空段落就會過,
 * 洞還在原地(ADR-003 的 CR-010 補充)。所以判準是**剩下多少實質內容**,
 * 而範本佔位從 TEMPLATE.md 現讀 —— 寫死一份字串,範本改了這裡就會悄悄失效。
 */
export function rulingVerdict(crText, templateText) {
  const section = sectionOf(crText, RULING_HEADING);
  if (section === null) {
    return { ok: false, chars: 0, reason: `缺少「## ${RULING_HEADING}」段落` };
  }

  const templateSection = sectionOf(templateText, RULING_HEADING);
  if (templateSection === null) {
    // 範本本身壞了就不要猜 —— 猜的結果是佔位變成合格內容,檢查靜默失效。
    throw new Error(`TEMPLATE.md 找不到「## ${RULING_HEADING}」段落,無法判斷什麼是範本佔位`);
  }
  const placeholders = new Set(
    templateSection.split('\n').map((l) => l.trim()).filter(Boolean),
  );

  const lines = section.split('\n').map((l) => l.trim()).filter(Boolean);
  const content = lines.filter((l) => !placeholders.has(l) && !/^-{3,}$/.test(l));
  const chars = content.join('').replace(/\s/g, '').length;

  if (lines.length === 0) return { ok: false, chars, reason: '是空的' };
  if (content.length === 0) return { ok: false, chars, reason: '只剩範本佔位' };
  if (chars < MIN_RULING_CHARS) {
    return { ok: false, chars, reason: `只有 ${chars} 個字,不像是裁決` };
  }
  return { ok: true, chars, reason: null };
}

// ---------- 主流程 ----------

function main() {
  const crDir = join(rootDir, 'change-requests');
  const tasksPath = join(rootDir, 'contract', 'tasks.yaml');
  const scopePath = join(here, 'scope.json');
  const templatePath = join(crDir, 'TEMPLATE.md');

  const errors = [];
  const warnings = [];

  // ---------- 讀取任務與角色 ----------
  let tasks;
  try {
    tasks = parseYaml(readFileSync(tasksPath, 'utf8')).tasks ?? [];
  } catch (err) {
    console.error(`❌ 無法解析 ${tasksPath}: ${err.message}`);
    process.exit(2);
  }

  if (!existsSync(templatePath)) {
    console.error(`❌ 找不到 ${templatePath} —— 沒有範本就判斷不了什麼是佔位。`);
    process.exit(2);
  }
  const templateText = readFileSync(templatePath, 'utf8');

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const roles = Object.keys(JSON.parse(readFileSync(scopePath, 'utf8')).roles);

  // ---------- 解析 CR ----------
  const crFiles = readdirSync(crDir)
    .filter((f) => /^CR-\d+\.md$/.test(f))
    .sort();

  if (crFiles.length === 0) {
    console.log('（尚無 CR,略過檢查）');
    process.exit(0);
  }

  const crs = new Map();

  for (const file of crFiles) {
    const id = basename(file, '.md');
    const text = readFileSync(join(crDir, file), 'utf8');
    const at = (msg) => errors.push(`${file}: ${msg}`);

    // 標題必須與檔名一致,避免複製 CR 時忘了改編號。
    const title = text.match(/^#\s*(CR-\d+)/m)?.[1];
    if (title !== id) {
      at(`標題編號 ${title ?? '(缺標題)'} 與檔名不符`);
    }

    const proposer = field(text, '提出者');
    const status = field(text, '狀態');
    const blocks = field(text, '阻擋任務');

    if (!proposer) at('缺少「提出者」');
    else if (!roles.includes(proposer)) {
      at(`提出者 "${proposer}" 不是 scope.json 定義的角色(${roles.join(', ')})`);
    }

    if (!status) {
      at('缺少「狀態」');
    } else if (!VALID_STATUSES.includes(status)) {
      // 擋掉 Accepted / 已核准 / accept 這類 grep 抓不到的寫法。
      at(`狀態 "${status}" 非法,必須是 ${VALID_STATUSES.join(' | ')}`);
    }

    // 裁決段:已裁決的 CR 必須真的有裁決(ADR-003 的 CR-010 補充)。
    //
    // 這個洞跟 ADR-002 前提一(drift 只比對內容、不比對檔案集合)是同一類:
    // 檢查看起來涵蓋了「CR 有沒有被裁決」,實際上只涵蓋了狀態欄那幾個字。
    if (status === 'accepted' || status === 'rejected') {
      const verdict = rulingVerdict(text, templateText);
      if (!verdict.ok) {
        at(`狀態是 ${status},但「${RULING_HEADING}」段落${verdict.reason}`);
      }
    } else if (status === 'proposed') {
      // 反方向的漂移:裁決寫了,狀態忘了改。不擋,但要說出來。
      const verdict = rulingVerdict(text, templateText);
      if (verdict.ok) {
        warnings.push(
          `${file}: 狀態仍是 proposed,但裁決段已有 ${verdict.chars} 字的內容 —— 是不是忘了改狀態?`,
        );
      }
    }

    crs.set(id, { file, status, blocks });
  }

  // ---------- 交叉比對:blocked 任務 vs CR 狀態 ----------
  for (const task of tasks) {
    if (task.status !== 'blocked') continue;

    const reason = task.blocked_reason ?? '';
    const refs = reason.match(/CR-\d+/g) ?? [];

    if (refs.length === 0) {
      errors.push(`tasks.yaml: ${task.id} 狀態為 blocked,但 blocked_reason 未引用任何 CR`);
      continue;
    }

    for (const ref of refs) {
      const cr = crs.get(ref);
      if (!cr) {
        errors.push(`tasks.yaml: ${task.id} 引用了不存在的 ${ref}`);
        continue;
      }
      // CR 已裁決但任務還卡著 —— 這正是人眼會漏掉的漂移。
      if (cr.status === 'accepted') {
        errors.push(
          `tasks.yaml: ${task.id} 仍為 blocked,但 ${ref} 已 accepted。` +
            `contract 應已更新,請將此任務改為 todo。`,
        );
      } else if (cr.status === 'rejected') {
        errors.push(
          `tasks.yaml: ${task.id} 仍為 blocked,但 ${ref} 已 rejected。` +
            `此任務不會被解除阻擋,請重新規劃或關閉。`,
        );
      }
    }
  }

  // ---------- 提醒:accepted 的 CR 是否還有人卡著 ----------
  for (const [, cr] of crs) {
    if (cr.status !== 'proposed') continue;
    const refs = (cr.blocks ?? '').match(/TASK-\d+/g) ?? [];
    for (const ref of refs) {
      const task = taskById.get(ref);
      if (task && task.status !== 'blocked') {
        warnings.push(
          `${cr.file}: 狀態為 proposed 且宣稱阻擋 ${ref},` +
            `但該任務狀態是 "${task.status}" 而非 blocked。`,
        );
      }
    }
  }

  // ---------- 輸出 ----------
  console.log(`檢查 ${crFiles.length} 份 CR、${tasks.length} 個任務`);
  for (const [id, cr] of crs) console.log(`  ${id}: ${cr.status}`);

  if (warnings.length > 0) {
    console.log(`\n⚠️  ${warnings.length} 項提醒:`);
    for (const w of warnings) console.log(`   - ${w}`);
  }

  if (errors.length > 0) {
    console.error(`\n❌ ${errors.length} 項不一致:`);
    for (const e of errors) console.error(`   - ${e}`);
    process.exit(1);
  }

  console.log('\n✅ CR 與 tasks.yaml 一致');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
