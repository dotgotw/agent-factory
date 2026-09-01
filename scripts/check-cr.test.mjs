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
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { field, pendingSummary, rulingVerdict, sectionOf } from './check-cr.mjs';

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

test('CLI 的輸出與 change-requests/ 的實際狀態一致', () => {
  // 不寫死「現在有幾份 proposed」—— 那會讓這條測試在下一張 CR 開出來時就紅,
  // 而它要驗的是「接線有沒有接上」,不是 repo 今天的狀態。
  const files = readdirSync(crDir).filter((f) => /^CR-\d+\.md$/.test(f));
  const proposed = files
    .map((f) => [f, field(readFileSync(join(crDir, f), 'utf8'), '狀態')])
    .filter(([, status]) => status === 'proposed')
    .map(([f]) => f.replace('.md', ''))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  const out = execFileSync('node', [join(rootDir, 'scripts/check-cr.mjs')], {
    encoding: 'utf8',
    cwd: rootDir,
  });

  if (proposed.length === 0) {
    assert.doesNotMatch(out, /仍為 proposed/, '沒有 proposed 時不該印這行');
  } else {
    assert.match(out, new RegExp(`${proposed.length} 份 CR 仍為 proposed,最舊的一份是 ${proposed[0]}`));
  }
});
