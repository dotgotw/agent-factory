#!/usr/bin/env node
/**
 * scripts/pits.mjs —— 坑註解:第一個實例的家(ADR-009 補充)
 *
 *   // 坑(下一個踩的人:qa):e2e 的 port 寫死,兩個 session 同時跑會互撞
 *
 * 規則一條:**必須指名一個角色**。
 *
 * ## 為什麼這個標記不會變成墓地
 *
 * 不是因為字選得好。TODO 爛掉是因為寫的時候有人、讀的時候沒有 —— 任何標記只要
 * 沒有人固定去看,三個月後都是同一個下場。這個標記有一個**現成的自動消費者**:
 * pnpm role 在 SessionStart hook 裡,每個 session 開場都跑,沒有人需要記得它。
 *
 * 最強的性質是第三個,它不靠紀律:**噪音落在被指名的人身上。** 亂標一堆給 qa,
 * qa 每次開 session 都看到,然後來找你。
 *
 * **它擋不住「穿著外套的 TODO」**(`坑(下一個踩的人:backend):這裡還沒做`)——
 * 命名幫得上忙但擋不住,真正擋住它的是被指名的人會來問。靠的是社會成本,不是語意。
 * 這句話寫在這裡是為了讓下一個人別以為形狀檢查有那個保證。
 *
 * ## 抓不到的兩種,以及為什麼不追
 *
 * 識別子是前綴「坑(下一個踩的人」。命中它就必須寫對形狀 —— 少冒號、括號沒關好、
 * 角色留空都會紅。但完全記錯格式的兩種抓不到:
 *
 *     // 坑:忘了整個括號
 *     // 坑(qa):只寫了角色
 *
 * **不要為了它們把識別子放寬到「坑(」。** 量過:掃描範圍內含「坑」的 8 行沒有一行是
 * 標記,而 e2e/server.ts:2 寫著「它們踩的是同一個坑(CR-004)」—— 那是正常的中文,
 * 放寬會立刻誤判它。假警報的下場這個 repo 已經寫過三次:被人繞掉,連同它擋得住的
 * 那些一起。
 *
 * 這兩種跟散文分不出來,所以是一筆記下來的欠帳,不是漏做。
 * (記在這裡而不是 ADR-009:會再踩到這件事的人,是下一個想把這個檢查寫更嚴的人,
 * 而他那時在看的就是這支腳本。ADR-009 的第二問。)
 *
 * ## 掃描只看程式與測試,不看文件、不看衍生輸出
 *
 * 見 SKIP_* 那段的三個理由。一句話版本:**標記出現在文件裡是規格,出現在衍生
 * 輸出裡是副本,只有出現在程式與測試裡才是誰的坑。**
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 標記字串。**只定義在這裡一份。**
 *
 * role.mjs(列出)與 check-pits.mjs(形狀檢查)都 import 它 —— 兩份不同步的症狀是
 * 「檢查說沒問題,但 role 印不出來」:兩邊都綠,而東西不見了。同 STATUSES 那次。
 */
export const PIT_PREFIX = '坑(下一個踩的人';

/**
 * 完整形狀。角色那一格允許空白,才驗得出「用了標記卻沒指名」。
 *
 * **識別與驗證是兩件事**:命中 PIT_PREFIX 就算「你想寫一則坑註解」,
 * 而只有命中這條 RE 才算「你寫對了」。分開之後,少冒號、括號沒關好、角色留空
 * 都會被抓到 —— 合起來的話它們會因為「解析不出來」而被當成一般註解靜默跳過,
 * 那是最糟的失敗:寫的人以為留下了坑註解,被指名的人卻永遠看不到。
 */
export const PIT_RE = /坑\(下一個踩的人:([^)）]*)\)\s*[:：]?\s*(.*)$/;

/**
 * 掃描不看的東西,三類,理由各不相同。
 *
 *   generated/          衍生輸出。openapi.yaml 的 description 會流進去變成
 *                       @description,數它等於把同一個坑數兩次(ADR-002 的同一條線)。
 *
 *   *.md                文件。ADR、README、AGENTS.md 裡出現的標記是**範例與規格**,
 *                       不是誰的坑 —— 實測:不排除的話,ADR-009 自己的那兩個示範
 *                       會變成「標給 qa 與 backend 的坑註解」,機制第一天就在噴假訊號。
 *                       這也順帶處理了 scope.json 的 note 流進 AGENTS.md 生成段
 *                       那個重複來源。坑註解的家是**程式與測試**,不是文件;
 *                       文件本來就會被人直接讀,不需要這個機制帶路。
 *
 *   本機制自己的三個檔案  定義(本檔)、檢查(check-pits.mjs)、測試(pits.test.mjs)。
 *                       裡面的標記是規格、說明文字與 fixture,不是誰的坑。
 *
 *                       這個形狀咬了三次:ADR 的範例、本檔的檔頭、check-pits 的
 *                       錯誤訊息 —— **任何寫出標記字面的地方都會被自己掃到**。
 *                       所以規則不是「排除特例」,是「寫出字面的地方本來就不是坑」。
 *
 * 排除之後「恰好數一次」自動成立,所以**不對 generated/ 裡的標記另外判紅** ——
 * 手改那裡已經被 scope-guard 與 check:drift 擋了兩道,而從 description 流進去的
 * 副本罰它等於罰一個沒有人手寫的檔案。
 */
const SKIP_PREFIXES = ['generated/'];
const SKIP_EXACT = ['scripts/pits.mjs', 'scripts/check-pits.mjs', 'scripts/pits.test.mjs'];

export function isSkipped(file) {
  if (file.endsWith('.md')) return true;
  if (SKIP_EXACT.includes(file)) return true;
  return SKIP_PREFIXES.some((p) => file.startsWith(p));
}

/**
 * 從一行文字解析。
 *
 *   沒有前綴          → null(不是坑註解,也不打算是)
 *   有前綴、形狀不對  → { malformed: true }(想寫但寫壞了 —— 這要紅)
 *   形狀對            → { role, note }
 */
export function parsePit(line) {
  if (!line.includes(PIT_PREFIX)) return null;
  const m = line.match(PIT_RE);
  if (!m) return { role: null, note: null, malformed: true, raw: line.trim() };
  return { role: m[1].trim(), note: m[2].trim(), malformed: false };
}

/**
 * 掃描整個 repo 的坑註解。回傳 [{ file, line, role, note }]。
 *
 * 用 git grep 而不是自己讀所有檔案:它只看被追蹤的檔案(node_modules 自動排除),
 * 而且這支會在**每個 session 開場**被呼叫 —— 那個位置不該付「讀完整個 repo」的成本。
 */
export function scanPits({ cwd = rootDir } = {}) {
  let out;
  try {
    out = execFileSync('git', ['grep', '-n', '--fixed-strings', PIT_PREFIX], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return []; // git grep 沒找到東西時 exit 1,不是錯誤
  }

  const pits = [];
  for (const row of out.split('\n').filter(Boolean)) {
    const m = row.match(/^([^:]+):(\d+):(.*)$/s);
    if (!m) continue;
    const [, file, lineNo, text] = m;
    if (isSkipped(file)) continue;

    const parsed = parsePit(text);
    if (!parsed) continue;
    pits.push({ file, line: Number(lineNo), ...parsed });
  }
  return pits;
}

/** 某個角色的坑註解。壞掉的形狀不算任何人的 —— 它們由 check:pits 判紅。 */
export function pitsFor(role, pits = scanPits()) {
  return pits.filter((p) => !p.malformed && p.role === role);
}

/**
 * 形狀檢查:用了標記就必須指名一個存在的角色。
 *
 * 只驗這一半。「這是不是真的坑」不可判定,不假裝驗。
 */
export function shapeErrors(pits, roles) {
  const out = [];
  for (const p of pits) {
    if (p.malformed) {
      out.push(
        `${p.file}:${p.line}: 坑註解的形狀不完整(少了冒號、括號沒關好之類)—— ` +
          `${p.raw}`,
      );
    } else if (!roles.includes(p.role)) {
      out.push(
        `${p.file}:${p.line}: 坑註解指名的「${p.role || '(空白)'}」不是 scope.json 裡的角色` +
          `(${roles.join('、')})—— 沒有指名就沒有人會讀到它`,
      );
    }
  }
  return out;
}
