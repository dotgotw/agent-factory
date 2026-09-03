#!/usr/bin/env node
/**
 * scripts/role.mjs
 *
 * 角色的單一來源。CLI 用法:
 *   node scripts/role.mjs          # 印出目前 session 的角色與可寫路徑
 *
 * 也作為 lib 給 check-scope.mjs 與 .claude/hooks/scope-guard.mjs 使用,
 * 避免「可寫路徑」這件事在三個地方各寫一份而漂移。
 *
 * 角色來源(依序):
 *   1. AGENT_ROLE 環境變數
 *   2. .claude/role 檔案(不進版控)
 *
 * 注意:這兩者 agent 自己都改得到,所以這是「早期回饋」而不是「邊界」。
 * 真正的邊界在 CI(PR label + check-scope.mjs)與 CODEOWNERS。
 *
 * ---
 *
 * 比對語意(ADR-003 前提條件一)。這個檔案回答的問題從
 * 「我的清單裡有沒有任何一條命中?」改成「這個檔案是誰的?」:
 *
 *   1. 帶結尾斜線的條目是目錄前綴,不帶的是精確檔名。
 *      (舊的 startsWith 讓 "AGENTS.md" 這條也命中 "AGENTS.md.bak"。)
 *   2. roles 之內**最長前綴勝出**,一個檔案只有一個擁有者。
 *      infra 明列的 "e2e/tsconfig.json"(17)勝過 qa 的 "e2e/"(4),
 *      qa 因此**失去**那個檔案 —— 這是 scope.json 第一次有減法。
 *   3. _everyone 與 _derived 是**加法**,不參與長度比較。
 *
 * 第 3 點是實測出來的陷阱,不是潔癖:allowedPathsFor() 會把 _everyone 併進
 * 每個角色的清單,若讓它參賽,"change-requests/" 在五個角色上等長,勝負
 * 取決於 Object.keys 的順序 —— 四個角色會從此開不了 CR,而開 CR 正是被
 * scope 擋下時唯一的合法出口。把逃生門關掉,剩下的選項只有繞過。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { pitsFor, scanPits } from './pits.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const rootDir = join(here, '..');

/** 兩條規則是否指到重疊的檔案集合。 */
function overlaps(a, b) {
  if (a === b) return true;
  if (b.endsWith('/') && a.startsWith(b)) return true;
  if (a.endsWith('/') && b.startsWith(a)) return true;
  return false;
}

/**
 * 擁有權必須唯一,否則「最長前綴勝出」的勝負會取決於物件鍵的順序 ——
 * 那是會靜默漂移的東西,所以在載入時就判錯,不留到執行期。
 */
export function validateScope(config) {
  const errors = [];
  const owner = new Map();

  for (const [role, info] of Object.entries(config.roles ?? {})) {
    for (const rule of info.allow ?? []) {
      if (owner.has(rule)) {
        errors.push(
          `路徑 "${rule}" 同時列在 ${owner.get(rule)} 與 ${role} 的 allow ——` +
            ` 擁有者不唯一,勝負會取決於鍵順序。`,
        );
      } else {
        owner.set(rule, role);
      }
    }
  }

  const additive = [
    ...(config._everyone ?? []).map((p) => ['_everyone', p]),
    ...Object.keys(config._derived ?? {}).map((p) => ['_derived', p]),
  ];
  for (const [where, prefix] of additive) {
    for (const [rule, role] of owner) {
      if (overlaps(rule, prefix)) {
        errors.push(
          `${role} 的 "${rule}" 與 ${where} 的 "${prefix}" 重疊 ——` +
            ` 加法的路徑不參與擁有權比較,重疊會讓兩套規則同時適用。`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `scripts/scope.json 的規則有衝突:\n` +
        errors.map((e) => `  - ${e}`).join('\n'),
    );
  }
  return config;
}

export function loadScope() {
  return validateScope(JSON.parse(readFileSync(join(here, 'scope.json'), 'utf8')));
}

/** 一條 scope 條目是否命中某個 repo 相對路徑。 */
export function ruleMatches(rel, rule) {
  return rule.endsWith('/') ? rel.startsWith(rule) : rel === rule;
}

/**
 * 這個檔案歸誰(roles 之內最長前綴勝出)。無人擁有回傳 null。
 * 不看 _everyone 與 _derived —— 那兩者是加法,由 classifyPath 先行處理。
 */
export function ownerOf(rel, config = loadScope()) {
  let best = null;
  for (const [role, info] of Object.entries(config.roles)) {
    for (const rule of info.allow) {
      if (!ruleMatches(rel, rule)) continue;
      if (!best || rule.length > best.rule.length) best = { role, rule };
    }
  }
  return best;
}

/** 這個檔案是否落在某個衍生路徑底下。 */
export function derivedFor(rel, config = loadScope()) {
  const hit = Object.keys(config._derived ?? {}).find((p) => ruleMatches(rel, p));
  return hit ? { prefix: hit, info: config._derived[hit] } : null;
}

/**
 * 把一個路徑對某個角色分類。這是 hook 與 CI 共用的唯一判斷。
 *
 * kind:
 *   outside  —— repo 之外,不歸 scope 管
 *   everyone —— _everyone 的加法路徑(CR),所有角色皆可寫
 *   derived  —— 衍生產物;能不能寫由呼叫端決定(手改一律不行,夾帶要看 writers)
 *   owned    —— 這個角色擁有
 *   foreign  —— 別的角色擁有(owner 欄位說是誰)
 *   unowned  —— 沒有任何角色擁有
 *
 * 順序是有意義的:derived 必須先於 ownerOf,否則 generated/ 會被判成 unowned。
 */
export function classifyPath(filePath, role, config = loadScope()) {
  const rel = toRepoRelative(filePath);
  if (rel === null) return { rel: null, kind: 'outside' };

  if ((config._everyone ?? []).some((r) => ruleMatches(rel, r))) {
    return { rel, kind: 'everyone' };
  }

  const derived = derivedFor(rel, config);
  if (derived) return { rel, kind: 'derived', derived };

  const owner = ownerOf(rel, config);
  if (!owner) return { rel, kind: 'unowned' };
  if (owner.role === role) return { rel, kind: 'owned', owner: owner.role, rule: owner.rule };
  return { rel, kind: 'foreign', owner: owner.role, rule: owner.rule };
}

/** 該角色可寫的路徑前綴,含所有角色共用的部分。未知角色回傳 null。 */
export function allowedPathsFor(role, config = loadScope()) {
  if (!role || !config.roles[role]) return null;
  return [...config.roles[role].allow, ...config._everyone];
}

/**
 * 我的目錄前綴底下、但歸別人的檔案。
 *
 * 有了最長前綴勝出,「可寫路徑」不再等於「這個前綴底下的全部」——
 * qa 看到 `e2e/` 卻寫不了 `e2e/tsconfig.json`。這個函式讓 CLI 講實話,
 * 免得文件許一個機制不兌現的承諾。
 */
export function exceptionsFor(role, config = loadScope()) {
  const dirs = (config.roles[role]?.allow ?? []).filter((r) => r.endsWith('/'));
  const out = [];
  for (const [other, info] of Object.entries(config.roles)) {
    if (other === role) continue;
    for (const rule of info.allow) {
      if (dirs.some((d) => rule !== d && rule.startsWith(d))) out.push({ rule, owner: other });
    }
  }
  return out.sort((a, b) => a.rule.localeCompare(b.rule));
}

/**
 * 該角色的變更集可以「帶著一起送」的衍生路徑。
 *
 * 衍生產物不屬於任何角色 —— 它是生成器的輸出,不是誰的財產(ADR-002)。
 * writers 因此不是「誰擁有它」,而是「誰的 PR 可以夾帶重新生成的結果」,
 * 名單由 inputs 的擁有者推導:改得到輸入的人,就改得到輸出。
 *
 * 內容的權威不在這裡,在每個項目的 guard(目前是 check:drift)。
 * 這個函式只回答「這個檔案出現在這個角色的 diff 裡合不合理」。
 */
export function derivedPathsFor(role, config = loadScope()) {
  if (!role) return [];
  return Object.entries(config._derived ?? {})
    .filter(([, info]) => info.writers.includes(role))
    .map(([path]) => path);
}

/** 該角色的變更集允許出現的所有路徑 = 自己的 + 可夾帶的衍生。未知角色回傳 null。 */
export function writablePathsFor(role, config = loadScope()) {
  const owned = allowedPathsFor(role, config);
  if (!owned) return null;
  return [...owned, ...derivedPathsFor(role, config)];
}

/**
 * main 相對於本 worktree 前進了什麼(CR-016 的保證層)。
 *
 * 快路徑(merge 之後 postMessage 給還活著的 session)答的是「你那張 PR merge 了嗎」,
 * 而它的地址是 session_id —— session 一關就沒了。這一層答的是**另一題**:
 * 「main 在我不在的時候動了,而且動到我依賴的東西嗎?」地址是 worktree,不會消失。
 *
 * 從 git 推導,不建佇列。理由是這個 repo 已經用過兩次的同一招:ADR-002 讓衍生物由
 * 重新生成把關,ADR-007 讓 status 用算的而不是用存的。算出來的東西不可能跟 git 漂移,
 * 而且不必回答「這個目錄歸誰」—— 一個 notifications/ 佇列會立刻撞上 ADR-009:158。
 *
 * **刻意不 fetch。** 三個選項裡這個唯一不會說謊:
 *   - 用舊的 ref:零延遲,但會**謊報「沒有東西」**
 *   - 開場 fetch:準,但每個 session 開場都付一次網路延遲,離線還會失敗
 *   - 不 fetch:漏報,但不誤報
 * 漏報會被下一次 fetch 補上;誤報會訓練人忽略這一行,而被忽略的那行就等於不存在。
 *
 * 而漏報比想像中少:**同一個 repo 的所有 worktree 共用 refs**(HEAD 以外),
 * 所以別的角色在他的 worktree 跑 fetch,你的 origin/main 也跟著更新。實測:
 * 寫這段的時候本 worktree 沒有 fetch 過,卻正確報出 backend 剛合併的 #117。
 * 這不是保證(全部 session 都不 fetch 就還是舊的),但它讓「不 fetch」這個
 * 選擇的代價比帳面上小。
 * 代價是「以本地已知的 origin/main 為準」必須寫進輸出本身 —— 見 summarizeIncoming,
 * 一個沒有標明範圍的數字在 ref 過期時就是一句謊話。
 */
export function readIncoming(cwd = rootDir) {
  const git = (args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    // 沒有 origin/main 就沒有這一題:還沒設 remote、乾淨 clone、CI 的 detached HEAD。
    // 這不是錯誤,是「這裡問不出答案」,所以回 null 而不是拋。
    git(['rev-parse', '--verify', '--quiet', 'origin/main']);
    return {
      count: Number(git(['rev-list', '--count', 'HEAD..origin/main']).trim()),
      files: git(['diff', '--name-only', 'HEAD...origin/main']).split('\n').filter(Boolean),
    };
  } catch {
    return null;
  }
}

/** 那些檔案裡,哪些是這個角色自己的。 */
export function incomingForRole(incoming, role, config = loadScope()) {
  if (!incoming) return [];
  return incoming.files.filter((f) => classifyPath(f, role, config).kind === 'owned');
}

/**
 * 開場那一行。沒有東西進來(或這裡問不出答案)就回 null —— 不製造常駐噪音。
 *
 * **永遠只有一行,不論 main 領先幾個 commit。** 跟坑註解同一條規則、同一個理由
 * (ADR-009:105-113):這段輸出每個 session 都要付,而且是注意力最稀缺的那一刻。
 * 細節用 `pnpm role --incoming` 查。
 */
export function summarizeIncoming(incoming, role, config = loadScope()) {
  if (!incoming || incoming.count === 0) return null;
  const mine = incomingForRole(incoming, role, config);
  return (
    `main 領先 ${incoming.count} 個 commit,其中 ${mine.length} 個檔案在你的 scope 內` +
    `(未 fetch,以本地已知的 origin/main 為準;pnpm role --incoming 看細節)`
  );
}

/** 目前 session 的角色;未指派回傳 null。 */
export function resolveRole() {
  const fromEnv = process.env.AGENT_ROLE?.trim();
  if (fromEnv) return fromEnv;

  const roleFile = join(rootDir, '.claude', 'role');
  if (existsSync(roleFile)) {
    const fromFile = readFileSync(roleFile, 'utf8').trim();
    if (fromFile) return fromFile;
  }
  return null;
}

/**
 * 轉成相對 repo 根目錄的路徑;repo 之外回傳 null。
 * 接受絕對或相對路徑。
 */
export function toRepoRelative(filePath) {
  const abs = resolve(rootDir, filePath);
  return abs.startsWith(rootDir + '/') ? abs.slice(rootDir.length + 1) : null;
}

/** 這個角色能不能寫這個檔案。手改衍生產物一律不行(ADR-002)。 */
export function canWrite(role, filePath, config = loadScope()) {
  const { kind } = classifyPath(filePath, role, config);
  return kind === 'outside' || kind === 'everyone' || kind === 'owned';
}

// --- CLI ---
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const config = loadScope();
  const role = resolveRole();

  if (!role) {
    console.log('角色: (未指派)');
    console.log(`可用角色: ${Object.keys(config.roles).join(', ')}`);
    console.log('');
    console.log('指派方式(由開 session 的人決定,不是由 agent 自己挑):');
    console.log('  雲端: 每個角色一個環境,環境變數設 AGENT_ROLE');
    console.log('  本機: AGENT_ROLE=backend claude');
    console.log('  臨時: echo backend > .claude/role  # 方便,但 agent 改得到');
    process.exit(3);
  }

  // --pits 是查詢,不是開場橫幅:只印坑註解,不印角色那一段。
  if (process.argv.includes('--pits')) {
    const mine = pitsFor(role, scanPits());
    if (mine.length === 0) {
      console.log(`沒有標給 ${role} 的坑註解。`);
    } else {
      console.log(`標給 ${role} 的坑註解(${mine.length}):`);
      for (const p of mine) console.log(`  ${p.file}:${p.line}  ${p.note}`);
    }
    process.exit(0);
  }

  // --incoming 同樣是查詢,不是開場橫幅:細節在這裡,開場只留一行計數。
  if (process.argv.includes('--incoming')) {
    const incoming = readIncoming();
    if (!incoming) {
      console.log('這裡問不出答案:找不到 origin/main(還沒設 remote,或這裡不是 git 工作區)。');
      process.exit(0);
    }
    const scope = '未 fetch,以本地已知的 origin/main 為準';
    if (incoming.count === 0) {
      console.log(`main 沒有領先本 worktree(${scope})。`);
      process.exit(0);
    }
    console.log(`main 領先 ${incoming.count} 個 commit,碰到 ${incoming.files.length} 個檔案(${scope}):`);
    for (const f of incoming.files) {
      const c = classifyPath(f, role, config);
      const tag =
        c.kind === 'owned' ? '你的' :
        c.kind === 'everyone' ? '共用' :
        c.kind === 'derived' ? '衍生' :
        c.kind === 'foreign' ? c.owner : c.kind;
      console.log(`  [${tag}] ${f}`);
    }
    process.exit(0);
  }

  const allowed = allowedPathsFor(role, config);
  if (!allowed) {
    console.error(`❌ 未知角色: ${role}`);
    console.error(`   可用角色: ${Object.keys(config.roles).join(', ')}`);
    process.exit(2);
  }

  console.log(`角色: ${role}`);
  console.log(`可寫路徑: ${allowed.join('、')}`);
  console.log(`說明: ${config.roles[role].note}`);
  // CR-015 的主規則。這裡是唯一會在 session **開場**被看到的地方,而這條規則
  // 也只有在開場才管用 —— 它不必偵測 context 長多大,只要把預設值講一次。
  console.log('這條 session 要做哪個任務?做完就關 —— 換任務換 session(見 AGENTS.md)。');

  const exceptions = exceptionsFor(role, config);
  if (exceptions.length > 0) {
    console.log('');
    console.log('其中這些是例外,歸別人(最長前綴勝出):');
    for (const e of exceptions) console.log(`  ${e.rule} → ${e.owner}`);
  }

  const derived = derivedPathsFor(role, config);
  if (derived.length > 0) {
    console.log('');
    console.log(`可夾帶的衍生路徑: ${derived.join('、')}`);
    console.log('  這些不是你的檔案,是生成器的輸出。你可以在自己的 PR 裡帶著');
    console.log('  重新生成的結果一起送,但內容對不對由 check:drift 說了算。');
  }

  // main 動了沒:同樣**一行計數**(CR-016)。放在坑註解之前 —— 坑註解要留在最後。
  //
  // ⚠️  明說的欠帳:**這一行呼叫在 main 不領先本 worktree 時沒有測試覆蓋。**
  // role.test.mjs 那條雙向測試會走「lib 說沒有 → 斷言輸出也沒有」那一支,
  // 於是它擋得住「CLI 自己另外算一份」,擋不住「這行被刪掉」。要重構這幾行的人:
  // 自己去 role.test.mjs 確認一次,不要只看綠燈。
  //
  // 為什麼不加一個可注入的 cwd 把它蓋起來:那會是 production 程式碼裡的第四個
  // 測試用途開關(TASKS_FILE、CR_DIR、AC_BASE_REF 之後),而那個類別有一個已知的
  // 退化方向 —— 有人拿它在正式流程裡指到別的地方,繞過真正的來源 —— 目前沒有防護。
  // 這條線壞掉的後果是「開場少一行提醒」,不是算錯數字(會算錯的 readIncoming 本來
  // 就可注入,而且有一個真的合成 git repo 在測)。用永久的接縫換便利性的覆蓋率,
  // 不划算。哪天出現第五個需求,那是處理整個類別的訊號,不是再加一個的訊號。
  const incoming = summarizeIncoming(readIncoming(), role, config);
  if (incoming) {
    console.log('');
    console.log(incoming);
  }

  // 坑註解:**一行計數**,而且放在最後 —— 讀的人最後看到的是它(ADR-009 補充)。
  //
  // 常數長度是刻意的:這段輸出在 SessionStart hook 裡,每個 session 都要付,
  // 而且是注意力最稀缺的那一刻。一條坑很有用,二十條是一面牆,而牆會被跳過 ——
  // 連同它上面那十行一起。所以不管累積到幾條,這裡永遠只有一行。
  const mine = pitsFor(role, scanPits());
  if (mine.length > 0) {
    console.log('');
    console.log(`有 ${mine.length} 條標給你的坑註解(pnpm role --pits 看內容)`);
  }
}
