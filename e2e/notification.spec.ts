/**
 * E2E — 負責人通知。對應 contract/tasks.yaml 的 TASK-005 / AC-008、AC-009、AC-014。
 *
 * 這三條驗的是副作用,而黑箱看不見副作用本身。ADR-004 的決定是在 contract 上
 * 留一個可觀察面:`Project.lastNotifiedAt`(唯讀,只由狀態異動產生)。所以本檔
 * 驗的不是「信寄出去了」,是契約說會跟著改變的那個欄位 —— 改的是驗收方式,
 * 不是驗收意圖。
 *
 * 契約在 openapi.yaml 的 PATCH /projects/{projectId} description,三條行為
 * 都寫在那裡。獨立行程(port 由 OS 指派),理由同 CR-004。
 *
 * 同樣不 import backend/ 的任何內容,只透過 HTTP 與 contract 型別溝通。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type TestServer } from './server.js';
import type { components } from '@af/contract';

type Project = components['schemas']['Project'];
type ProjectStatus = components['schemas']['ProjectStatus'];
type CreateProjectRequest = components['schemas']['CreateProjectRequest'];

// port 由 OS 指派,在 before() 拿到 —— 寫死會在併發跑時互撞,見 server.ts。
let BASE: string;

// undefined 是有意義的狀態:before() 失敗時 after() 沒有東西可收。
let server: TestServer | undefined;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function createProject(body: CreateProjectRequest): Promise<Project> {
  const res = await fetch(`${BASE}/projects`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201, `建立「${body.name}」失敗`);
  return (await res.json()) as Project;
}

async function setStatus(id: string, status: ProjectStatus): Promise<Project> {
  const res = await fetch(`${BASE}/projects/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ status }),
  });
  // 通知失敗不會讓 PATCH 失敗(ADR-004 第三條),所以這裡永遠期望 200 ——
  // 通知有沒有發生,看的是 lastNotifiedAt,不是狀態碼。
  assert.equal(res.status, 200, `把 ${id} 改成 ${status} 失敗`);
  return (await res.json()) as Project;
}

async function fetchProject(id: string): Promise<Project> {
  const res = await fetch(`${BASE}/projects/${id}`);
  assert.equal(res.status, 200);
  return (await res.json()) as Project;
}

/**
 * 「不出現這個欄位」要用 in 檢查,不是比對 undefined ——
 * lastNotifiedAt: null 也會讓 undefined 的比對通過,而 null 不是「不出現」。
 */
function assertNotNotified(p: Project, why: string): void {
  assert.ok(!('lastNotifiedAt' in p), `${why}(實際: ${JSON.stringify(p.lastNotifiedAt)})`);
}

/**
 * 時間窗的下界。日期若以秒為精度序列化,毫秒級的 Date.now() 會比它晚,
 * 造成偽紅 —— 往下取整到秒,窗就對得上,而斷言的強度不變。
 */
function windowStart(): number {
  return Math.floor(Date.now() / 1000) * 1000;
}

/** 這個時間戳記是不是落在「這次請求發生的期間」。 */
function assertWithinWindow(iso: string | undefined, start: number, why: string): number {
  assert.ok(iso !== undefined, `${why}:應該有 lastNotifiedAt`);
  const at = Date.parse(iso);
  assert.ok(!Number.isNaN(at), `${why}:lastNotifiedAt 應為合法的 date-time,實際 ${iso}`);
  assert.ok(at >= start, `${why}:lastNotifiedAt (${iso}) 早於這次請求`);
  assert.ok(at <= Date.now() + 1000, `${why}:lastNotifiedAt (${iso}) 在未來`);
  return at;
}

before(async () => {
  server = await startServer();
  BASE = server.base;
});

after(async () => {
  await server?.stop();
});

describe('Projects API — 負責人通知', () => {
  test('AC-008: 設有 ownerEmail 的專案狀態異動後,lastNotifiedAt 更新為該次通知時間', async () => {
    const created = await createProject({
      name: '有負責人的專案',
      ownerEmail: 'owner@example.com',
    });

    // 前提有兩層:ownerEmail 真的寫進去了(ADR-004 補的寫入路徑),
    // 而且還沒有通知過 —— 否則下一步的「更新」無從判斷。
    assert.equal(created.ownerEmail, 'owner@example.com', '建立時帶的 ownerEmail 應被保存');
    assertNotNotified(created, '剛建立、還沒有狀態異動,不該有 lastNotifiedAt');

    const start = windowStart();
    const updated = await setStatus(created.id, 'archived');

    assert.equal(updated.status, 'archived');
    assertWithinWindow(updated.lastNotifiedAt, start, '狀態異動後');
  });

  test('AC-008: lastNotifiedAt 是持久的,重新查詢讀得到同一個值', async () => {
    // 只驗 PATCH 的回應,驗不出「這個欄位真的存下去了」——
    // 一個把時間戳記算在回應裡卻沒寫入的實作會通過上一條。
    const created = await createProject({
      name: '要重新查詢通知時間的專案',
      ownerEmail: 'owner@example.com',
    });
    const patched = await setStatus(created.id, 'archived');

    const fetched = await fetchProject(created.id);
    assert.equal(fetched.lastNotifiedAt, patched.lastNotifiedAt);
  });

  test('AC-008: 每一次真正的狀態異動都會通知,時間往前推進', async () => {
    const created = await createProject({
      name: '要被異動兩次的專案',
      ownerEmail: 'owner@example.com',
    });

    const first = await setStatus(created.id, 'archived');
    const firstAt = assertWithinWindow(first.lastNotifiedAt, windowStart(), '第一次異動');

    const start = windowStart();
    const second = await setStatus(created.id, 'active');
    const secondAt = assertWithinWindow(second.lastNotifiedAt, start, '第二次異動');

    // 不用嚴格大於:兩次請求可能落在同一毫秒,那會是偽紅。
    // 「有沒有重新通知」由上面的時間窗負責 —— 第二個值必須晚於第二次請求之前
    // 的那一刻,而那一刻已經在第一次回應收到之後。
    assert.ok(secondAt >= firstAt, '第二次通知不應早於第一次');
  });

  test('AC-009: 未設 ownerEmail 時略過通知,PATCH 仍回 200 且不出現 lastNotifiedAt', async () => {
    const created = await createProject({ name: '沒有負責人的專案' });
    assert.ok(!('ownerEmail' in created), '沒帶 ownerEmail 就不該有這個欄位');

    // setStatus 內部已斷言 200 —— 「略過通知」不是錯誤,這正是 AC-009 的重點。
    const updated = await setStatus(created.id, 'archived');

    assert.equal(updated.status, 'archived', '沒有負責人不影響狀態本身要改');
    assertNotNotified(updated, '沒有 ownerEmail 就不該通知');
    assertNotNotified(await fetchProject(created.id), '重新查詢仍不該有 lastNotifiedAt');
  });

  test('AC-014: 狀態未實際改變時不通知 —— 從未通知過的專案仍然沒有 lastNotifiedAt', async () => {
    const created = await createProject({
      name: '被原地改成同一個狀態的專案',
      ownerEmail: 'owner@example.com',
    });

    const same = await setStatus(created.id, 'active'); // 本來就是 active

    assert.equal(same.status, 'active');
    assertNotNotified(same, 'active → active 不是狀態異動,不該通知');
  });

  test('AC-014: 已通知過的專案再收到同狀態的 PATCH,lastNotifiedAt 不變', async () => {
    // 上一條驗的是「不要無中生有」,這條驗的是「不要重複騷擾」——
    // 一個只看「有沒有 ownerEmail」就通知的實作會在這裡露出來,
    // 而這正是 ADR-004 點名的「會重試的 client 變成騷擾負責人的機器」。
    const created = await createProject({
      name: '通知過之後被重複 PATCH 的專案',
      ownerEmail: 'owner@example.com',
    });

    const notified = await setStatus(created.id, 'archived');
    const notifiedAt = notified.lastNotifiedAt;
    assert.ok(notifiedAt !== undefined, '前提:第一次異動應該通知過');

    const again = await setStatus(created.id, 'archived'); // archived → archived

    assert.equal(again.status, 'archived');
    assert.equal(again.lastNotifiedAt, notifiedAt, '狀態沒變就不該重新通知');
    assert.equal((await fetchProject(created.id)).lastNotifiedAt, notifiedAt);
  });
});
