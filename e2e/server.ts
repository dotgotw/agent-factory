/**
 * E2E 用的 backend 行程管理。九個 spec 檔共用 —— 它們踩的是同一個坑(CR-004):
 * 固定 port 加上 `stdio: 'ignore'`,會讓「spawn 失敗」跟「連上殘留的舊 server」
 * 變成同一種現象。測試照跑、照綠,但斷言的對象不是這次啟動的行程。
 *
 * 三道防線,順序有意義:
 *   1. 選 port 與綁 port 是同一個動作 —— 不存在「已選但未綁」的窗口(見下)。
 *   2. 保留 stdout/stderr 並監聽 exit —— 就緒訊號與錯誤都不再被吞掉。
 *   3. 收尾等行程真的結束,必要時 SIGKILL —— 不把問題留給下一輪。
 *
 * ## port 由 backend 自己選,再從 stdout 回報
 *
 * 演化過三代,每一代修掉前一代的具體傷:
 *
 *   1. 每個 spec 寫死一個 port(3993…3999)。同一台機器上兩個 `pnpm verify`
 *      重疊時,兩邊的 spec 撞在同一個號碼上。
 *   2. e2e 先 `listen(0)` 跟 OS 要一個空號碼、關掉、再用環境變數交給 backend。
 *      窗口從「整段測試」縮到毫秒級,但**沒有歸零**:關掉到 backend 綁上去之間,
 *      那個 port 對任何人都是空的,包含另一個 run 的 `listen(0)`。
 *   3. (現在)`PORT=0`,backend 自己綁,再把**實際綁到的**號碼印在 stdout,
 *      這裡解析那一行。
 *
 * 第三代是零而不只是「更小」,原因不是它比較快:**選 port 的人與綁 port 的人
 * 變成同一個**,不存在「已選但未綁」的中間狀態可以讓別人插進來。這是 TOCTOU
 * 的一般解。「重試幾次」不是解 —— 它把一個可以消除的競態改成被容忍的競態,
 * 而且會讓「別人佔住 port」與「我們自己撞自己」再度合流,那正是 CR-004 拆開的
 * 東西。全部的推導在 change-requests/CR-013.md。
 *
 * 讀到那一行**同時證明了綁定成功**,所以它也是就緒訊號,比「spawn 完再輪詢」
 * 多一個保證:輪詢連得上不代表連到的是這次啟動的行程,而那個號碼是核心在綁定
 * 當下發的,不可能是別人的。
 *
 * ### 那一行是介面,不是訊息
 *
 *     backend listening on :58055
 *
 * 它由 `backend/src/index.ts` 印出,而 backend 改不到 `e2e/`、也不跑這些測試 ——
 * **它有能力靜默地弄壞這裡,而且不會有任何東西告訴它。** 所以兩邊各留一則坑註解
 * 互相指名(CR-013 裁決第四項)。真的對不上時,`waitForPort()` 的逾時訊息會把
 * 「我在找什麼」與「我實際收到什麼」一起印出來 —— 那是把一個會變安靜的失敗
 * 壓回吵鬧的設計,不是順手加的除錯訊息。
 *
 * 只有 `PORT=0` 走這條路。**未設 `PORT` 仍然是 3000**,`pnpm dev:backend` 與
 * `.env.example` 都依賴那個預設,不要把「未設」也改成隨機 port。
 *
 *
 * ## fail=0 但 cancelled>0:認它
 *
 * 記在這裡是因為**這是九個 spec 唯一共用的檔案**,而被取消的不一定是同一支
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
 * cancelledByParent 只是結果,同一份輸出裡往上找會有一則 hookFailed,那才是原因。
 *
 * ### 曾經的原因(已修),以及它留下的方法
 *
 * 上面這個形狀最初是 `before()` 撞 EADDRINUSE 造成的,也就是第二代那個窗口被真的
 * 撞到的樣子。**那個原因在第三代之後不存在了**,但形狀本身還在:任何 `before()`
 * 失敗都會長這樣。所以這一節留著,只是它不再指向 port。
 *
 * 當時量出來的分母值得留下,因為方法比數字有用:
 *
 *     infra       做別的事時順手撞到        約 1 / 8    (條件未受控)
 *     architect   閒置連跑 pnpm verify      0 / 10
 *     architect   4 個 pnpm verify 並行     1 / 12,接著 0 / 16
 *     qa          4 個 test:e2e 並行        1 / 64
 *
 * **不要把這幾列加起來。** 三個人量的不是同一條指令:`verify` 每次會多跑
 * check:boundaries 等七段、單次時間長好幾倍,`test:e2e` 只有測試 —— 每次 run 暴露
 * 在窗口下的時間不同,命中率本來就不可比。硬加出來的「2/92」是一個沒有意義的數字。
 * 能說的只有各列自己,以及一個量級:**並行時是百分之個位數,閒置時沒見過。**
 *
 * **「並行就能重現」不成立。** 那是第一次 1/12 之後的推論,再跑 16 次 0 命中就塌了。
 * 一次重現不是重現方法(agent-workflow 第 5 節)。
 *
 * ### 再看到間歇的時候不要做的事
 *
 * 不要加 sleep、不要放寬斷言、不要為 ECONNRESET 加重試。百分之個位數的間歇
 * **單次綠不代表修好了** —— 一個什麼都沒改的分支九成以上的機率也是綠的。能當證據的
 * 是同一條指令在修法前後各跑幾十次的命中率,不是一次綠燈。
 *
 * ### 量分母的人請先按形狀分類,不要只看 exit code
 *
 * e2e 紅有不只一種原因。量上面那個間歇的時候,qa 在 64 次裡另外撞到 2 次
 * `fail=1 cancelled=0` —— 那是 notification.spec.ts 自己的時間窗下界取錯邊,
 * 與本節無關,已修(見該檔 AC-008 第三條的註解)。**兩種混在一起數,分母就沒有意義。**
 *
 * 本檔不是 spec(`test:e2e` 的 glob 只收 *.spec.ts),同樣不 import backend/。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

/** 診斷用的 stdout/stderr 只需要尾端,不讓它無限成長。 */
const STDIO_LIMIT = 8192;

/** SIGTERM 之後等這麼久,再不走就 SIGKILL。 */
const TERM_GRACE_MS = 2000;

/**
 * 等 backend 報出 port 的上限。
 *
 * 有這個上限才敢用「讀 stdout 等一行」取代 EADDRINUSE:舊的失敗難看,但**會停、
 * 有訊息**;天真的等待在 backend 印出之前就死掉時會**永遠等下去**,那是拿一個吵鬧的
 * 失敗換一個安靜的掛住,而安靜的失敗這個 repo 已經判過三次死刑(CR-013 裁決第三項)。
 *
 * 值訂得寬鬆是故意的 —— 它防的是掛住,不是慢。行程先死的路徑不必等到這裡就會爆。
 */
const STARTUP_TIMEOUT_MS = 30_000;

/**
 * backend 的就緒訊號。**這是跨角色的介面**,不是給人看的訊息 ——
 * 改字要連 backend/src/index.ts 一起改,見檔頭「那一行是介面,不是訊息」。
 */
const LISTENING_RE = /backend listening on :(\d+)/;

interface ProcState {
  /** 行程提早結束或根本沒起來的原因;null 代表還活著。 */
  died: string | null;
  stdout: string;
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
 * port 上已經有人在聽,就代表這次的 spawn 綁不到 port。
 * 此時 `waitForServer()` 會連上那個「別人」,測試從此對著上一輪的資料做斷言。
 *
 * **平常路徑用不到它** —— `PORT=0` 拿到的號碼是核心在綁定當下發的,不可能是別人的。
 * 它留給 `fixedPort`,也就是「手動佔住一個 port,驗這道防線會不會爆」的那個用途。
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

/**
 * 逾時的訊息要能自己解釋 —— 最可能的原因是那一行的格式變了,而改格式的人
 * (backend)看不到這個檔案。把「我在找什麼」與「我實際收到什麼」並排印出來,
 * 讀到的人不必先去猜。
 */
function timedOut(state: ProcState): Error {
  const out = state.stdout.trim();
  const tail = state.stderr.trim();
  return new Error(
    `backend 在 ${STARTUP_TIMEOUT_MS} ms 內沒有印出 ${LISTENING_RE.source}。\n` +
      `那一行是 backend 與 e2e 之間的介面(見 backend/src/index.ts 旁的坑註解與 CR-013),\n` +
      `格式若改過,這裡要一起改。\n` +
      (out ? `--- backend stdout ---\n${out}\n` : '--- backend stdout 全空 ---\n') +
      (tail ? `--- backend stderr ---\n${tail}` : ''),
  );
}

/**
 * 等 backend 把實際綁到的 port 印出來。
 *
 * 只有三種結束方式,而且**每一種都會吵**:拿到號碼、行程先死、逾時。
 * 沒有第四種「繼續等」——見 STARTUP_TIMEOUT_MS 上面那段。
 */
function waitForPort(child: ChildProcess, state: ProcState): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const done = (err: Error | null, port = 0): void => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onDied);
      child.off('error', onDied);
      if (err) reject(err);
      else resolve(port);
    };

    // state.stdout 由 startServer() 掛的監聽器累積,那個監聽器註冊得比這個早,
    // 而 Node 依註冊順序呼叫 —— 所以這裡讀到的緩衝一定已經含本次的 chunk。
    // 換句話說,訊號被 chunk 切成兩半也沒關係,比對的是整個緩衝。
    const onData = (): void => {
      const found = LISTENING_RE.exec(state.stdout);
      if (found === null) return;

      const port = Number(found[1]);
      if (port === 0) {
        // 印出 :0 代表印的是「要求的」port 而不是實際綁到的,也就是 CR-013 的
        // backend 那一棒沒生效。在這裡爆掉,不要讓它變成 http://localhost:0
        // 的連線錯誤 —— 那個症狀看起來跟本題無關,會把人帶去錯的地方。
        done(
          new Error(
            'backend 印出 "backend listening on :0" —— 那是要求的 port,不是實際綁到的。\n' +
              '代表 backend/src/index.ts 沒有從 server.address() 取號碼,見 CR-013。',
          ),
        );
        return;
      }
      done(null, port);
    };

    const onDied = (): void => done(fatal(state));

    timer = setTimeout(() => done(timedOut(state)), STARTUP_TIMEOUT_MS);

    child.stdout?.on('data', onData);
    child.on('exit', onDied);
    child.on('error', onDied);

    onData(); // 訊號可能在掛上監聽之前就到了
  });
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
  throw new Error(`backend 未在時限內於 ${base} 回應`);
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    closeStdio(child);
    return; // 已經結束
  }

  const exited = once(child, 'exit'); // 先掛監聽,才不會錯過 kill 後的事件
  child.kill('SIGTERM');

  const inTime = await Promise.race([
    exited.then(() => true),
    sleep(TERM_GRACE_MS, true).then(() => false),
  ]);
  if (inTime) {
    closeStdio(child);
    return;
  }

  // 卡住的行程會佔著 port 害下一輪,不留餘地。
  child.kill('SIGKILL');
  await exited;
  closeStdio(child);
}

/**
 * pipe 的讀取端留著就是一個 open handle,行程會因此不肯結束。
 *
 * **只在收尾時關,不要在拿到 port 之後就關 stdout** —— 讀取端一關,backend 之後
 * 每次寫 stdout 都會拿到 EPIPE,那是我們自己去弄死受測行程。啟動之後那個 data
 * 監聽器繼續掛著(內容丟掉、長度有上限),它的工作是把管子抽乾,免得 backend
 * 寫滿 pipe buffer 之後阻塞。
 */
function closeStdio(child: ChildProcess): void {
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/**
 * 起一個 backend 行程。
 *
 * @param fixedPort 指定 port。**平常不要用** —— 它會退回「先知道號碼再啟動」的
 *   舊模型,也就是本檔頭第二代那個窗口。留著是為了驗證殘留偵測(手動佔住一個
 *   port,再叫測試起在同一個上面,assertPortFree 應該爆)。
 */
export async function startServer(fixedPort?: number): Promise<TestServer> {
  // 平常路徑不預先挑 port:PORT=0 讓 backend 自己綁,選與綁因此是同一個動作。
  if (fixedPort !== undefined) {
    await assertPortFree(`http://localhost:${fixedPort}`, fixedPort);
  }

  // 直接跑 node,不透過 npx。npx 會多包一層外殼行程,`kill` 打到的是外殼,
  // 真正的 server 是它的孫行程 —— 活下來繼續佔著 port(正是 CR-004 的根因),
  // 而且抓著下面那條 stderr pipe 不放,害 `node --test` 的子行程永遠等不到
  // stream 結束而卡住。`--import tsx` 與 package.json 的 test:e2e 同一套。
  const child = spawn(process.execPath, ['--import', 'tsx', 'backend/src/index.ts'], {
    env: { ...process.env, PORT: String(fixedPort ?? 0) },
    // stdout 要留:實際綁到的 port 只從那裡回報,而它同時是就緒訊號。
    // stderr 也一定要留:EADDRINUSE 這種真正需要看到的錯誤只會出現在那裡。
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // 這兩個 data 監聽器必須比 waitForPort() 早掛上,理由見它裡面 onData 的註解。
  const state: ProcState = { died: null, stdout: '', stderr: '' };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    state.stdout = (state.stdout + chunk).slice(-STDIO_LIMIT);
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    state.stderr = (state.stderr + chunk).slice(-STDIO_LIMIT);
  });
  child.on('error', (err: Error) => {
    state.died = `backend 行程啟動失敗:${err.message}`;
  });
  child.on('exit', (code, signal) => {
    state.died = `backend 行程在就緒前就結束了(code=${code}, signal=${signal})`;
  });

  let port: number;
  let base: string;
  try {
    port = await waitForPort(child, state);
    base = `http://localhost:${port}`;
    // 那一行已經證明綁定成功,這一步只再確認 HTTP 層真的會回應。
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
