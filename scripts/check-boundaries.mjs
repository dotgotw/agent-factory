#!/usr/bin/env node
/**
 * scripts/check-boundaries.mjs
 *
 * 對刻意違規的 fixture 跑 tsc,期望它紅。
 *
 * ADR-003 前提條件二:上面那三條 TS 錯誤若只在遷移當天跑過一次,這個邊界的
 * 壽命就是一次。殘留的洞在 root —— root package.json 裡的任何依賴對每個
 * package 都解析得到,而沒有任何機制阻止有人把 express 加回 root。那會讓
 * frontend 那半邊的邊界**靜默**復原成遷移前的樣子。這支檢查是唯一會出聲的東西。
 *
 * ## 兩個斷言上的講究
 *
 * 一、**斷言「以某個錯誤碼失敗」,而且把它綁在 fixture 那一行上。**
 * 不斷言「只有 fixture 報錯」—— 違規的 import 會把別的檔案一起拉進 program,
 * 連帶產生別的錯誤(architect 複驗 C 組時就撞到),那樣的斷言會 flaky。
 * 但也不能只看「有沒有這個錯誤碼」:那樣 fixture 沒被編譯到也會過。
 * 綁在檔名上兩件事一起解決。
 *
 * 二、**tsc 意外通過時,要先分清楚是設定壞了還是環境洩漏。**
 * 巢狀 worktree(.claude/worktrees/<role>)的上層就是主 checkout,而模組解析
 * 會沿目錄樹往上走 —— 於是 `import express` 可能解析到 repo 之外的
 * node_modules,fixture 因此不紅。那不是這個 repo 的設定有問題,是這個
 * 環境回答不了「應該解析不到」這種問題。
 *
 * 所以意外通過時再跑一次 --traceResolution 看它到底解析到哪裡:
 *   解析到 repo 之內 → 邊界真的破了,紅。
 *   解析到 repo 之外 → 環境洩漏,大聲說出來但不判紅(CI 沒有上層 node_modules,
 *                      那裡才是這件事的權威)。
 *
 * 這個分法比「複製到 repo 之外再跑」便宜,而且更準:設定真的壞掉時
 * (例如有人把 express 加進 frontend/package.json),它會解析到 repo 之內,
 * 照樣紅。
 *
 * ⚠️  撞到「環境洩漏」時不要放寬 fixture。放寬 fixture 等於把鎖拆掉。
 *
 * ## 三、殘留的 fixture,以及它為什麼曾經是最難查的紅燈
 *
 * fixture 的壽命應該只有這支程式的一次執行。但 `finally` 擋不住 SIGKILL,
 * 於是被硬殺的一次會在 e2e/ 留下一個檔案,而那個檔案:
 *
 *   - 被 .gitignore 蓋住(`*.boundary-fixture.ts`)→ `git status` 是乾淨的
 *   - 落在 e2e/tsconfig.json 的 include(整個目錄的 .ts)裡 → `pnpm typecheck` 會編它
 *
 * 症狀因此是「verify 紅在一個我沒寫過、也看不見的檔案上」。下面第 105 行那段
 * 診斷本來就是為這件事寫的,但它**在 verify 裡跑不到** —— 因為 verify 的順序
 * 曾經是 `... && typecheck && check:boundaries && ...`,typecheck 先撞上殘留物
 * 就退出了。architect 撞到的那一個在他的 worktree 裡躺了 12 小時才被發現。
 *
 * 修法是三層,缺一層都還會漏:
 *
 *   1. package.json 的 `verify` 把 `check:boundaries` 排到 `typecheck` **之前**,
 *      這段診斷才有機會說話。這條順序是有負載的,`check-boundaries.test.mjs`
 *      會盯著它,不要把它換回去。
 *   2. 認得出自己的殘留物就直接清掉(見 `triageFixture`),不要叫人手動處理一個
 *      他看不見的檔案。
 *   3. 接住 SIGINT/SIGTERM,讓 Ctrl-C 這種最常見的「硬殺」根本不留殘留物。
 *      SIGKILL 仍然接不住 —— 所以第 2 層還是必要的。
 *
 * ⚠️  有一個看起來更漂亮的修法:把 `*.boundary-fixture.ts` 從各 tsconfig 的
 * include 排除掉,殘留物就再也不會弄紅 typecheck。**不要這樣做。** 這支檢查
 * 成立的前提正是 tsc 真的把 fixture 編進 program(見上面「綁在檔名上」那段);
 * 排除掉之後 fixture 不會產生任何錯誤,anchored 永遠是 false,三個案例會一起
 * 變紅 —— 而把它們「修綠」的下一步就是放寬斷言,鎖就沒了。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSC = join(rootDir, 'node_modules', '.bin', 'tsc');

/**
 * 三個負向案例,對應 ADR-003 決策表的兩種漏洞。
 *
 * ## 選 specifier 的時候要知道的事(否則會靜默把鎖拆掉)
 *
 * AGENTS.md #6 說模組解析會沿目錄樹往上走,在巢狀 worktree 裡逃到外層 checkout。
 * **那是真的,而且當場示範得出來** —— 在 `.claude/worktrees/<role>` 底下:
 *
 *   require.resolve('accepts', …from e2e)
 *     → /Users/…/agent-factory/node_modules/accepts/index.js   ← 外層,不是 worktree
 *
 * 但下面兩個幽靈依賴的 specifier 逃不出去,原因是 pnpm 的 hoist 規則:
 *
 *   | specifier      | 誰宣告                  | 住哪                        | 上層找得到 |
 *   |----------------|-------------------------|-----------------------------|-----------|
 *   | express        | backend **直接宣告**    | backend/node_modules/       | ✗         |
 *   | @af/backend    | workspace 套件          | 從不 hoist                  | ✗         |
 *   | accepts        | 沒有人宣告(傳遞相依)  | 外層 root node_modules(100 項) | **✓** |
 *
 * **直接宣告的留在自己的 node_modules,只有傳遞相依才平鋪到 root。**
 *
 * 所以本機拿到硬 ✅ 不是因為我們設計得好,是**附帶的**。它會在兩種情況退化:
 *
 *   1. 有人把某個 specifier 換成一個**傳遞相依**(像 `accepts`)—— 它會解析到
 *      外層,案例降級成 ⚠️,而 ⚠️ 是「這裡問不出答案」,不是「答案是好的」。
 *   2. 改用 hoisting 佈局(`node-linker=hoisted`)。這一項是從 hoist 規則推的,
 *      **沒有實測**。
 *
 * 第 1 種有機制擋著:check-boundaries.test.mjs 斷言每個 specifier 都是某個
 * workspace 套件**直接宣告**的(或就是 workspace 套件本身)。換成傳遞相依會紅。
 * 第 2 種沒有機制,只有這段話。
 *
 * ## 上面那些是用什麼量的(範圍要講清楚)
 *
 * 兩半的證據強度不一樣,別把它們當成同一件事:
 *
 * - **「tsc 解析不到 express / @af/backend」有機器每次複驗** —— 就是這支檢查
 *   自己:`✅ … TS2307` 代表 tsc 真的在 fixture 那一行上報了 module not found。
 *   鎖靠的是這一半,而它每次 `pnpm verify` 都被問一次。
 * - **「accepts 逃到外層 checkout」只用 Node 的 `require.resolve` 示範過**,
 *   沒有 tsc 版本。要有的話得在 `frontend/src` 或 `e2e/` 放一個 import 傳遞相依的
 *   檔案,而那兩個目錄不是 infra 的 scope。兩者都沿 node_modules 往上走,
 *   但這裡沒有實測 tsc 也會逃出去 —— 不要把它寫成已驗證的。
 *
 * 這不是頻率主張:`require.resolve` 是決定性的檔案系統查找,一次示範就足以
 * 證明走訪會發生(跟間歇性紅燈那種要分母的情況不同)。
 */
export const CASES = [
  {
    name: 'frontend 不該解析得到 express(幽靈依賴)',
    project: 'frontend/tsconfig.json',
    fixture: 'frontend/src/ghost.boundary-fixture.ts',
    source: "import express from 'express';\nexport const probe = express;\n",
    code: 'TS2307',
    specifier: 'express',
  },
  {
    name: 'e2e 不該用相對路徑 import 實作(路徑逃逸)',
    project: 'e2e/tsconfig.json',
    fixture: 'e2e/escape.boundary-fixture.ts',
    source: "import { app } from '../backend/src/index.js';\nexport const probe = app;\n",
    code: 'TS6059',
    // 路徑逃逸與 node_modules 無關,不會被環境洩漏影響。
    specifier: null,
  },
  {
    name: 'e2e 不該解析得到 @af/backend(幽靈依賴)',
    project: 'e2e/tsconfig.json',
    fixture: 'e2e/ghost.boundary-fixture.ts',
    source: "import { app } from '@af/backend';\nexport const probe = app;\n",
    code: 'TS2307',
    specifier: '@af/backend',
  },
];

/**
 * 同一個目錄裡另一個 check:boundaries 正在跑的話,它的 fixture 會有多新?
 *
 * 整支跑完是「幾秒到幾十秒」的量級(三個案例,意外通過時多一次
 * --traceResolution)。十分鐘遠遠涵蓋得住,而 architect 撞到的殘留物是 12 小時。
 *
 * 抓錯邊的代價不對稱,所以往保守的那邊放寬:
 *   - 把「還活著的」誤判成殘留 → 對方的 tsc 少看到一個檔案 → 對方**紅**。吵,但看得見。
 *   - 把「殘留的」誤判成還活著 → 退回原本的行為(拒絕並印診斷),不會更糟。
 */
const CONCURRENT_WINDOW_MS = 10 * 60 * 1000;

/**
 * fixture 已經存在時:這個檔案是誰的、能不能動。
 *
 * 純函式,不碰 fs —— 呼叫的人把讀到的東西餵進來。這樣測得到「十分鐘的邊界」
 * 與「內容不一樣就不敢動」,不必真的去擺一個殘留物,也不必等十分鐘。
 */
export function triageFixture({ content, mtimeMs, now, source, windowMs = CONCURRENT_WINDOW_MS }) {
  // 內容對不上就不是我們寫的。別人的檔案一律不動,即使它很舊。
  if (content !== source) return { action: 'refuse', why: 'foreign' };

  const ageMs = now - mtimeMs;
  // 夠新 → 可能有另一個 run 正在用它,不能抽掉。
  if (ageMs < windowMs) return { action: 'refuse', why: 'concurrent', ageMs };

  return { action: 'clean', why: 'stale', ageMs };
}

/**
 * fixture 存在的話,依 triageFixture 的判斷把殘留物清掉。
 *
 * 這一層碰 fs,但仍然接受任意路徑 —— 測試因此可以拿 tmpdir 裡的檔案驗
 * 「真的被刪掉了」,而不是只驗那個純函式回傳什麼。CR-014 的另一半教訓:
 * 函式綠、呼叫它的那條線被砍掉,測試不會出聲。
 */
export function clearStaleFixture(fixturePath, source, now = Date.now(), windowMs = CONCURRENT_WINDOW_MS) {
  if (!existsSync(fixturePath)) return { action: 'proceed' };

  const verdict = triageFixture({
    content: readFileSync(fixturePath, 'utf8'),
    mtimeMs: statSync(fixturePath).mtimeMs,
    now,
    source,
    windowMs,
  });

  if (verdict.action === 'clean') rmSync(fixturePath, { force: true });
  return verdict;
}

/** 把毫秒講成人看得懂的年紀。 */
export function humanAge(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} 分鐘`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours} 小時` : `${Math.floor(hours / 24)} 天`;
}

/** 跑 tsc,回傳輸出(不論成敗)。 */
function tsc(args) {
  try {
    return { ok: true, out: execFileSync(TSC, args, { cwd: rootDir, encoding: 'utf8' }) };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** 這個 specifier 解析到哪裡;回答不了就回傳 null。 */
function resolvedPath(project, specifier) {
  const { out } = tsc(['-p', project, '--traceResolution']);
  const marker = `Resolving module '${specifier}'`;
  const from = out.indexOf(marker);
  if (from === -1) return null;
  const hit = out.slice(from).match(/successfully resolved to '([^']+)'/);
  return hit ? hit[1] : null;
}

function main() {
  const failures = [];
  const leaks = [];

  // 已經建立、還沒清掉的 fixture。SIGINT/SIGTERM 靠它清乾淨 —— finally 接不到訊號。
  let live = null;
  for (const [sig, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    process.on(sig, () => {
      if (live) rmSync(live, { force: true });
      process.exit(code);
    });
  }

  for (const c of CASES) {
    const fixturePath = join(rootDir, c.fixture);
    const existing = clearStaleFixture(fixturePath, c.source);
    if (existing.action !== 'proceed') {
      const verdict = existing;
      if (verdict.action === 'refuse') {
        console.error(
          `❌ ${c.fixture} 已經存在 —— 不覆蓋別人的檔案。\n` +
            (verdict.why === 'concurrent'
              ? `   內容是這支檢查寫的,而且很新(${humanAge(verdict.ageMs)}前)——\n` +
                `   同一個目錄裡多半有另一個 check:boundaries 正在跑(fixture 是共用的檔案,\n` +
                `   不同角色各自的 worktree 不會互撞,同一個目錄跑兩次會)。\n` +
                `   等它跑完再試;確定沒有別人在跑就直接刪掉重跑。`
              : `   內容不是這支檢查寫的,所以不敢動它。\n` +
                `   確認那不是你要留的東西之後,自己刪掉再重跑。`),
        );
        process.exit(2);
      }

      // 到這裡只剩一種可能:我們自己上次被硬殺留下的。清掉,而且要說出來 ——
      // 這個檔案被 .gitignore 蓋住,不講的話它是完全隱形的。
      console.log(
        `⚠️  清掉殘留的 ${c.fixture}(${humanAge(verdict.ageMs)}沒動過)。\n` +
          `   那是上一次 check:boundaries 被硬殺留下的:finally 擋不住 SIGKILL。\n` +
          `   它被 .gitignore 蓋住,所以 git status 看不到,但 typecheck 編得到它。`,
      );
    }

    let verdict;
    try {
      writeFileSync(fixturePath, c.source, 'utf8');
      live = fixturePath;
      const { out } = tsc(['-p', c.project]);

      // 錯誤碼必須出現在 fixture 那一行上:同時證明「錯了」與「fixture 真的被編譯」。
      const anchored = out
        .split('\n')
        .some((line) => line.includes(c.fixture) && line.includes(c.code));

      if (anchored) {
        verdict = { kind: 'pass' };
      } else if (c.specifier) {
        const where = resolvedPath(c.project, c.specifier);
        const inside = where && where.startsWith(rootDir + '/');
        verdict = where && !inside ? { kind: 'leak', where } : { kind: 'fail', out, where };
      } else {
        verdict = { kind: 'fail', out };
      }
    } finally {
      rmSync(fixturePath, { force: true });
      live = null;
    }

    if (verdict.kind === 'pass') {
      console.log(`✅ ${c.name} —— ${c.code}`);
    } else if (verdict.kind === 'leak') {
      leaks.push({ ...c, where: verdict.where });
      console.log(`⚠️  ${c.name} —— 這個環境驗不了(見下)`);
    } else {
      failures.push({ ...c, out: verdict.out, where: verdict.where });
      console.log(`❌ ${c.name} —— 期望 ${c.code},沒有出現`);
    }
  }

  if (leaks.length > 0) {
    console.log(`\n⚠️  ${leaks.length} 個案例在這個環境驗不了:`);
    for (const l of leaks) {
      console.log(`   - ${l.specifier} 解析到 repo 之外:`);
      console.log(`     ${l.where}`);
    }
    console.log('');
    console.log('   模組解析會沿目錄樹往上走。若這個工作區在另一個 checkout 底下');
    console.log('   (例如 .claude/worktrees/<role>),上層的 node_modules 會被撈到,');
    console.log('   於是「應該解析不到」這種問題在這裡問不出答案。');
    console.log('');
    console.log('   CI 是乾淨 checkout,沒有上層,那裡才是這件事的權威。');
    console.log('   **不要因此放寬 fixture** —— 那是把鎖拆掉,不是修檢查。');
  }

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} 個邊界沒有守住:`);
    for (const f of failures) {
      console.error(`   - ${f.name}`);
      console.error(`     期望 ${f.fixture} 出現 ${f.code}`);
      if (f.where) console.error(`     實際解析到 repo 之內: ${f.where}`);
      const head = (f.out ?? '').split('\n').filter(Boolean).slice(0, 3);
      for (const line of head) console.error(`     | ${line}`);
    }
    console.error('\n   邊界的來源是各 tsconfig 的 rootDir 與各 package.json 的依賴宣告。');
    console.error('   見 contract/decisions/ADR-003-role-boundaries-enforced-by-module-resolution.md');
    process.exit(1);
  }

  console.log(`\n✅ ${CASES.length - leaks.length}/${CASES.length} 個邊界已驗證`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
