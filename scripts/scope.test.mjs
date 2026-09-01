/**
 * scripts/scope.test.mjs
 *
 * 把「誰擁有哪個檔案」釘住。
 *
 * ADR-003 的不變式(一個角色不得寫入宣告自己邊界的檔案)現在由 scope.json
 * 的一份清單承載,而清單是會被改的東西 —— 改錯不會有任何症狀:CI 照樣綠,
 * 只是某個角色悄悄拿回了自己的鎖。這份測試是那個改動唯一會出聲的地方。
 *
 * 跑法: pnpm test:scope
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canWrite,
  classifyPath,
  loadScope,
  ownerOf,
  validateScope,
} from './role.mjs';

const config = loadScope();
const ROLES = Object.keys(config.roles);

test('scope.json 本身通過驗證(擁有權唯一、加法路徑不重疊)', () => {
  assert.doesNotThrow(() => loadScope());
});

test('歸屬矩陣:每個檔案恰好一個擁有者', () => {
  const expected = {
    // 規則的執行者
    '.github/workflows/ci.yml': 'infra',
    'scripts/role.mjs': 'infra',
    '.claude/hooks/scope-guard.mjs': 'infra',
    'CLAUDE.md': 'infra',
    'AGENTS.md': 'infra',
    'package.json': 'infra',
    // 唯一真相
    'contract/openapi.yaml': 'architect',
    'contract/decisions/ADR-003-x.md': 'architect',
    'contract/AGENTS.md': 'infra',
    // 實作
    'backend/src/index.ts': 'backend',
    'frontend/src/app.ts': 'frontend',
    'e2e/projects.spec.ts': 'qa',
    'e2e/server.ts': 'qa',
    // 最長前綴勝出:這三個在 qa 的 e2e/ 底下,但歸 infra(ADR-003 前提條件一)
    'e2e/tsconfig.json': 'infra',
    'e2e/package.json': 'infra',
    'e2e/AGENTS.md': 'infra',
    // 同一個形狀,只是本來就沒有跟誰重疊
    'backend/tsconfig.json': 'infra',
    'backend/package.json': 'infra',
    'backend/AGENTS.md': 'infra',
    'frontend/tsconfig.json': 'infra',
    'frontend/package.json': 'infra',
    'frontend/AGENTS.md': 'infra',
    'pnpm-workspace.yaml': 'infra',
  };

  for (const [file, owner] of Object.entries(expected)) {
    assert.equal(ownerOf(file, config)?.role, owner, `${file} 應該歸 ${owner}`);
  }
});

test('ADR-003 不變式:角色不得擁有宣告自己邊界的檔案', () => {
  // 「宣告該角色能 import 什麼、被什麼約束」的三種檔案。
  const declaring = ['AGENTS.md', 'tsconfig.json', 'package.json'];
  const homes = { backend: 'backend/', frontend: 'frontend/', qa: 'e2e/' };

  // architect 只有 AGENTS.md 這一個實例 —— contract/ 底下沒有 tsconfig.json
  // 或 package.json,那兩個路徑目前無主,不該假裝它們歸 infra。
  const cases = [
    ...Object.entries(homes).flatMap(([role, dir]) =>
      declaring.map((name) => [role, `${dir}${name}`]),
    ),
    ['architect', 'contract/AGENTS.md'],
  ];

  for (const [role, file] of cases) {
    assert.equal(
      ownerOf(file, config)?.role,
      'infra',
      `${file} 若歸 ${role} 自己,等於把鎖的鑰匙留在被鎖的人口袋裡`,
    );
  }
});

test('第四個實例:contract/AGENTS.md 歸 infra(CR-010 accepted)', () => {
  // 不變式的第四個實例,ADR-003 原文沒有列到,由 CR-010 補上:四份 AGENTS.md
  // 一致,不留例外。architect 的其餘 contract/ 不受影響。
  assert.equal(ownerOf('contract/AGENTS.md', config)?.role, 'infra');
  assert.equal(ownerOf('contract/openapi.yaml', config)?.role, 'architect');
  assert.equal(ownerOf('contract/decisions/ADR-001-x.md', config)?.role, 'architect');
});

test('陷阱一:change-requests/ 是加法,五個角色都寫得到', () => {
  // _everyone 若參與最長前綴比較,這裡會塌縮成一個角色(等長,勝負看鍵順序),
  // 其餘四個從此開不了 CR —— 而開 CR 是被 scope 擋下時唯一的合法出口。
  for (const role of ROLES) {
    assert.equal(
      classifyPath('change-requests/CR-999.md', role, config).kind,
      'everyone',
      `${role} 應該開得了 CR`,
    );
    assert.ok(canWrite(role, 'change-requests/CR-999.md', config));
  }
  assert.equal(ownerOf('change-requests/CR-999.md', config), null, '加法路徑不該有擁有者');
});

test('陷阱二:generated/ 是衍生產物,任何角色都不得手改', () => {
  for (const role of ROLES) {
    const verdict = classifyPath('generated/api.ts', role, config);
    assert.equal(verdict.kind, 'derived');
    assert.equal(canWrite(role, 'generated/api.ts', config), false, `${role} 不該手改衍生檔案`);
  }
  // 「可夾帶」與「可寫」是兩件事。
  assert.deepEqual(config._derived['generated/'].writers, ['architect', 'infra']);
});

test('不帶斜線的條目是精確比對,不是前綴', () => {
  assert.equal(ownerOf('AGENTS.md', config)?.role, 'infra');
  assert.equal(ownerOf('AGENTS.md.bak', config), null, '舊的 startsWith 會誤判這個');
  assert.equal(ownerOf('package.json.orig', config), null);
  // 目錄前綴照舊
  assert.equal(ownerOf('scripts/anything/deep.mjs', config)?.role, 'infra');
});

test('無主路徑不屬於任何人,不是屬於所有人', () => {
  for (const role of ROLES) {
    assert.equal(classifyPath('newdir/thing.ts', role, config).kind, 'unowned');
    assert.equal(canWrite(role, 'newdir/thing.ts', config), false);
  }
});

test('repo 之外的路徑不歸 scope 管', () => {
  assert.equal(classifyPath('/tmp/scratch.md', 'qa', config).kind, 'outside');
  assert.equal(canWrite('qa', '/tmp/scratch.md', config), true);
});

test('擁有權撞名會在載入時判錯,不會靜默由鍵順序決定', () => {
  const dup = {
    _everyone: ['change-requests/'],
    _derived: {},
    roles: { a: { allow: ['x/'] }, b: { allow: ['x/'] } },
  };
  assert.throws(() => validateScope(dup), /擁有者不唯一/);
});

test('roles 不得與加法路徑重疊', () => {
  const clashEveryone = {
    _everyone: ['change-requests/'],
    _derived: {},
    roles: { a: { allow: ['change-requests/urgent/'] } },
  };
  assert.throws(() => validateScope(clashEveryone), /_everyone/);

  const clashDerived = {
    _everyone: [],
    _derived: { 'generated/': { writers: [], inputs: [], guard: 'x' } },
    roles: { a: { allow: ['generated/api.ts'] } },
  };
  assert.throws(() => validateScope(clashDerived), /_derived/);
});
