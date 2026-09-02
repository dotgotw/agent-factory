#!/usr/bin/env node
/**
 * scripts/check-cr.mjs
 *
 * 驗證 change-requests/ 與 contract/tasks.yaml 的一致性。
 *
 * CR 的狀態是 markdown 文字,沒有型別、沒有 schema,靠人眼看不出漂移。
 * 本腳本補上這個缺口:讓「流程狀態」跟 contract 一樣受 CI 保護。
 *
 * ## 少了一條檢查,而且是刻意的(ADR-007)
 *
 * 這裡本來有一條「任務標成 blocked,但它引用的 CR 已經 accepted / rejected」的
 * 漂移檢查。ADR-007 把 blocked 改成推導 —— 它現在是 blockedByCrs() 的輸出,
 * 是 CR 狀態的函數,不可能跟 CR 不一致。**那個錯誤類別由構造消失了**,所以整段
 * 連同錯誤訊息一起刪掉,不是留著空跑:一條永遠不會觸發的檢查會讓讀的人以為
 * 這件事有人在看。
 *
 * 同理刪掉了它的鏡像(proposed 的 CR 宣稱阻擋某個非 blocked 的任務)。
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

/**
 * 還在等裁決的 CR。沒有就回傳 null。
 *
 * 這個 repo 其他的欠帳都已經被機器接手了:check:drift 抓生成物過期、
 * check:ac 抓 AC 失去測試、check:boundaries 抓依賴邊界消失。只有「有人在等
 * 裁決」還靠人記得 —— CR-012 躺了一輪才被發現。
 *
 * **不判紅。** proposed 不是錯誤,只是需要有人看見;判紅會逼人為了綠燈而草率
 * 裁決,那比沒有提醒更糟。沒有 proposed 時完全不印,不製造常駐噪音 ——
 * 一則每次都出現的提醒,幾天之後就跟不存在一樣。
 *
 * 「最舊」用檔名編號排序就夠,不讀 git 時間:編號是遞增發放的,而且讀 git
 * 會讓這個函式需要一個 repo 才能測。
 */
export function pendingSummary(crs) {
  const numberOf = (id) => Number(id.match(/\d+/)?.[0] ?? 0);
  const proposed = [...crs.entries()]
    .filter(([, cr]) => cr.status === 'proposed')
    .map(([id]) => id)
    .sort((a, b) => numberOf(a) - numberOf(b));

  if (proposed.length === 0) return null;
  return `${proposed.length} 份 CR 仍為 proposed,最舊的一份是 ${proposed[0]}`;
}

/**
 * 讀 change-requests/ 的所有 CR。
 *
 * ADR-007 之後這也是 blocked 的來源:blocked 不再是有人寫在 tasks.yaml 裡的值,
 * 而是「有一份 proposed 的 CR 指名它」的函數。check:ac 與 pnpm tasks 都從這裡問,
 * 不各自 parse 一次。
 */
export function readCrs(crDir = join(rootDir, 'change-requests')) {
  return readdirSync(crDir)
    .filter((f) => /^CR-\d+\.md$/.test(f))
    .sort()
    .map((file) => {
      const text = readFileSync(join(crDir, file), 'utf8');
      return {
        id: basename(file, '.md'),
        file,
        text,
        proposer: field(text, '提出者'),
        status: field(text, '狀態'),
        blocks: field(text, '阻擋任務'),
      };
    });
}

/** 每個任務被哪些 proposed 的 CR 擋著。回傳 Map(taskId -> [CR id])。 */
export function blockedByCrs(crs = readCrs()) {
  const map = new Map();
  for (const cr of crs) {
    if (cr.status !== 'proposed') continue;
    for (const ref of (cr.blocks ?? '').match(/TASK-\d+/g) ?? []) {
      map.set(ref, [...(map.get(ref) ?? []), cr.id]);
    }
  }
  return map;
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

  const taskIds = new Set(tasks.map((t) => t.id));
  const roles = Object.keys(JSON.parse(readFileSync(scopePath, 'utf8')).roles);

  // ---------- 解析 CR ----------
  const allCrs = readCrs(crDir);
  const crFiles = allCrs.map((c) => c.file);

  if (crFiles.length === 0) {
    console.log('（尚無 CR,略過檢查）');
    process.exit(0);
  }

  const crs = new Map();

  for (const { id, file, text, proposer, status, blocks } of allCrs) {
    const at = (msg) => errors.push(`${file}: ${msg}`);

    // 標題必須與檔名一致,避免複製 CR 時忘了改編號。
    const title = text.match(/^#\s*(CR-\d+)/m)?.[1];
    if (title !== id) {
      at(`標題編號 ${title ?? '(缺標題)'} 與檔名不符`);
    }

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

    // 阻擋任務指到的編號必須存在。
    //
    // ADR-007 之前這只是個沒人用的欄位;之後 blocked 是它的函數 —— CR 裡把
    // TASK-008 打成 TASK-808,那張任務就不會被 blocked,而且沒有任何一條紅線。
    // 打錯字很便宜(同 decisions 指標與 verified_record.commit 那兩條)。
    for (const ref of (blocks ?? '').match(/TASK-\d+/g) ?? []) {
      if (!taskIds.has(ref)) at(`阻擋任務 ${ref} 不存在於 tasks.yaml`);
    }

    crs.set(id, { file, status, blocks });
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
