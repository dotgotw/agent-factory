/**
 * E2E — 已宣告的操作只在宣告的路徑上提供。
 * 對應 contract/tasks.yaml 的 TASK-011 / AC-018。
 *
 * 契約宣告的路徑是 `/projects` 與 `/projects/{projectId}`,逐字元。express 的
 * `case sensitive routing` 與 `strict routing` 預設都是 false,於是 `/Projects`、
 * `/projects/` 這些沒有宣告過的路徑會回一個**宣告過的成功回應** —— 契約之外
 * 長出一片沒有人寫下來、client 卻依賴得到的相容面。
 *
 * ## 這條 AC 刻意只斷言「不是成功的列表」
 *
 * 不斷言 404,也不斷言回應的 body 是 Error schema。那些路徑落在契約之外,
 * 而契約不描述它沒宣告的路徑回什麼 —— 那是 TASK-010 裁決時明確判「不做」的
 * 另一件事。在這裡斷言 404 的 body 形狀,等於用測試把一個被拒絕的決定偷渡
 * 進來。驗到「拿不到列表」就是這條 AC 的全部。
 *
 * 也因此 fetch 用預設的跟隨轉址:重點是「打這個路徑拿不拿得到列表」,
 * 一個 301 導回正規路徑在 client 看來與直接回列表沒有差別。
 *
 * 獨立行程(port 由 OS 指派),理由同 CR-004。
 * 同樣不 import backend/ 的任何內容,只透過 HTTP 與 contract 型別溝通。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type TestServer } from './server.js';
import type { components, operations } from '@af/contract';

type Project = components['schemas']['Project'];
type ListResponse =
  operations['listProjects']['responses']['200']['content']['application/json'];

// port 由 OS 指派,在 before() 拿到 —— 寫死會在併發跑時互撞,見 server.ts。
let BASE: string;

// undefined 是有意義的狀態:before() 失敗時 after() 沒有東西可收。
let server: TestServer | undefined;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** 種子:列表非空,否則「沒回傳列表」與「回了一個空列表」分不出來。 */
let seeded: Project;

async function list(path = '/projects'): Promise<ListResponse> {
  const res = await fetch(`${BASE}${path}`);
  assert.equal(res.status, 200);
  return (await res.json()) as ListResponse;
}

/** 這條路徑不得回傳成功的專案列表。見檔頭:只驗這一件事。 */
async function assertNotServed(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`);
  assert.notEqual(res.status, 200, `${path} 不該回成功 —— 它不是契約宣告的路徑`);
}

before(async () => {
  server = await startServer();
  BASE = server.base;

  const res = await fetch(`${BASE}/projects`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: '路徑測試用的專案' }),
  });
  assert.equal(res.status, 201, '種子資料建立失敗');
  seeded = (await res.json()) as Project;
});

after(async () => {
  await server?.stop();
});

describe('Projects API — 路徑逐字元', () => {
  test('AC-018: 大小寫不同的列表路徑不得回傳成功的專案列表', async () => {
    for (const path of ['/Projects', '/PROJECTS', '/pRoJeCtS', '/projectS']) {
      await assertNotServed(path);
    }
  });

  test('AC-018: 結尾斜線不同的列表路徑不得回傳成功的專案列表', async () => {
    for (const path of ['/projects/', '/projects//']) {
      await assertNotServed(path);
    }
  });

  test('AC-018: 單筆查詢的路徑同樣逐字元', async () => {
    // AC 的措辭是「大小寫或結尾斜線不同的路徑」,舉的例子是列表,但 strict
    // routing 與 case sensitive routing 是全域設定 —— 兩支端點要一起驗過,
    // 否則只有一半的路徑面被守住。
    for (const path of [`/Projects/${seeded.id}`, `/projects/${seeded.id}/`]) {
      await assertNotServed(path);
    }
  });

  test('AC-018: 未宣告的路徑也不得接受寫入', async () => {
    // 「回傳成功的列表」是這條 AC 的字面,但同一個 routing 設定管的是所有
    // method。POST 到 /Projects 若建立得了專案,那片契約之外的相容面依然存在,
    // 只是換一個動詞 —— 而寫入的那一面比讀取更難收回。
    const before = (await list()).total;

    const res = await fetch(`${BASE}/Projects`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: '從未宣告的路徑建立' }),
    });
    assert.notEqual(res.status, 201, 'POST /Projects 不該建立專案');

    assert.equal((await list()).total, before, '未宣告的路徑不該留下任何東西');
  });

  test('AC-018: 契約宣告的路徑仍然正常', async () => {
    // 把路徑收嚴很容易連正規路徑一起收掉,那種紅燈在只驗負向的測試集裡看不見。
    const body = await list();
    assert.ok(
      body.items.some((p: Project) => p.id === seeded.id),
      '/projects 應照常回傳列表',
    );

    const one = await fetch(`${BASE}/projects/${seeded.id}`);
    assert.equal(one.status, 200, '/projects/{id} 應照常回傳單筆');
    assert.equal(((await one.json()) as Project).id, seeded.id);
  });
});
