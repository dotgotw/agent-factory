/**
 * E2E 用的 backend 行程管理。七個 spec 檔共用 —— 它們踩的是同一個坑(CR-004):
 * 固定 port 加上 `stdio: 'ignore'`,會讓「spawn 失敗」跟「連上殘留的舊 server」
 * 變成同一種現象。測試照跑、照綠,但斷言的對象不是這次啟動的行程。
 *
 * 三道防線,順序有意義:
 *   1. 啟動前確認 port 是空的 —— 有人在聽就直接爆,不猜。
 *   2. 保留 stderr 並監聽 exit —— EADDRINUSE 這類錯誤不再被吞掉。
 *   3. 收尾等行程真的結束,必要時 SIGKILL —— 不把問題留給下一輪。
 *
 * ## port 為什麼由 OS 指派
 *
 * 原本每個 spec 各自寫死一個 port(3993…3999)。同一台機器上兩個 `pnpm verify`
 * 重疊時,兩邊的 spec 會撞在同一個 port 上,而防線 1 擋不住 —— 它是 TOCTOU:
 * 兩邊都檢查、當下都是空的、都放行,然後一邊綁到、另一邊 EADDRINUSE。
 * 死掉那邊的測試會對著活下來的那個 server 做斷言,直到對方收工把它 kill 掉,
 * 於是 ECONNRESET → ECONNREFUSED → 整批 cancelled。
 *
 * 防線 1 防的是「上一輪殘留的 server」,那個情境下它成立;併發打穿的是它的
 * **前提**,不是它本身。所以 assertPortFree() 留著,只是改成先跟 OS 要一個
 * 剛確認可用的 port,再馬上檢查、馬上 spawn —— 窗口從「整段測試」縮到毫秒級。
 *
 * **這不是零。** listen(0) 關掉之後到 backend 綁上去之間仍有窗口,只是從
 * 「兩個 run 對撞同一個固定 port」變成「對撞同一個隨機 port」。要真的歸零得讓
 * backend 自己選 port 再回報,那要改 backend/src/ —— 跨角色,得開 CR,
 * 而以目前的機率不值得。
 *
 *
 * ## fail=0 但 cancelled>0:認它,以及它其實是上面那個窗口
 *
 * 記在這裡是因為**這是七個 spec 唯一共用的檔案**,而下一次被取消的不一定是同一支
 * spec —— 放進某一支 spec 的註解,只有那一支再中的時候才幫得上忙。
 *
 *     e2e/malformed-json.spec.ts
 *     not ok  AC-016: POST 的 body 是壞掉的 JSON...
 *       failureType: 'cancelledByParent'
 *       error: 'test did not finish before its parent and was cancelled'
 *     # pass 47  fail 0  cancelled 4        exit=1
 *
 * 認它的特徵是 **fail=0、cancelled>0、exit 非零**:沒有任何一條斷言錯,是測試沒跑完
 * 就被父層取消。**看到 not ok 先往 failureType 看,不要先讀斷言訊息** —— 讀斷言會
 * 讓人以為是那支測試的問題,而被取消的那幾條完全是無辜的。
 *
 * ### 它的上游是 before() 的 hookFailed
 *
 * cancelledByParent 只是結果。同一份輸出裡往上找,會有一則 hookFailed:
 *
 *     failureType: 'hookFailed'
 *     Error: listen EADDRINUSE: address already in use :::49565
 *     # pass 45  fail 0  cancelled 6
 *
 * before() 綁不到 port → 那個 describe 的 subtest 一條都沒跑 → 全部 cancelled,
 * 而 fail 是 0 **正因為沒有斷言執行過**。所以這不是新的謎題,是上一節那個
 * 「listen(0) 關掉之後到 backend 綁上去之間仍有窗口」被真的撞到的樣子。
 *
 * 兩件事別搞混:CR-004 修的是「連上殘留的 server」(測試照綠,對象錯了),
 * 這個是「根本沒起來」(測試不綠,而且紅在無辜的地方)。同一個 port 窗口,
 * 兩種完全不同的症狀。
 *
 * ### 分母(比訊號本身重要)
 *
 *     infra       做別的事時順手撞到        約 1 / 8    (條件未受控)
 *     architect   閒置連跑 pnpm verify      0 / 10
 *     architect   4 個 pnpm verify 並行     1 / 12,接著 0 / 16
 *     qa          4 個 test:e2e 並行        1 / 64      (就是上面那份 EADDRINUSE)
 *
 * **不要把這幾列加起來。** 三個人量的不是同一條指令:`verify` 每次會多跑
 * check:boundaries 等七段、單次時間長好幾倍,`test:e2e` 只有測試 —— 每次 run 暴露
 * 在窗口下的時間不同,命中率本來就不可比。硬加出來的「2/92」是一個沒有意義的數字。
 * 能說的只有各列自己,以及一個量級:**並行時是百分之個位數,閒置時沒見過。**
 *
 * **「並行就能重現」不成立。** 那是第一次 1/12 之後的推論,再跑 16 次 0 命中就塌了。
 *
 * ### 再踩到的時候不要做的事
 *
 * 不要加 sleep、不要放寬斷言、不要為 ECONNRESET 加重試。百分之個位數的間歇
 * **單次綠不代表修好了** —— 一個什麼都沒改的分支九成以上的機率也是綠的。能當證據的是同一條指令在
 * 修法前後各跑幾十次的命中率,不是一次綠燈(agent-workflow 第 5 節)。
 *
 * ### 真正的修法不在這個檔案
 *
 * 要讓窗口歸零,得讓 backend 自己選 port 再回報,而那要改 backend/src/ —— 跨角色。
 * 依 ADR-009,跨 scope 的知識家是 CR:**見 change-requests/CR-013.md**。
 * 在它被裁決之前,這裡就是這件事唯一的記錄。
 *
 * ### 量分母的人請先按形狀分類,不要只看 exit code
 *
 * e2e 紅有不只一種原因。量這個間歇的時候,qa 在 64 次裡另外撞到 2 次
 * `fail=1 cancelled=0` —— 那是 notification.spec.ts 自己的時間窗下界取錯邊,
 * 與本節無關,已修(見該檔 AC-008 第三條的註解)。**兩種混在一起數,分母就沒有意義。**
 *
 * 本檔不是 spec(`test:e2e` 的 glob 只收 *.spec.ts),同樣不 import backend/。
 */
// 坑(下一個踩的人:qa):並行跑 e2e 偶發 fail=0/cancelled>0,根因是 before() 撞 EADDRINUSE —— 見本檔檔頭與 CR-013
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';

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
  /** 這次實際綁到的 port。 */
  readonly port: number;
  /** 這次實際綁到的 base URL,spec 用它組請求 —— 不要自己拼。 */
  readonly base: string;
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
 * 跟 OS 要一個當下沒人用的 port:綁 0 讓核心挑,拿到號碼就關掉。
 * 寫法與 scripts/dev-frontend.mjs 的 freePort() 同一套。
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
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

/**
 * 起一個 backend 行程。
 *
 * @param fixedPort 指定 port。**平常不要用** —— 併發時會撞。留著是為了驗證
 *   殘留偵測(手動佔住一個 port,再叫測試起在同一個上面,防線 1 應該爆)。
 */
export async function startServer(fixedPort?: number): Promise<TestServer> {
  const port = fixedPort ?? (await freePort());
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
    port,
    base,
    async stop(): Promise<void> {
      process.removeListener('exit', killOnExit);
      await terminate(child);
    },
  };
}
