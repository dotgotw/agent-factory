/**
 * E2E — 由驗收條件寫成,只透過 HTTP 與 contract 溝通。
 * 本檔案「不」import backend/ 或 frontend/ 的任何內容,這是刻意的:
 * 測試驗證的是「規格說要做什麼」,不是「程式碼做了什麼」。
 *
 * 對應 contract/tasks.yaml 的 TASK-001 / TASK-002。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type TestServer } from './server.js';
import type { components } from '@af/contract';

type Project = components['schemas']['Project'];

// port 由 OS 指派,在 before() 拿到 —— 寫死會在併發跑時互撞,見 server.ts。
let BASE: string;

// undefined 是有意義的狀態:before() 失敗時 after() 沒有東西可收。
let server: TestServer | undefined;

before(async () => {
  server = await startServer();
  BASE = server.base;
});

after(async () => {
  await server?.stop();
});

describe('Projects API', () => {
  test('AC-001: 新專案建立後狀態為 active', async () => {
    const res = await fetch(`${BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '客戶官網改版' }),
    });
    assert.equal(res.status, 201);

    const project = (await res.json()) as Project;
    assert.equal(project.name, '客戶官網改版');
    assert.equal(project.status, 'active');
    assert.ok(project.id);
    assert.ok(!Number.isNaN(Date.parse(project.createdAt)));
  });

  test('AC-002: 空白名稱應被拒絕並回 400', async () => {
    const res = await fetch(`${BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    assert.equal(res.status, 400);

    const err = (await res.json()) as components['schemas']['Error'];
    assert.equal(err.code, 'VALIDATION_ERROR');
  });

  test('AC-003: 建立後可於列表中查得', async () => {
    await fetch(`${BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '內部工單系統' }),
    });

    const res = await fetch(`${BASE}/projects`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { items: Project[] };
    assert.ok(body.items.some((p) => p.name === '內部工單系統'));
  });

  test('AC-004: 查詢不存在的專案回 404', async () => {
    const res = await fetch(`${BASE}/projects/does-not-exist`);
    assert.equal(res.status, 404);

    const err = (await res.json()) as components['schemas']['Error'];
    assert.equal(err.code, 'NOT_FOUND');
  });
});
