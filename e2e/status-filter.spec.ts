/**
 * E2E — 列表的 status 篩選參數驗證。對應 contract/tasks.yaml 的 TASK-007 / AC-013。
 *
 * 契約在 openapi.yaml 的 GET /projects:400 的 description 同時涵蓋
 * limit、offset 與 status,並且把「空字串等同未帶此參數」寫死在那裡。
 *
 * 獨立 port 3996 與獨立行程,理由同 pagination.spec.ts(CR-004):本檔要斷言
 * 「帶空字串」與「完全不帶」的回應**逐欄相同**,別的檔案建的資料混進來會讓
 * 這條斷言變成在驗別人的東西。
 *
 * 同樣不 import backend/ 的任何內容,只透過 HTTP 與 contract 型別溝通。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type TestServer } from './server.js';
import type { components, operations } from '@af/contract';

type Project = components['schemas']['Project'];
type ApiError = components['schemas']['Error'];
type ProjectStatus = components['schemas']['ProjectStatus'];
type ListResponse =
  operations['listProjects']['responses']['200']['content']['application/json'];

const PORT = 3996;
const BASE = `http://localhost:${PORT}`;

const ACTIVE_SEEDED = 3;
const ARCHIVED_SEEDED = 2;
const SEEDED = ACTIVE_SEEDED + ARCHIVED_SEEDED;

// undefined 是有意義的狀態:before() 失敗時 after() 沒有東西可收。
let server: TestServer | undefined;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function seed(name: string, status: ProjectStatus): Promise<void> {
  const res = await fetch(`${BASE}/projects`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201, `建立「${name}」失敗`);

  if (status === 'active') return;

  const { id } = (await res.json()) as Project;
  const patched = await fetch(`${BASE}/projects/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ status }),
  });
  assert.equal(patched.status, 200, `把「${name}」改成 ${status} 失敗`);
}

async function list(query = ''): Promise<ListResponse> {
  const res = await fetch(`${BASE}/projects${query}`);
  assert.equal(res.status, 200, `${query || '(不帶參數)'} 應為 200`);
  return (await res.json()) as ListResponse;
}

/**
 * GET /projects 的 400 一律是 VALIDATION_ERROR —— 寫在該回應的 description 裡,
 * 而 code 的合法值由 Error 的 enum 收斂(CR-012 裁決)。
 */
async function assertRejected(query: string): Promise<void> {
  const res = await fetch(`${BASE}/projects${query}`);
  assert.equal(res.status, 400, `${query} 應被拒絕`);

  const err = (await res.json()) as ApiError;
  assert.equal(err.code, 'VALIDATION_ERROR', `${query}: code 不符`);
  assert.ok(err.message.length > 0, `${query}: Error.message 不可為空`);
}

before(async () => {
  server = await startServer(PORT);

  // 這次 spawn 出來的行程一定是空的 db。不是空的,就代表回應的是別人 ——
  // 本檔的斷言全是精確筆數與逐欄比對(CR-004)。
  assert.equal((await list()).total, 0, 'server 不乾淨,篩選斷言會被既有資料汙染');

  for (let i = 1; i <= ACTIVE_SEEDED; i++) await seed(`篩選測試 active ${i}`, 'active');
  for (let i = 1; i <= ARCHIVED_SEEDED; i++) await seed(`篩選測試 archived ${i}`, 'archived');
});

after(async () => {
  await server?.stop();
});

describe('Projects API — status 篩選參數', () => {
  test('AC-013: status 不在 ProjectStatus 的 enum 內時回 400', async () => {
    for (const bad of [
      'bogus',
      'deleted',
      'null',
      'ACTIVE', // enum 大小寫敏感
      'Active',
      'active,archived', // 逗號分隔不是 enum 的一員
    ]) {
      await assertRejected(`?status=${encodeURIComponent(bad)}`);
    }
  });

  test('AC-013: 只有空字串是例外,空白字元不是', async () => {
    // 契約放行的是「空字串」這一個值,不是「看起來像沒填」。一個做了 trim
    // 的實作會把這幾個也當成未帶參數 —— 那比契約寬,而放寬是不會有人發現的。
    for (const blank of ['%20', '+', '%09']) {
      await assertRejected(`?status=${blank}`);
    }
    await assertRejected('?status=active%20'); // 合法值加上尾隨空白仍然不合法
  });

  test('AC-013: 重複帶 status 參數回 400', async () => {
    // 重複的 query key 會拿到陣列,而陣列不是 ProjectStatus 的一員。
    await assertRejected('?status=active&status=archived');
    await assertRejected('?status=active&status=active');
  });

  test('AC-013: 空字串視同未帶此參數,回應與不帶時逐欄相同', async () => {
    const without = await list();
    const withEmpty = await list('?status=');

    // 先確定這個比較不是在比兩個空集合 —— 那樣「永遠篩不到」的實作也會過,
    // 而那正是這條 AC 最容易寫錯的地方。
    assert.equal(without.total, SEEDED, '前提:不帶參數應看得到全部種子資料');
    assert.ok(without.items.length > 0, '前提:不帶參數的 items 不可為空');

    assert.deepEqual(withEmpty, without, 'status= 應等同未帶此參數,不做任何篩選');
  });

  test('AC-013: 空字串與其他參數併用時同樣不篩選', async () => {
    // client 無條件串上 &status= 是契約點名的常見寫法,它通常還帶著分頁參數。
    assert.deepEqual(await list('?limit=2&status='), await list('?limit=2'));
  });

  test('AC-013: status=active 只回 active', async () => {
    const body = await list('?status=active');

    assert.equal(body.total, ACTIVE_SEEDED);
    assert.equal(body.items.length, ACTIVE_SEEDED);
    assert.ok(
      body.items.every((p: Project) => p.status === 'active'),
      'active 的篩選結果不應含其他狀態',
    );
  });

  test('AC-013: status=archived 只回 archived', async () => {
    const body = await list('?status=archived');

    assert.equal(body.total, ARCHIVED_SEEDED);
    assert.equal(body.items.length, ARCHIVED_SEEDED);
    assert.ok(
      body.items.every((p: Project) => p.status === 'archived'),
      'archived 的篩選結果不應含其他狀態',
    );
  });

  test('AC-013: 不帶 status 時兩種狀態都在', async () => {
    const body = await list();

    assert.equal(body.total, SEEDED);

    const statuses = new Set(body.items.map((p: Project) => p.status));
    assert.ok(statuses.has('active'), '不篩選時應含 active');
    assert.ok(statuses.has('archived'), '不篩選時應含 archived');
  });
});
