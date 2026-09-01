/**
 * E2E — request body 的大小上限。對應 contract/tasks.yaml 的 TASK-010 / AC-017。
 *
 * 契約在 openapi.yaml 的 POST /projects 與 PATCH /projects/{projectId} 的 413。
 * 與 TASK-009 是同一個缺陷的第二個實例:**打的是一個已宣告的操作,拿到的卻是
 * 一個未宣告的回應形狀**(413 但 content-type 是 text/html)。所以驗的重點
 * 一樣不只是狀態碼,是回應的形狀。
 *
 * ## 為什麼不驗「上限是多少」
 *
 * 契約刻意不寫上限的數值 —— 那是部署與實作的選擇。所以這裡也不能寫死它,
 * 否則 infra 調整上限就會弄紅一條它沒動過的測試,而那條測試守的東西根本
 * 不是契約說的。契約保證的是「超過時回 413 且 body 是 Error」。
 *
 * 做法是送一個在任何合理部署下都算過大的 body:2 MiB。這個 API 最大的合法
 * body 是一個 name(contract 的 maxLength 是 80)加一個 email,差了四個
 * 數量級。**若哪天有人把上限調到 2 MiB 以上,這條會紅** —— 那時要改的是這個
 * 常數,不是把斷言放寬。這是「上限不進契約」的代價,寫在這裡讓它看得見。
 *
 * 獨立行程(port 由 OS 指派),理由同 CR-004。
 * 同樣不 import backend/ 的任何內容,只透過 HTTP 與 contract 型別溝通。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type TestServer } from './server.js';
import type { components, operations } from '@af/contract';

type Project = components['schemas']['Project'];
type ApiError = components['schemas']['Error'];
type ListResponse =
  operations['listProjects']['responses']['200']['content']['application/json'];

// port 由 OS 指派,在 before() 拿到 —— 寫死會在併發跑時互撞,見 server.ts。
let BASE: string;

// undefined 是有意義的狀態:before() 失敗時 after() 沒有東西可收。
let server: TestServer | undefined;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** 見檔頭:任何合理部署下都算過大,但不宣稱自己知道上限。 */
const OVERSIZED = 'x'.repeat(2 * 1024 * 1024);

async function list(): Promise<ListResponse> {
  const res = await fetch(`${BASE}/projects`);
  assert.equal(res.status, 200);
  return (await res.json()) as ListResponse;
}

async function fetchProject(id: string): Promise<Project> {
  const res = await fetch(`${BASE}/projects/${id}`);
  assert.equal(res.status, 200);
  return (await res.json()) as Project;
}

async function createProject(name: string): Promise<Project> {
  const res = await fetch(`${BASE}/projects`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201, `建立「${name}」失敗`);
  return (await res.json()) as Project;
}

/**
 * 四件事一起驗,少任何一件都還原得回那個 HTML 頁面 —— 與 malformed-json.spec.ts
 * 的 assertJsonError() 同一個形狀,因為它們是同一個缺陷的兩個實例。
 */
async function assertPayloadTooLarge(res: Response, why: string): Promise<void> {
  assert.equal(res.status, 413, `${why}: 應回 413`);

  const contentType = res.headers.get('content-type') ?? '(無)';
  assert.ok(
    contentType.startsWith('application/json'),
    `${why}: content-type 應為 application/json,實際 ${contentType}`,
  );

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return assert.fail(`${why}: 回應不是合法的 JSON —— ${text.slice(0, 120)}`);
  }

  const err = parsed as ApiError;
  // 專用的 code:把「你的 body 有 2MB」壓成 VALIDATION_ERROR 等於叫 client
  // 去改欄位,而它該做的是少送一點(TASK-010 的理由)。
  assert.equal(err.code, 'PAYLOAD_TOO_LARGE', `${why}: code 不符`);
  assert.ok(err.message.length > 0, `${why}: message 不可為空`);
}

before(async () => {
  server = await startServer();
  BASE = server.base;
});

after(async () => {
  await server?.stop();
});

describe('Projects API — body 大小上限', () => {
  test('AC-017: POST 的 body 過大時回 413 + PAYLOAD_TOO_LARGE,且沒有建立任何東西', async () => {
    const before = (await list()).total;

    const res = await fetch(`${BASE}/projects`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: OVERSIZED }),
    });
    await assertPayloadTooLarge(res, 'POST 過大的 body');

    assert.equal((await list()).total, before, '被拒絕的請求不該建立任何專案');
  });

  test('AC-017: PATCH 的 body 過大時回 413 + PAYLOAD_TOO_LARGE,且什麼都沒改', async () => {
    // PATCH 也宣告了 413,不是只有 POST —— 兩支端點的契約要各自驗過。
    const project = await createProject('要收到過大 body 的專案');

    const res = await fetch(`${BASE}/projects/${project.id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: OVERSIZED }),
    });
    await assertPayloadTooLarge(res, 'PATCH 過大的 body');

    const after = await fetchProject(project.id);
    assert.equal(after.status, 'active', '被拒絕的請求不該改到狀態');
    assert.equal(after.name, project.name, '被拒絕的請求不該改到名稱');
  });

  test('AC-017: 大小上限不影響正常請求', async () => {
    // 上限設得太緊會把合法請求一起擋掉,而那種紅燈在只驗負向的測試集裡
    // 看不見 —— 與 strict-body.spec.ts、malformed-json.spec.ts 同一個理由。
    // 用契約允許的最長 name(maxLength: 80)當上界。
    const created = await createProject('界'.repeat(80));
    assert.equal(created.name.length, 80);

    const res = await fetch(`${BASE}/projects/${created.id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: 'archived' }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Project).status, 'archived');
  });
});
