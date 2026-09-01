#!/usr/bin/env node
/**
 * scripts/dev-frontend.mjs —— 把 frontend 跑起來,讓人看得到畫面。
 *
 * 存在的理由:TASK-003 的 AC-005/AC-006 是 `verified_by: manual`,而人工驗收
 * 需要有東西可看 —— 這個 repo 到今天沒有任何 .html、沒有 bundler、沒有東西
 * 呼叫 mount()。CR-006 的裁決把「把 frontend 跑起來」列為 infra 要先提供的
 * 前置條件,這支就是它。
 *
 * ## 為什麼是這個形狀
 *
 * **不引入 bundler。** 現在要的是「讓那兩條 AC 看得到」,不是建一套前端工具鏈。
 * tsc 已經在手上,frontend 的 import 本來就帶 .js 副檔名(module: ESNext),
 * 產出來的就是瀏覽器直接吃得下的 ESM。等真的要把 AC-005/006 改成
 * verified_by: e2e(CR-006 的選項 1,瀏覽器測試),再談 vite —— 那時它的用途
 * 才具體,而且依 ADR-003 要開一份 CR。
 *
 * **不搶 port,而是做 bundler 本來就會做的那件事。**
 * frontend/src/api-client.ts 的 BASE 是 `import.meta.env?.VITE_API_BASE ??
 * 'http://localhost:3000'` —— 那是 Vite 的寫法,而 Vite 在 build 時會把
 * import.meta.env 替換成字面值。沒有 bundler 的話它是 undefined,BASE 就退回
 * 寫死的 3000。
 *
 * 第一版因此讓 harness 佔住 3000。實測撞到:這台機器的 3000 已經有別的服務
 * (與本專案無關),兩個 server 分別綁 127.0.0.1 與 *:3000 而共存,於是「畫面
 * 開起來是誰」取決於瀏覽器把 localhost 解析成 IPv4 還是 IPv6。那是最糟的一種
 * 不確定:畫面空白會被誤讀成「AC-006 的空狀態」。
 *
 * 改成在建置後把 import.meta.env 替換成字面值 —— 就是 Vite 會做的那個替換 ——
 * 然後 UI 與 backend 各自挑一個空的 port。頁面與 API 因此同源(API 由這支
 * 轉發),不需要 CORS,也不跟任何人搶 port。替換失敗時直接紅,不會安靜地
 * 送出一份仍然指著 3000 的 JS。
 *
 * 這是驗收用的 harness,不是產品的一部分:HTML 在這個檔案裡,frontend/src/
 * 一個字都沒有動。
 */
import { execFileSync, spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize } from 'node:path';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = join(rootDir, 'node_modules', '.cache', 'dev-frontend');
/** 跟 OS 要一個沒人用的 port。不寫死,理由見檔頭。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const UI_PORT = Number(process.env.UI_PORT ?? (await freePort()));
const API_PORT = Number(process.env.BACKEND_PORT ?? (await freePort()));
const UI_ORIGIN = `http://localhost:${UI_PORT}`;
const API_PREFIX = '/projects';

const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>專案列表 —— TASK-003 人工驗收</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
  .harness { background: #f6f6f6; border-left: 3px solid #999; padding: .75rem 1rem; font-size: .85rem; color: #444; }
  .projects { list-style: none; padding: 0; }
  .projects li { border-bottom: 1px solid #ddd; padding: .5rem 0; display: flex; gap: .75rem; align-items: baseline; }
  .status { font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: #666; }
  .empty { color: #666; font-style: italic; }
  form { display: flex; gap: .5rem; margin: 1.5rem 0; }
  input { flex: 1; padding: .4rem .6rem; font: inherit; }
</style>

<p class="harness">
  驗收用的 harness(<code>scripts/dev-frontend.mjs</code>),不是產品的一部分。
  <code>frontend/src/</code> 沒有被改動;建置產物裡的 <code>import.meta.env</code>
  被換成字面值,那是 Vite 在 build 時會做的同一個替換。<br>
  <strong>AC-005</strong> 顯示名稱、狀態、建立日期 —— 建一筆之後看下面的列表。<br>
  <strong>AC-006</strong> 無資料時顯示空狀態 —— backend 是 in-memory,剛啟動時就是這個狀態。
</p>

<h1>專案列表</h1>

<form id="create">
  <input name="name" placeholder="專案名稱" autocomplete="off">
  <button>建立</button>
</form>

<div id="root"></div>

<script type="module">
  import { mount, handleCreate } from './src/app.js';
  const root = document.getElementById('root');
  document.getElementById('create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = e.target.elements.name;
    if (!input.value.trim()) return;
    try { await handleCreate(input.value, root); input.value = ''; }
    catch (err) { alert(err.message); }
  });
  mount(root).catch((err) => {
    root.innerHTML = '<p class="empty">載入失敗:' + err.message + '</p>';
  });
</script>
`;

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

// ⓪ 先確認這個 checkout 的 workspace 真的裝好了。
//
//    不做這一步的話,最常見的失敗會長成一句誤導的話:tsc 吐
//    「Cannot find module '@af/contract'」,而那看起來像 workspace 設定壞了,
//    實際上多半只是這個 checkout 從來沒跑過 pnpm install —— 例如剛把
//    pnpm-workspace.yaml 拉進來的主 checkout。node_modules 不進版控,
//    git pull 不會幫你裝。
//
//    ADR-003 的代價那節也點過另一種:gen:types 失敗時 generated/ 是空的,
//    症狀同樣是「找不到 @af/contract」,但真正的原因在上一步。
const contractLink = join(rootDir, 'frontend', 'node_modules', '@af', 'contract');
if (!existsSync(contractLink)) {
  const generatedMissing = !existsSync(join(rootDir, 'generated', 'api.ts'));
  fail(
    `這個 checkout 的 workspace 還沒裝好 —— 找不到 ${contractLink}。\n` +
      (generatedMissing
        ? '   generated/api.ts 也不在,先跑 pnpm gen:types(它是 @af/contract 的內容)。\n'
        : '') +
      '   多半是這個目錄沒跑過 pnpm install。node_modules 不進版控,git pull 不會幫你裝:\n\n' +
      '     pnpm install\n\n' +
      '   不先擋下來的話,下一句會是 tsc 的「Cannot find module \'@af/contract\'」,\n' +
      '   那句話會把人帶去查 workspace 設定,而設定沒有問題。',
  );
}

// ① 編譯。frontend/tsconfig.json 是 noEmit,這裡用 CLI 覆寫 —— 不改那個檔案,
//    因為它同時是邊界的宣告(rootDir),不該為了 dev 工具動它。
console.log('編譯 frontend…');
rmSync(BUILD_DIR, { recursive: true, force: true });
try {
  execFileSync(
    join(rootDir, 'node_modules', '.bin', 'tsc'),
    ['-p', 'frontend/tsconfig.json', '--noEmit', 'false', '--outDir', BUILD_DIR],
    { cwd: rootDir, stdio: 'inherit' },
  );
} catch {
  fail('frontend 編譯失敗,先修好 pnpm typecheck 再來。');
}

// ①' 把 import.meta.env 換成字面值 —— Vite 在 build 時做的就是這件事。
//
//     只動建置產物,frontend/src/ 一個字都沒改。替換不到就直接紅:安靜地送出
//     一份仍然指著寫死 3000 的 JS,會讓畫面對著別人的服務發請求,然後空白。
const clientJs = join(BUILD_DIR, 'src', 'api-client.js');
if (!existsSync(clientJs)) fail(`建置產物少了 ${clientJs} —— frontend 的檔案結構變了?`);
const before = readFileSync(clientJs, 'utf8');
const after = before.replaceAll('import.meta.env', `(${JSON.stringify({ VITE_API_BASE: UI_ORIGIN })})`);
if (after === before) {
  fail(
    'api-client.js 裡找不到 import.meta.env —— frontend 改掉了讀 API base 的方式。\n' +
      '   在替換規則跟上之前,這支 harness 會讓畫面對著錯的位址發請求,所以直接停。',
  );
}
writeFileSync(clientJs, after, 'utf8');

// ② 起 backend。用 spawn 當行程,跟 e2e/server.ts 同一個做法 —— infra 不 import
//    實作模組(那也會被 check:boundaries 抓)。
const backend = spawn(process.execPath, ['--import', 'tsx', 'backend/src/index.ts'], {
  cwd: rootDir,
  env: { ...process.env, PORT: String(API_PORT) },
  stdio: ['ignore', 'ignore', 'inherit'],
});
backend.on('error', (err) => fail(`backend 起不來: ${err.message}`));

const shutdown = () => {
  backend.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ③ 靜態 + 反向代理,同源。
const server = createServer((req, res) => {
  if (req.url?.startsWith(API_PREFIX)) {
    const proxy = httpRequest(
      { host: '127.0.0.1', port: API_PORT, path: req.url, method: req.method, headers: req.headers },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      },
    );
    proxy.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`backend 連不上 (:${API_PORT}): ${err.message}`);
    });
    req.pipe(proxy);
    return;
  }

  const path = (req.url ?? '/').split('?')[0];
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  // normalize 之後再確認仍在 BUILD_DIR 底下 —— 這支只在本機跑,但沒有理由
  // 留一個 ../../ 就讀得到任意檔案的伺服器。
  const file = normalize(join(BUILD_DIR, path));
  if (!file.startsWith(BUILD_DIR) || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  res.writeHead(200, { 'content-type': `${MIME[extname(file)] ?? 'application/octet-stream'}; charset=utf-8` });
  res.end(readFileSync(file));
});

server.on('error', (err) => {
  backend.kill();
  if (err.code === 'EADDRINUSE') {
    fail(`:${UI_PORT} 被佔用了。不指定 UI_PORT 的話這支會自己挑一個空的。`);
  }
  fail(`伺服器起不來: ${err.message}`);
});

server.listen(UI_PORT, '127.0.0.1', () => {
  console.log('');
  console.log(`  畫面   ${UI_ORIGIN}`);
  console.log(`  API    轉發到 backend :${API_PORT}`);
  console.log('');
  console.log('  AC-005  顯示名稱、狀態、建立日期 —— 建一筆之後看列表');
  console.log('  AC-006  無資料時顯示空狀態 —— 剛啟動就是(backend 是 in-memory)');
  console.log('');
  console.log('  Ctrl-C 結束。');
});
