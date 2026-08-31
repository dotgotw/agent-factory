/**
 * E2E 用的 backend 行程管理。兩個 spec 檔共用 —— 它們踩的是同一個坑(CR-004):
 * 固定 port 加上 `stdio: 'ignore'`,會讓「spawn 失敗」跟「連上殘留的舊 server」
 * 變成同一種現象。測試照跑、照綠,但斷言的對象不是這次啟動的行程。
 *
 * 三道防線,順序有意義:
 *   1. 啟動前確認 port 是空的 —— 有人在聽就直接爆,不猜。
 *   2. 保留 stderr 並監聽 exit —— EADDRINUSE 這類錯誤不再被吞掉。
 *   3. 收尾等行程真的結束,必要時 SIGKILL —— 不把問題留給下一輪。
 *
 * 本檔不是 spec(`test:e2e` 的 glob 只收 *.spec.ts),同樣不 import backend/。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

/** 診斷用的 stderr 只需要尾端,不讓它無限成長。 */
const STDERR_LIMIT = 8192;

/** SIGTERM 之後等這麼久,再不走就 SIGKILL。 */
const TERM_GRACE_MS = 2000;

interface ProcState {
  /** 行程提早結束或根本沒起來的原因;null 代表還活著。 */
  died: string | null;
  stderr: string;
}

export interface TestServer {
  /** 關掉行程,並等它真的結束。 */
  stop(): Promise<void>;
}

function sleep(ms: number, unref = false): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (unref) timer.unref();
  });
}

/**
 * port 上已經有人在聽,就代表這次的 spawn 綁不到 port。
 * 此時 `waitForServer()` 會連上那個「別人」,測試從此對著上一輪的資料做斷言。
 */
async function assertPortFree(base: string, port: number): Promise<void> {
  try {
    await fetch(`${base}/projects`, { signal: AbortSignal.timeout(500) });
  } catch {
    return; // 連不上 = port 是空的,這才是正常路徑
  }
  throw new Error(
    `${base} 已經有 server 在聽 —— 那不可能是這次要啟動的行程。\n` +
      `殘留的 server 會讓測試對著上一輪的資料做斷言,先關掉再跑:\n` +
      `  lsof -ti tcp:${port} | xargs kill`,
  );
}

function fatal(state: ProcState): Error {
  const reason = state.died ?? 'backend 行程異常結束';
  const tail = state.stderr.trim();
  return new Error(tail ? `${reason}\n--- backend stderr ---\n${tail}` : reason);
}

async function waitForServer(
  base: string,
  state: ProcState,
  retries = 40,
): Promise<void> {
  for (let i = 0; i < retries; i++) {
    if (state.died !== null) throw fatal(state);

    try {
      await fetch(`${base}/projects`, { signal: AbortSignal.timeout(1000) });
    } catch {
      await sleep(250);
      continue;
    }

    // 有東西回應了。再確認行程還活著 —— 若它其實已經死了,
    // 回應的就是別人,後面所有斷言都失去意義。
    if (state.died !== null) throw fatal(state);
    return;
  }
  throw new Error(`backend 未在時限內於 ${base} 啟動`);
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    closeStderr(child);
    return; // 已經結束
  }

  const exited = once(child, 'exit'); // 先掛監聽,才不會錯過 kill 後的事件
  child.kill('SIGTERM');

  const inTime = await Promise.race([
    exited.then(() => true),
    sleep(TERM_GRACE_MS, true).then(() => false),
  ]);
  if (inTime) {
    closeStderr(child);
    return;
  }

  // 卡住的行程會佔著 port 害下一輪,不留餘地。
  child.kill('SIGKILL');
  await exited;
  closeStderr(child);
}

/** pipe 的讀取端留著就是一個 open handle,行程會因此不肯結束。 */
function closeStderr(child: ChildProcess): void {
  child.stderr?.destroy();
}

export async function startServer(port: number): Promise<TestServer> {
  const base = `http://localhost:${port}`;
  await assertPortFree(base, port);

  // 直接跑 node,不透過 npx。npx 會多包一層外殼行程,`kill` 打到的是外殼,
  // 真正的 server 是它的孫行程 —— 活下來繼續佔著 port(正是本 CR 的根因),
  // 而且抓著下面那條 stderr pipe 不放,害 `node --test` 的子行程永遠等不到
  // stream 結束而卡住。`--import tsx` 與 package.json 的 test:e2e 同一套。
  const child = spawn(process.execPath, ['--import', 'tsx', 'backend/src/index.ts'], {
    env: { ...process.env, PORT: String(port) },
    // stdout 丟掉(啟動訊息對測試沒用),但 stderr 一定要留:
    // EADDRINUSE 這種真正需要看到的錯誤只會出現在那裡。
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const state: ProcState = { died: null, stderr: '' };
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    state.stderr = (state.stderr + chunk).slice(-STDERR_LIMIT);
  });
  child.on('error', (err: Error) => {
    state.died = `backend 行程啟動失敗:${err.message}`;
  });
  child.on('exit', (code, signal) => {
    state.died = `backend 行程在就緒前就結束了(code=${code}, signal=${signal})`;
  });

  try {
    await waitForServer(base, state);
  } catch (err) {
    await terminate(child); // 起不來也要收乾淨,否則下一輪照樣中招
    throw err;
  }

  // 測試中途 throw 或整個 run 被中斷時,after() 不保證跑得到。
  // 這道保險讓 backend 行程不會活過父行程 —— 正是 CR-004 的殘留來源。
  const killOnExit = (): void => {
    child.kill('SIGKILL');
  };
  process.once('exit', killOnExit);

  return {
    async stop(): Promise<void> {
      process.removeListener('exit', killOnExit);
      await terminate(child);
    },
  };
}
