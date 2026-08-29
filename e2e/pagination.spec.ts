/**
 * E2E — 列表分頁。對應 contract/tasks.yaml 的 TASK-006(CR-003 階段二)。
 *
 * 與 projects.spec.ts 分檔的理由:
 * 1. `node --test` 會平行執行多個 spec 檔,共用同一 port 會互相干擾,
 *    故本檔使用 3998。
 * 2. 獨立的 server 行程等於獨立的記憶體 db,可斷言精確筆數,
 *    不必遷就其他測試累積的資料。
 *
 * 同樣不 import backend/ 的任何內容 —— 只透過 HTTP 與 contract 溝通。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import type { components, operations } from '../generated/api.js';

type Project = components['schemas']['Project'];
type ApiError = components['schemas']['Error'];
type ListResponse =
  operations['listProjects']['responses']['200']['content']['application/json'];

const BASE = 'http://localhost:3998';
const SEEDED = 25; // 刻意大於預設 limit(20),才驗得出預設值有生效。

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

async function list(query = ''): Promise<ListResponse> {
  const res = await fetch(`${BASE}/projects${query}`);
  assert.equal(res.status, 200);
  return (await res.json()) as ListResponse;
}

before(async () => {
  server = spawn('npx', ['tsx', 'backend/src/index.ts'], {
    env: { ...process.env, PORT: '3998' },
    stdio: 'ignore',
  });
  await waitForServer();

  // 依序建立,名稱可辨識順序,用於驗證 offset 取到的是不同批資料。
  for (let i = 1; i <= SEEDED; i++) {
    await fetch(`${BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `分頁測試專案 ${String(i).padStart(2, '0')}` }),
    });
  }
});

after(() => {
  server?.kill();
});

describe('Projects API — 分頁', () => {
  test('AC-010: 未帶參數時套用預設 limit=20、offset=0', async () => {
    const body = await list();
    assert.equal(body.items.length, 20, '預設應只回 20 筆');
    assert.equal(
      body.items[0]?.name,
      '分頁測試專案 01',
      'offset 預設為 0,應從第一筆開始',
    );
  });

  test('AC-010: limit 生效', async () => {
    const body = await list('?limit=5');
    assert.equal(body.items.length, 5);
  });

  test('AC-010: offset 生效且不與前一頁重疊', async () => {
    const page1 = await list('?limit=5&offset=0');
    const page2 = await list('?limit=5&offset=5');

    assert.equal(page2.items.length, 5);

    const ids1 = new Set(page1.items.map((p: Project) => p.id));
    const overlap = page2.items.filter((p: Project) => ids1.has(p.id));
    assert.equal(overlap.length, 0, '第二頁不應包含第一頁的項目');
  });

  test('AC-010: offset 超出總數時回空陣列而非報錯', async () => {
    const body = await list(`?offset=${SEEDED + 10}`);
    assert.equal(body.items.length, 0);
  });

  test('AC-011: total 為分頁前的總筆數,不隨 limit 改變', async () => {
    const full = await list();
    const paged = await list('?limit=5');

    assert.equal(full.total, SEEDED);
    assert.equal(paged.total, SEEDED, 'total 不應被 limit 影響');
    assert.equal(paged.items.length, 5, '但 items 應受 limit 限制');
  });

  test('AC-011: total 反映 status 篩選的結果', async () => {
    const active = await list('?status=active');
    const archived = await list('?status=archived');

    assert.equal(active.total, SEEDED, '全部皆為 active');
    assert.equal(archived.total, 0);
    assert.equal(archived.items.length, 0);
  });

  test('AC-012: limit 超出 1..100 範圍時回 400', async () => {
    for (const bad of ['0', '101', '-1']) {
      const res = await fetch(`${BASE}/projects?limit=${bad}`);
      assert.equal(res.status, 400, `limit=${bad} 應被拒絕`);

      const err = (await res.json()) as ApiError;
      assert.equal(err.code, 'VALIDATION_ERROR');
    }
  });

  test('AC-012: limit 非整數時回 400', async () => {
    for (const bad of ['abc', '1.5', '']) {
      const res = await fetch(`${BASE}/projects?limit=${bad}`);
      assert.equal(res.status, 400, `limit=${JSON.stringify(bad)} 應被拒絕`);
    }
  });

  test('AC-012: offset 為負數時回 400', async () => {
    const res = await fetch(`${BASE}/projects?offset=-1`);
    assert.equal(res.status, 400);

    const err = (await res.json()) as ApiError;
    assert.equal(err.code, 'VALIDATION_ERROR');
  });

  test('邊界: limit=1 與 limit=100 皆為合法', async () => {
    assert.equal((await list('?limit=1')).items.length, 1);
    assert.equal((await list('?limit=100')).items.length, SEEDED);
  });
});
