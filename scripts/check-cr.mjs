#!/usr/bin/env node
/**
 * scripts/check-cr.mjs
 *
 * 驗證 change-requests/ 與 contract/tasks.yaml 的一致性。
 *
 * CR 的狀態是 markdown 文字,沒有型別、沒有 schema,靠人眼看不出漂移。
 * 本腳本補上這個缺口:讓「流程狀態」跟 contract 一樣受 CI 保護。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { load as parseYaml } from 'js-yaml';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');

const crDir = join(rootDir, 'change-requests');
const tasksPath = join(rootDir, 'contract', 'tasks.yaml');
const scopePath = join(here, 'scope.json');

const VALID_STATUSES = ['proposed', 'accepted', 'rejected'];

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

const taskById = new Map(tasks.map((t) => [t.id, t]));
const roles = Object.keys(JSON.parse(readFileSync(scopePath, 'utf8')).roles);

// ---------- 解析 CR ----------
/** 取出 `- **欄位**: 值` 的值。 */
function field(text, name) {
  const m = text.match(new RegExp(`^-\\s*\\*\\*${name}\\*\\*\\s*[::]\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

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

  if (!blocks) {
    at('缺少「阻擋任務」');
  } else if (!/^(無|N\/A|—|-)$/.test(blocks)) {
    for (const ref of blocks.match(/TASK-\d+/g) ?? []) {
      if (!taskById.has(ref)) at(`阻擋任務 ${ref} 不存在於 tasks.yaml`);
    }
    if (!/TASK-\d+/.test(blocks)) at(`阻擋任務 "${blocks}" 格式無法辨識`);
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
for (const [id, cr] of crs) {
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
