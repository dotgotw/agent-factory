/**
 * E2E — request body 的未定義欄位一律拒絕。
 * 對應 contract/tasks.yaml 的 TASK-008 / AC-015。
 *
 * 契約在 openapi.yaml 的兩個 request schema:CreateProjectRequest 與
 * UpdateProjectRequest 都是 additionalProperties: false,而兩支端點的 400
 * description 都寫明「body 出現未定義的欄位」。
 *
 * 這條 AC 驗的是「不靜默忽略」,所以每一條都驗兩件事:回 400,而且**什麼都
 * 沒發生**。只驗狀態碼的話,一個「先套用再拒絕」的實作也會過。
 *
 * 獨立 port 3994 與獨立行程,理由同 CR-004。
 * 同樣不 import backend/ 的任何內容,只透過 HTTP 與 contract 型別溝通。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type TestServer } from './server.js';
import type { components, operations } from '@af/contract';

type Project = components['schemas']['Project'];
type ApiError = components['schemas']['Error'];
type CreateProjectRequest = components['schemas']['CreateProjectRequest'];
type ListResponse =
  operations['listProjects']['responses']['200']['content']['application/json'];

const PORT = 3994;
const BASE = `http://localhost:${PORT}`;

// undefined 是有意義的狀態:before() 失敗時 after() 沒有東西可收。
let server: TestServer | undefined;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** body 收 unknown:這個檔案要送的正是型別上不合法的東西。 */
async function post(body: unknown): Promise<Response> {
  return fetch(`${BASE}/projects`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

async function patch(id: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}/projects/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

async function list(query = ''): Promise<ListResponse> {
  const res = await fetch(`${BASE}/projects${query}`);
  assert.equal(res.status, 200);
  return (await res.json()) as ListResponse;
}

async function fetchProject(id: string): Promise<Project> {
  const res = await fetch(`${BASE}/projects/${id}`);
  assert.equal(res.status, 200);
  return (await res.json()) as Project;
}

/**
 * 兩支端點的 400 都一律是 VALIDATION_ERROR —— 寫在各自回應的 description 裡,
 * 而 code 的合法值由 Error 的 enum 收斂(CR-012 裁決)。
 */
async function assertErrorBody(res: Response, why: string): Promise<void> {
  const err = (await res.json()) as ApiError;
  assert.equal(err.code, 'VALIDATION_ERROR', `${why}: code 不符`);
  assert.ok(err.message.length > 0, `${why}: Error.message 不可為空`);
}

/** 建一筆乾淨的 active 專案當作 PATCH 的對象。 */
async function seed(name: string): Promise<Project> {
  const res = await post({ name } satisfies CreateProjectRequest);
  assert.equal(res.status, 201, `建立「${name}」失敗`);
  return (await res.json()) as Project;
}

before(async () => {
  server = await startServer(PORT);
});

after(async () => {
  await server?.stop();
});

describe('Projects API — request body 的未定義欄位', () => {
  test('AC-015: POST 的 body 出現未定義欄位時回 400,且沒有建立任何東西', async () => {
    const bodies: Record<string, unknown>[] = [
      // 欄位名打錯一個字 —— 這是 #68 實測的案例,也是最真實的一種。
      { name: 'typo 專案', ownerEmial: 'typo@example.com' },
      // status 不在 CreateProjectRequest 裡:新專案一律 active,不接受指定。
      { name: '想自己指定狀態', status: 'archived' },
      // 唯讀欄位不出現在任何 request schema(ADR-004)。
      { name: '想自己指定通知時間', lastNotifiedAt: '2026-01-01T00:00:00.000Z' },
      { name: '想自己指定 id', id: 'forced-id' },
      { name: '完全不相干的欄位', whatever: 1 },
    ];

    for (const body of bodies) {
      const before = (await list()).total;

      const res = await post(body);
      const why = `POST ${JSON.stringify(body)}`;
      assert.equal(res.status, 400, `${why} 應被拒絕`);
      await assertErrorBody(res, why);

      // 「不靜默忽略」的另一半:拒絕了就不該留下東西。
      assert.equal((await list()).total, before, `${why} 不該建立任何專案`);
    }
  });

  test('AC-015: PATCH 的 body 出現未定義欄位時回 400,且什麼都沒改', async () => {
    const project = await seed('要被亂 PATCH 的專案');

    const bodies: Record<string, unknown>[] = [
      // ADR-004 明說改既有專案的 ownerEmail 沒有路徑,client 遲早會這樣送。
      { status: 'archived', ownerEmail: 'new@example.com' },
      { status: 'archived', name: '順便改名' },
      { status: 'archived', lastNotifiedAt: '2026-01-01T00:00:00.000Z' },
      { status: 'archived', whatever: 1 },
      // 只有未定義欄位、連必填的 status 都沒有 —— 一樣是 400。
      { ownerEmail: 'new@example.com' },
    ];

    for (const body of bodies) {
      const res = await patch(project.id, body);
      const why = `PATCH ${JSON.stringify(body)}`;
      assert.equal(res.status, 400, `${why} 應被拒絕`);
      await assertErrorBody(res, why);

      // 被拒絕的請求不該做到一半 —— 一個「先套用再驗證」的實作會在這裡露出來。
      const after = await fetchProject(project.id);
      assert.equal(after.status, 'active', `${why} 不該改到狀態`);
      assert.equal(after.name, project.name, `${why} 不該改到名稱`);
      assert.ok(!('ownerEmail' in after), `${why} 不該寫進 ownerEmail`);
      assert.ok(!('lastNotifiedAt' in after), `${why} 不該觸發通知`);
    }
  });

  test('AC-015: schema 定義過的欄位不受影響', async () => {
    // 這條是給實作的護欄,不是給契約的。additionalProperties: false 做得太用力
    // 會連合法欄位一起擋掉 —— 那種紅燈在只驗負向的測試集裡看不見。
    const res = await post({
      name: '合法的完整 body',
      ownerEmail: 'owner@example.com',
    } satisfies CreateProjectRequest);
    assert.equal(res.status, 201, 'CreateProjectRequest 定義過的欄位不該被拒絕');

    const created = (await res.json()) as Project;
    assert.equal(created.ownerEmail, 'owner@example.com');

    const patched = await patch(created.id, { status: 'archived' });
    assert.equal(patched.status, 200, 'UpdateProjectRequest 定義過的欄位不該被拒絕');
    assert.equal(((await patched.json()) as Project).status, 'archived');
  });
});
