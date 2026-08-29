/**
 * E2E — 由驗收條件寫成,只透過 HTTP 與 contract 溝通。
 * 本檔案「不」import backend/ 或 frontend/ 的任何內容,這是刻意的:
 * 測試驗證的是「規格說要做什麼」,不是「程式碼做了什麼」。
 *
 * 對應 contract/tasks.yaml 的 TASK-001 / TASK-002。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import type { components } from '../generated/api.js';

type Project = components['schemas']['Project'];

const BASE = 'http://localhost:3999';
let server: ChildProcess;

async function waitForServer(retries = 40): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await fetch(`${BASE}/projects`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error('backend 未在時限內啟動');
}

before(async () => {
  server = spawn('npx', ['tsx', 'backend/src/index.ts'], {
    env: { ...process.env, PORT: '3999' },
    stdio: 'ignore',
  });
  await waitForServer();
});

after(() => {
  server?.kill();
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
