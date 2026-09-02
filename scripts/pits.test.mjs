/**
 * scripts/pits.test.mjs —— 坑註解機制的測試(ADR-009 補充)
 *
 * 最要緊的一條是最後那個:**掃描不會把文件裡的範例當成真的坑**。
 * 實測過:不排除 .md 的話,ADR-009 自己的兩個示範會變成「標給 qa 與 backend
 * 的坑註解」,而那會出現在每個 session 的開場 —— 機制第一天就在噴假訊號。
 *
 * 跑法: pnpm test:scripts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSkipped, parsePit, pitsFor, scanPits, shapeErrors } from './pits.mjs';
import { loadScope } from './role.mjs';

const ROLES = Object.keys(loadScope().roles);

test('解析:指名的角色與說明分得開', () => {
  const p = parsePit('// 坑(下一個踩的人:qa):e2e 的 port 寫死,兩個 session 會互撞');
  assert.equal(p.role, 'qa');
  assert.equal(p.note, 'e2e 的 port 寫死,兩個 session 會互撞');
});

test('解析:不是坑註解的行回 null', () => {
  assert.equal(parsePit('// 一般註解'), null);
  assert.equal(parsePit('const x = 1;'), null);
  assert.equal(parsePit('// TODO: 這裡還沒做'), null);
});

test('解析:沒指名角色也解析得出來 —— 否則形狀檢查驗不到它', () => {
  const p = parsePit('// 坑(下一個踩的人:):忘了指名');
  assert.equal(p.role, '');
});

test('形狀檢查:角色必須存在於 scope.json', () => {
  const pit = (role) => ({ file: 'scripts/x.mjs', line: 1, role, note: 'n' });
  assert.deepEqual(shapeErrors([pit('qa'), pit('infra')], ROLES), []);
  assert.equal(shapeErrors([pit('')], ROLES).length, 1);
  assert.match(shapeErrors([pit('')], ROLES)[0], /\(空白\)/);
  assert.match(shapeErrors([pit('qaa')], ROLES)[0], /「qaa」/);
  // 訊息要說出為什麼指名是必要的,不是只說「格式錯」
  assert.match(shapeErrors([pit('')], ROLES)[0], /沒有人會讀到它/);
});

test('掃描範圍:文件、衍生輸出、本機制自己的檔案都不算', () => {
  // 三個理由不同,見 pits.mjs 的 SKIP_* 註解。
  assert.equal(isSkipped('contract/decisions/ADR-009-x.md'), true, '文件裡的是範例');
  assert.equal(isSkipped('README.md'), true);
  assert.equal(isSkipped('backend/AGENTS.md'), true, 'AGENTS.md 有一段是 scope.json 渲染的');
  assert.equal(isSkipped('generated/api.ts'), true, 'openapi 的 description 會流進來');
  assert.equal(isSkipped('scripts/pits.mjs'), true, '定義標記的地方');
  assert.equal(isSkipped('scripts/check-pits.mjs'), true, '錯誤訊息裡有標記的字面');
  assert.equal(isSkipped('scripts/pits.test.mjs'), true, '這個檔案自己');

  assert.equal(isSkipped('backend/src/index.ts'), false);
  assert.equal(isSkipped('e2e/server.ts'), false, '測試也是坑註解的家');
  assert.equal(isSkipped('scripts/check-ac.mjs'), false);
});

test('pitsFor 只給那個角色的', () => {
  const pits = [
    { file: 'a', line: 1, role: 'qa', note: '1' },
    { file: 'b', line: 2, role: 'infra', note: '2' },
    { file: 'c', line: 3, role: 'qa', note: '3' },
  ];
  assert.equal(pitsFor('qa', pits).length, 2);
  assert.equal(pitsFor('backend', pits).length, 0);
});

test('現況掃描是乾淨的 —— 文件裡的範例沒有被當成真的坑', () => {
  // 這條是那個假陽性的回歸測試。ADR-009 與 AGENTS.md 裡都有示範用的標記,
  // 它們一旦被算進去,每個 session 開場都會看到不存在的坑。
  const pits = scanPits();
  assert.deepEqual(pits, [], `不該有:${JSON.stringify(pits)}`);
});

test('掃描出來的東西一律通過形狀檢查', () => {
  assert.deepEqual(shapeErrors(scanPits(), ROLES), []);
});
