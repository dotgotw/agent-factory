/**
 * scripts/check-cr.test.mjs
 *
 * 「已裁決的 CR 必須真的有裁決」這條檢查本身的測試。
 *
 * 這條檢查是為了補一個「看起來涵蓋了、實際只涵蓋一半」的洞(ADR-003 的
 * CR-010 補充),所以它自己最不該犯同一個毛病。下面前三個 case 就是那個洞
 * 的三種長相。
 *
 * 跑法: pnpm test:scripts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  blockedByCrs,
  field,
  pendingSummary,
  readCrs,
  rulingVerdict,
  sectionOf,
} from './check-cr.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const crDir = join(rootDir, 'change-requests');
const TEMPLATE = readFileSync(join(crDir, 'TEMPLATE.md'), 'utf8');

const cr = (ruling) =>
  `# CR-999: 測試用\n\n- **提出者**: infra\n- **狀態**: accepted\n- **阻擋任務**: 無\n\n## 問題\n略\n\n---\n## Architect 裁決\n${ruling}`;

test('留著範本佔位 → 不合格', () => {
  const v = rulingVerdict(cr('> 由 Architect 填寫。accepted 的話註明已更新的 contract 版本。'), TEMPLATE);
  assert.equal(v.ok, false);
  assert.match(v.reason, /只剩範本佔位/);
});

test('把範本那行刪掉、留空段落 → 一樣不合格', () => {
  // 這就是「只比對範本那一行字」會漏掉的那一種:洞還在原地。
  assert.equal(rulingVerdict(cr(''), TEMPLATE).ok, false);
  assert.equal(rulingVerdict(cr('\n\n'), TEMPLATE).ok, false);
  assert.match(rulingVerdict(cr('\n\n'), TEMPLATE).reason, /是空的/);
});

test('只留一個分隔線或一兩個字 → 不合格', () => {
  assert.equal(rulingVerdict(cr('---'), TEMPLATE).ok, false);
  assert.equal(rulingVerdict(cr('accepted'), TEMPLATE).ok, false);
  assert.match(rulingVerdict(cr('accepted'), TEMPLATE).reason, /只有 8 個字/);
});

test('真的寫了裁決 → 合格', () => {
  const v = rulingVerdict(
    cr('**Accepted,選 (a)。** 理由是最長前綴勝出不需要新概念,而且讓現有的明列清單真的生效。'),
    TEMPLATE,
  );
  assert.equal(v.ok, true);
  assert.ok(v.chars > 20);
});

test('缺整個裁決段 → 不合格', () => {
  const noSection = '# CR-999: 測試用\n\n- **狀態**: accepted\n\n## 問題\n略\n';
  const v = rulingVerdict(noSection, TEMPLATE);
  assert.equal(v.ok, false);
  assert.match(v.reason, /缺少/);
});

test('範本自己壞掉時直接拋錯,不是靜默放行', () => {
  // 佔位判斷若失去依據,結果會是「佔位變成合格內容」—— 檢查靜默失效,
  // 比沒有檢查更糟,因為它還是綠的。
  assert.throws(() => rulingVerdict(cr('隨便寫點什麼夠長的內容來通過字數下限'), '# 空範本\n'), /TEMPLATE\.md/);
});

test('現有的 CR 全部通過,這條檢查不需要遷移', () => {
  const files = readdirSync(crDir).filter((f) => /^CR-\d+\.md$/.test(f));
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = readFileSync(join(crDir, f), 'utf8');
    const status = field(text, '狀態');
    if (status !== 'accepted' && status !== 'rejected') continue;
    const v = rulingVerdict(text, TEMPLATE);
    assert.equal(v.ok, true, `${f} 的裁決段不合格: ${v.reason}`);
  }
});

test('sectionOf 只取到下一個同級標題為止', () => {
  const doc = '## 甲\n一\n二\n\n## 乙\n三\n';
  assert.equal(sectionOf(doc, '甲').trim(), '一\n二');
  assert.equal(sectionOf(doc, '乙').trim(), '三');
  assert.equal(sectionOf(doc, '丙'), null);
});

// ---------- 等裁決的 CR ----------

const crMap = (...pairs) => new Map(pairs.map(([id, status]) => [id, { status }]));

test('沒有 proposed → 不印(不製造常駐噪音)', () => {
  assert.equal(pendingSummary(crMap(['CR-001', 'accepted'], ['CR-002', 'rejected'])), null);
  assert.equal(pendingSummary(new Map()), null);
});

test('有 proposed → 印出數量與最舊的一份', () => {
  const line = pendingSummary(crMap(['CR-001', 'accepted'], ['CR-005', 'proposed']));
  assert.equal(line, '1 份 CR 仍為 proposed,最舊的一份是 CR-005');
});

test('「最舊」是編號最小的那一份,不是 Map 的順序', () => {
  // 插入順序刻意跟編號相反 —— 靠 Map 順序會答錯。
  const line = pendingSummary(crMap(['CR-012', 'proposed'], ['CR-002', 'proposed']));
  assert.equal(line, '2 份 CR 仍為 proposed,最舊的一份是 CR-002');
});

test('編號用數字比,不是字串比', () => {
  // 今天的編號都是三位數補零,字串比也會對;哪天出現 CR-1000 就不對了。
  const line = pendingSummary(crMap(['CR-10', 'proposed'], ['CR-9', 'proposed']));
  assert.equal(line, '2 份 CR 仍為 proposed,最舊的一份是 CR-9');
});

test('accepted / rejected 不算在內', () => {
  const line = pendingSummary(
    crMap(['CR-001', 'accepted'], ['CR-002', 'rejected'], ['CR-003', 'proposed']),
  );
  assert.equal(line, '1 份 CR 仍為 proposed,最舊的一份是 CR-003');
});

/** 一份合法的 proposed CR。 */
const proposedCr = (id) =>
  `# ${id}: 合成的\n\n- **提出者**: infra\n- **狀態**: proposed\n- **阻擋任務**: 無\n\n## 問題\n略\n\n---\n## Architect 裁決\n> 由 Architect 填寫。accepted 的話註明已更新的 contract 版本。\n`;

const acceptedCr = (id) =>
  `# ${id}: 合成的\n\n- **提出者**: infra\n- **狀態**: accepted\n- **阻擋任務**: 無\n\n## 問題\n略\n\n---\n## Architect 裁決\n**Accepted。** 這是一份夠長的裁決,足以通過字數下限的檢查。\n`;

/** 用一份合成的 change-requests/ 跑 CLI,回傳它的輸出。 */
function runCliWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'cr-fixture-'));
  try {
    writeFileSync(join(dir, 'TEMPLATE.md'), TEMPLATE);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return execFileSync('node', [join(rootDir, 'scripts/check-cr.mjs')], {
      encoding: 'utf8',
      cwd: rootDir,
      env: { ...process.env, CR_DIR: dir },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI 真的印出那一行 —— 用合成的 CR,不看 repo 當下有幾份 proposed', () => {
  // 上一版讀 change-requests/ 的實際狀態,而在第一份 proposed 的 CR 出現之前,
  // 它一直走 proposed.length === 0 那一支**恆真通過**。代價是真的付了:
  // 這條輸出的接線在 #91 被順手砍掉,13 張 PR 沒有任何測試出聲(qa 在 CR-014 抓到)。
  //
  // 拿 production 狀態當 fixture,等於讓「有沒有人在用這個功能」決定「測不測得到」。
  const out = runCliWith({
    'CR-900.md': proposedCr('CR-900'),
    'CR-901.md': acceptedCr('CR-901'),
  });
  assert.match(out, /1 份 CR 仍為 proposed,最舊的一份是 CR-900/);
});

test('沒有 proposed 就不印那一行 —— 同一條線的反向', () => {
  const out = runCliWith({ 'CR-900.md': acceptedCr('CR-900') });
  assert.doesNotMatch(out, /仍為 proposed/);
});

// ---------- ADR-007:blocked 是 CR 的函數 ----------

test('只有 proposed 的 CR 會擋住任務', () => {
  const crs = [
    { id: 'CR-100', status: 'proposed', blocks: 'TASK-001、TASK-002' },
    { id: 'CR-101', status: 'accepted', blocks: 'TASK-003' },
    { id: 'CR-102', status: 'rejected', blocks: 'TASK-004' },
    { id: 'CR-103', status: 'proposed', blocks: '無' },
    { id: 'CR-104', status: 'proposed', blocks: 'TASK-001' },
  ];
  const map = blockedByCrs(crs);
  assert.deepEqual(map.get('TASK-001'), ['CR-100', 'CR-104'], '同一張任務可以被多份 CR 擋著');
  assert.deepEqual(map.get('TASK-002'), ['CR-100']);
  assert.equal(map.get('TASK-003'), undefined, '已裁決的 CR 不再擋');
  assert.equal(map.get('TASK-004'), undefined);
  assert.equal(map.size, 2);
});

test('readCrs 讀得到真實的 CR,算出來的 blocked 一律來自 proposed', () => {
  // 上一版斷言 blockedByCrs(crs).size === 0,而我自己在註解裡寫著「若哪天有
  // proposed 的 CR 指名某張任務」—— 那就是這個機制被正常使用的那一天。
  // 同 CR-014 抓到的形狀:斷言「還沒有人用過」而不是斷言行為。
  const crs = readCrs();
  assert.ok(crs.length > 0);
  for (const cr of crs) assert.match(cr.id, /^CR-\d+$/);

  const proposed = new Set(crs.filter((c) => c.status === 'proposed').map((c) => c.id));
  for (const [task, ids] of blockedByCrs(crs)) {
    assert.match(task, /^TASK-\d+$/);
    for (const id of ids) assert.ok(proposed.has(id), `${task} 被 ${id} 擋著,但它不是 proposed`);
  }
});
