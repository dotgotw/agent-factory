/**
 * E2E — 專案封存。對應 contract/tasks.yaml 的 TASK-004 / AC-007。
 *
 * 與其他 spec 分檔的理由同 pagination.spec.ts:`node --test` 平行跑多個檔案,
 * 共用 server 會互相干擾,故本檔起自己的行程。獨立的行程等於獨立的記憶體 db,
 * 「封存後不出現在 status=active 的列表中」才驗得準 —— 別的檔案建的專案
 * 若混進來,這條斷言會變成在驗別人的資料。
 *
 * 同樣不 import backend/ 的任何內容,只透過 HTTP 與 contract 型別溝通。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type TestServer } from './server.js';
import type { components, operations } from '@af/contract';

type Project = components['schemas']['Project'];
type ApiError = components['schemas']['Error'];
type UpdateProjectRequest = components['schemas']['UpdateProjectRequest'];
type ListResponse =
  operations['listProjects']['responses']['200']['content']['application/json'];

// port 由 OS 指派,在 before() 拿到 —— 寫死會在併發跑時互撞,見 server.ts。
let BASE: string;

// undefined 是有意義的狀態:before() 失敗時 after() 沒有東西可收。
let server: TestServer | undefined;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function createProject(name: string): Promise<Project> {
  const res = await fetch(`${BASE}/projects`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
  // 前置資料建不起來,後面的斷言全部失去意義 —— 在這裡就講清楚。
  assert.equal(res.status, 201, `建立「${name}」失敗`);
  return (await res.json()) as Project;
}

/**
 * body 刻意收 unknown:合法的 body 由 UpdateProjectRequest 在呼叫端把關,
 * 而 400 那幾條要送的正是型別上不合法的東西(空物件、enum 外的字串)。
 */
async function patchProject(id: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}/projects/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** 錯誤回應的 code 由 openapi.yaml 的 Error enum 與各回應的 description 定義。 */
async function assertError(res: Response, code: ApiError['code']): Promise<void> {
  const err = (await res.json()) as ApiError;
  assert.equal(err.code, code);
  assert.ok(err.message.length > 0, 'Error.message 不可為空字串');
}

async function list(query = ''): Promise<ListResponse> {
  const res = await fetch(`${BASE}/projects${query}`);
  assert.equal(res.status, 200);
  return (await res.json()) as ListResponse;
}

const archive: UpdateProjectRequest = { status: 'archived' };

before(async () => {
  server = await startServer();
  BASE = server.base;

  // 這次 spawn 出來的行程一定是空的 db。不是空的,就代表回應的是別人 ——
  // 「不出現在 active 列表中」這種斷言對錯對象做,比失敗更糟(CR-004)。
  assert.equal((await list()).total, 0, 'server 不乾淨,列表斷言會被既有資料汙染');
});

after(async () => {
  await server?.stop();
});

describe('Projects API — 封存', () => {
  test('AC-007: 封存後回 200,回傳的 status 為 archived', async () => {
    const created = await createProject('待封存的官網專案');
    assert.equal(created.status, 'active', '前提:新專案應為 active');

    const res = await patchProject(created.id, archive);
    assert.equal(res.status, 200);

    const updated = (await res.json()) as Project;
    assert.equal(updated.status, 'archived');
    assert.equal(updated.id, created.id, '封存不應換一筆新的專案');
    assert.equal(updated.name, created.name, '封存不應動到名稱');
  });

  test('AC-007: 封存的狀態是持久的,重新查詢仍為 archived', async () => {
    // 只驗 PATCH 的回應,驗不出「狀態真的存下去了」——
    // 一個回傳正確 body 但沒寫入的實作會通過上一條。
    const created = await createProject('要重新查詢的專案');
    assert.equal((await patchProject(created.id, archive)).status, 200);

    const res = await fetch(`${BASE}/projects/${created.id}`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Project).status, 'archived');
  });

  test('AC-007: 封存後不出現在 status=active 的列表中', async () => {
    const kept = await createProject('保持 active 的專案');
    const archived = await createProject('從 active 消失的專案');
    assert.equal((await patchProject(archived.id, archive)).status, 200);

    const body = await list('?status=active');
    const ids = body.items.map((p: Project) => p.id);

    assert.ok(!ids.includes(archived.id), '已封存的專案不應出現在 active 列表');
    assert.ok(ids.includes(kept.id), '未封存的專案應留在 active 列表');
  });

  test('AC-007: 封存後出現在 status=archived 的列表中', async () => {
    const created = await createProject('要在 archived 列表出現的專案');
    assert.equal((await patchProject(created.id, archive)).status, 200);

    const body = await list('?status=archived');
    const hit = body.items.find((p: Project) => p.id === created.id);

    assert.ok(hit, '已封存的專案應出現在 archived 列表');
    assert.equal(hit.status, 'archived');
  });

  // AC-007 只講封存那一半,但 contract 的 operation summary 寫的是
  // 「更新專案狀態(封存 / 取消封存)」,enum 兩個值都是合法的目標狀態。
  // 只驗單向會讓「archived 是死路」的實作也通過。
  test('取消封存: archived 改回 active 並重新出現在 active 列表', async () => {
    const created = await createProject('封存後又要復原的專案');
    assert.equal((await patchProject(created.id, archive)).status, 200);

    const res = await patchProject(created.id, { status: 'active' } satisfies UpdateProjectRequest);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Project).status, 'active');

    const ids = (await list('?status=active')).items.map((p: Project) => p.id);
    assert.ok(ids.includes(created.id), '取消封存後應回到 active 列表');
  });

  test('AC-007: PATCH 不存在的 id 回 404,code 為 NOT_FOUND', async () => {
    const res = await patchProject('does-not-exist', archive);
    assert.equal(res.status, 404);
    await assertError(res, 'NOT_FOUND');
  });

  test('AC-007: status 不在 enum 內時回 400', async () => {
    const created = await createProject('狀態要被亂改的專案');

    for (const bad of ['bogus', 'ACTIVE', '', null, 123]) {
      const res = await patchProject(created.id, { status: bad });
      assert.equal(res.status, 400, `status=${JSON.stringify(bad)} 應被拒絕`);
      await assertError(res, 'VALIDATION_ERROR');
    }

    // 被拒絕的請求不該留下痕跡。
    const after = await fetch(`${BASE}/projects/${created.id}`);
    assert.equal(((await after.json()) as Project).status, 'active');
  });

  test('AC-007: body 為 {} 時回 400,不可以是一次「成功但什麼都沒做」的 PATCH', async () => {
    // UpdateProjectRequest 把 status 設為必填,理由寫在 openapi.yaml 的註解
    // 與 CR-001 裁決裡:靜默的成功比明確的失敗貴。
    const created = await createProject('要收到空 body 的專案');

    const res = await patchProject(created.id, {});
    assert.equal(res.status, 400);
    await assertError(res, 'VALIDATION_ERROR');

    const after = await fetch(`${BASE}/projects/${created.id}`);
    assert.equal(((await after.json()) as Project).status, 'active', '空 body 不該改動任何東西');
  });
});
