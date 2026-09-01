/**
 * E2E — 語法錯誤的 JSON 也要回 Error schema。
 * 對應 contract/tasks.yaml 的 TASK-009 / AC-016。
 *
 * 這條 AC 沒有對應的 contract 變更 —— 契約本來就說兩支端點的 400 是
 * application/json 的 Error(見 openapi.yaml 各回應的 content),
 * 只是解析失敗那條路徑上實作沒有做到,回的是 express 預設的 HTML 頁面。
 * 由 architect 裁決 CR-012 時實測到,不是 qa 報的。
 *
 * 所以本檔驗的重點不只是「400」—— 狀態碼一直都對。**驗的是回應的形狀**:
 * content-type 是 application/json、body 解析得出 Error、code 給得出來。
 *
 * 獨立 port 3993 與獨立行程,理由同 CR-004。
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

const PORT = 3993;
const BASE = `http://localhost:${PORT}`;

// undefined 是有意義的狀態:before() 失敗時 after() 沒有東西可收。
let server: TestServer | undefined;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * 語法錯誤的 body 送不出去,除非繞過 JSON.stringify —— 這些字串就是重點,
 * 它們刻意不是合法的 JSON。
 */
const MALFORMED: Record<string, string> = {
  '截斷的物件': '{"name":',
  '沒有引號的鍵且未閉合': '{oops',
  '根本不是 JSON': 'not json at all',
  '多餘的逗號': '{"name": "x",}',
  '單引號': "{'name': 'x'}",
  '只有一個左括號': '{',
};

async function sendRaw(path: string, method: string, body: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { method, headers: JSON_HEADERS, body });
}

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

/**
 * AC-016 的核心。四件事一起驗,少任何一件都還原得回那個 HTML 頁面:
 *
 *   1. 400 —— 這件事本來就對,不是這條 AC 的重點
 *   2. content-type 是 application/json —— 原本是 text/html,契約說是 json
 *   3. body 真的解析得出 JSON —— content-type 說對了但內容還是 HTML 的話,
 *      client 一樣爆掉,所以標頭與內容要分開驗
 *   4. 解析出來的東西符合 Error —— 一個回 HTML 的回應根本給不出 code
 */
async function assertJsonError(res: Response, why: string): Promise<void> {
  assert.equal(res.status, 400, `${why}: 應回 400`);

  const contentType = res.headers.get('content-type') ?? '(無)';
  assert.ok(
    contentType.startsWith('application/json'),
    `${why}: content-type 應為 application/json,實際 ${contentType}`,
  );

  const text = await res.text();
  const parsed = parseOrFail(text, why);

  const err = parsed as ApiError;
  // 解析錯誤不需要新的 code 值(CR-012 裁決)。
  assert.equal(err.code, 'VALIDATION_ERROR', `${why}: code 不符`);
  assert.equal(typeof err.message, 'string', `${why}: message 應為字串`);
  assert.ok(err.message.length > 0, `${why}: message 不可為空`);
}

/** JSON.parse 失敗時給看得懂的訊息 —— 直接 res.json() 只會丟出無頭無尾的 SyntaxError。 */
function parseOrFail(text: string, why: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return assert.fail(`${why}: 回應不是合法的 JSON —— ${text.slice(0, 120)}`);
  }
}

before(async () => {
  server = await startServer(PORT);
});

after(async () => {
  await server?.stop();
});

describe('Projects API — 語法錯誤的 JSON', () => {
  test('AC-016: POST 的 body 是壞掉的 JSON 時回 400 且 body 是 Error schema', async () => {
    for (const [label, body] of Object.entries(MALFORMED)) {
      const before = (await list()).total;

      const res = await sendRaw('/projects', 'POST', body);
      await assertJsonError(res, `POST ${label}`);

      assert.equal((await list()).total, before, `POST ${label} 不該建立任何專案`);
    }
  });

  test('AC-016: PATCH 的 body 是壞掉的 JSON 時回 400 且 body 是 Error schema', async () => {
    const created = await createValidProject('要收到壞 JSON 的專案');

    for (const [label, body] of Object.entries(MALFORMED)) {
      const res = await sendRaw(`/projects/${created.id}`, 'PATCH', body);
      await assertJsonError(res, `PATCH ${label}`);

      const after = await fetchProject(created.id);
      assert.equal(after.status, 'active', `PATCH ${label} 不該改到狀態`);
      assert.equal(after.name, created.name, `PATCH ${label} 不該改到名稱`);
    }
  });

  test('AC-016: 不存在的 id 收到壞 JSON 時,一樣是 Error schema', async () => {
    // 解析發生在路由之前,所以這裡預期的是解析錯誤(400),不是 404。
    // 契約對兩者的要求相同:application/json 的 Error。這條的價值在於
    // 錯誤處理器擋在前面時,不會有某條路徑漏掉。
    const res = await sendRaw('/projects/does-not-exist', 'PATCH', '{"status":');
    await assertJsonError(res, 'PATCH 不存在的 id + 壞 JSON');
  });

  test('AC-016: 錯誤處理器不影響正常路徑', async () => {
    // 攔在最前面的錯誤處理器很容易連合法請求一起吃掉,那種紅燈在只驗
    // 負向的測試集裡看不見 —— 與 strict-body.spec.ts 的第三條同一個理由。
    const created = await createValidProject('壞 JSON 之後仍要能用');

    const res = await fetch(`${BASE}/projects/${created.id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: 'archived' }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Project).status, 'archived');
  });
});

async function createValidProject(name: string): Promise<Project> {
  const res = await fetch(`${BASE}/projects`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201, `建立「${name}」失敗`);
  return (await res.json()) as Project;
}
