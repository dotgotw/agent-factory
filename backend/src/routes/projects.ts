import { Router, type Request, type Response } from 'express';
import type { components, operations } from '@af/contract';
import { notifier } from '../notifier.js';

// 型別全部來自 contract,不手寫。
type Project = components['schemas']['Project'];
type CreateProjectRequest = components['schemas']['CreateProjectRequest'];
type UpdateProjectRequest = components['schemas']['UpdateProjectRequest'];
type ApiError = components['schemas']['Error'];
type ListResponse =
  operations['listProjects']['responses']['200']['content']['application/json'];

// MVP 用記憶體儲存;正式版換成 DB 時,型別不變。
const db = new Map<string, Project>();

export const projectsRouter = Router();

/**
 * 解析選填的整數 query 參數。
 * 回傳 null 表示格式非法(非數字、負數、小數),由呼叫端回 400。
 */
function intParam(raw: unknown, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/**
 * 合法的 status 值。用 Record<Project['status'], true> 而不是字串陣列 ——
 * contract 日後新增 enum 值時,這裡會因為少一個鍵而 typecheck 紅,
 * 而不是安靜地把新值當成非法輸入擋掉。
 */
const PROJECT_STATUSES: Record<Project['status'], true> = {
  active: true,
  archived: true,
};

function isProjectStatus(value: unknown): value is Project['status'] {
  return typeof value === 'string' && Object.hasOwn(PROJECT_STATUSES, value);
}

/** GET 與 PATCH 共用同一句話 —— 同一個欄位不該有兩種說法。 */
const INVALID_STATUS_MESSAGE = `status 必須是 ${Object.keys(PROJECT_STATUSES).join(' / ')} 其中之一`;

/**
 * 解析 status 篩選參數。回傳值有三種意思:
 *   undefined —— 不篩選(未帶,或空字串)
 *   null      —— 值非法,由呼叫端回 400
 *   其餘      —— 要篩的狀態
 *
 * 空字串視同未帶是 contract 明寫的(見 GET /projects 的 400 描述):client
 * 無條件串上 `&status=` 是常見寫法,為此回 400 不划算。
 *
 * 重複帶參數(?status=active&status=archived)會拿到陣列,不是字串 ——
 * isProjectStatus 的 typeof 檢查把它擋在 400,而不是讓 Map 比對靜默地全部落空。
 */
function statusParam(raw: unknown): Project['status'] | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  return isProjectStatus(raw) ? raw : null;
}

/**
 * contract 的 `format: email` 沒有規定要驗到多嚴。這條規則刻意寬鬆:它擋的是
 * 「明顯不可能是信箱」的輸入,不是保證寄得到 —— 寄得到的唯一證明是交付本身。
 * 寫得太嚴會擋掉合法但少見的地址,而那種誤擋在這裡沒有補救路徑(改不了
 * 既有專案的 ownerEmail,見 ADR-004「不在本 ADR 範圍」)。
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 解析選填的 ownerEmail。回傳值有三種意思:
 *   undefined —— 未帶
 *   null      —— 值非法,由呼叫端回 400
 *   其餘      —— 去掉頭尾空白後的信箱
 *
 * 空字串也是 400,不當成「未帶」—— 這裡跟 GET 的 status filter 刻意不同:
 * status 的空字串規則是 contract 明寫的,而一個 body 欄位送空字串是 client
 * 的 bug。靜默丟掉的話,專案會安靜地變成「沒有負責人」,然後永遠不會有人
 * 收到通知 —— 那正是 ADR-004 要補的那種看不見的洞。
 */
function ownerEmailField(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return EMAIL_SHAPE.test(trimmed) ? trimmed : null;
}

/**
 * 兩個 request schema 各自允許的欄位 —— contract 的 additionalProperties: false
 * 在這裡兌現。
 *
 * 用 Record<keyof …, true> 而不是字串陣列:contract 新增或改名欄位時,這裡會
 * 因為鍵對不上而 typecheck 紅,而不是安靜地把一個合法的新欄位擋成 400。
 * 跟 PROJECT_STATUSES 同一招 —— 白名單最怕的就是它自己過期。
 */
const CREATE_FIELDS: Record<keyof CreateProjectRequest, true> = {
  name: true,
  ownerEmail: true,
};
const UPDATE_FIELDS: Record<keyof UpdateProjectRequest, true> = {
  status: true,
};

/** body 裡沒有定義的欄位名,依 client 送來的順序。空陣列代表沒有。 */
function unknownFields(body: object, allowed: object): string[] {
  return Object.keys(body).filter((key) => !Object.hasOwn(allowed, key));
}

/**
 * 錯誤訊息把 client 送來的欄位名原樣列出來 —— 這正是這條驗證的用處:
 * `ownerEmial` 這種打錯一個字的欄位,不指名的話對方看不出哪裡錯。
 * 一併列出接受的欄位,省掉一次翻文件。
 */
function unknownFieldsMessage(unknown: string[], allowed: object): string {
  return (
    `body 出現未定義的欄位:${unknown.join('、')}。` +
    `此請求只接受 ${Object.keys(allowed).join('、')}`
  );
}

projectsRouter.get('/', (req: Request, res: Response<ListResponse | ApiError>) => {
  const status = statusParam(req.query.status);

  // 預設值與範圍皆依 contract 的 schema(limit: 1..100 預設 20;offset: ≥0 預設 0)。
  const limit = intParam(req.query.limit, 20);
  const offset = intParam(req.query.offset, 0);

  // 依 contract 宣告參數的順序驗證:status、limit、offset。
  // 同時帶了兩個爛參數時先報哪一個,contract 沒規定,順序一致比較好解釋。
  if (status === null) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: INVALID_STATUS_MESSAGE,
    });
  }
  if (limit === null || limit < 1 || limit > 100) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'limit 必須是 1 到 100 之間的整數',
    });
  }
  if (offset === null) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'offset 必須是不小於 0 的整數',
    });
  }

  const matched = [...db.values()].filter((p) => !status || p.status === status);

  // total 是「篩選後、分頁前」的筆數 —— 前端據此計算頁數。
  res.json({ items: matched.slice(offset, offset + limit), total: matched.length });
});

projectsRouter.post(
  '/',
  (req: Request, res: Response<Project | ApiError>) => {
    const body = (req.body ?? {}) as Partial<CreateProjectRequest>;

    // AC-015:未定義的欄位擋在最前面。`{"nmae":"x"}` 同時是「name 缺漏」與
    // 「多了 nmae」,而後者才指得出打錯的那個字 —— 先報有用的那個。
    const unknown = unknownFields(body, CREATE_FIELDS);
    if (unknown.length > 0) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: unknownFieldsMessage(unknown, CREATE_FIELDS),
      });
    }

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'name 為必填且不可為空',
      });
    }
    if (body.name.length > 80) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'name 長度不可超過 80',
      });
    }

    const ownerEmail = ownerEmailField(body.ownerEmail);
    if (ownerEmail === null) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'ownerEmail 必須是有效的電子郵件位址',
      });
    }

    const project: Project = {
      id: crypto.randomUUID(),
      name: body.name.trim(),
      status: 'active',
      createdAt: new Date().toISOString(),
      // 沒帶就整個欄位不存在,而不是存一個 undefined —— 回應裡不該出現
      // 「有這個 key 但沒有值」的專案。
      ...(ownerEmail === undefined ? {} : { ownerEmail }),
    };
    db.set(project.id, project);
    res.status(201).json(project);
  },
);

projectsRouter.get(
  '/:projectId',
  (req: Request, res: Response<Project | ApiError>) => {
    const projectId = req.params.projectId;
    const project = projectId ? db.get(projectId) : undefined;
    if (!project) {
      return res
        .status(404)
        .json({ code: 'NOT_FOUND', message: '找不到該專案' });
    }
    res.json(project);
  },
);

projectsRouter.patch(
  '/:projectId',
  async (req: Request, res: Response<Project | ApiError>) => {
    const body = (req.body ?? {}) as Partial<UpdateProjectRequest>;

    // AC-015:未定義的欄位擋在最前面。最具體的案例是 ADR-004 自己造出來的
    // —— 改既有專案的 ownerEmail 沒有路徑,client 遲早會送 PATCH
    // {"status":…,"ownerEmail":…};靜默忽略的話它拿到 200、負責人沒變,
    // 而它沒有任何辦法知道。
    const unknown = unknownFields(body, UPDATE_FIELDS);
    if (unknown.length > 0) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: unknownFieldsMessage(unknown, UPDATE_FIELDS),
      });
    }

    // 先驗 body,再查資料。兩者都是呼叫端的錯,但格式錯是 client 程式的 bug
    // ——換一個 id 還是會錯——而 404 只是這一筆資料的狀態。先講會一直重演的那個。
    if (body.status === undefined) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'status 為必填',
      });
    }
    if (!isProjectStatus(body.status)) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: INVALID_STATUS_MESSAGE,
      });
    }

    const projectId = req.params.projectId;
    const project = projectId ? db.get(projectId) : undefined;
    if (!project) {
      return res
        .status(404)
        .json({ code: 'NOT_FOUND', message: '找不到該專案' });
    }

    // AC-014:狀態沒有真的改變就不是「狀態異動」——不通知,lastNotifiedAt
    // 原封不動。少了這一段,一個會重試的 client 就是一台騷擾負責人的機器。
    if (project.status === body.status) {
      return res.json(project);
    }

    // 展開既有專案而不是只寫 status —— ownerEmail、lastNotifiedAt 不該因為
    // 一次封存就消失。contract 只允許改 status,其餘欄位原封不動。
    const updated: Project = { ...project, status: body.status };

    // 先把狀態存進去,再談通知。這支 API 的職責是改狀態,通知是副作用不是
    // 前提(ADR-004 第三條)—— 交換順序的話,寄送機制掛掉就會連狀態都改不了。
    db.set(project.id, updated);

    // AC-009:沒有負責人就沒有人要通知。不是錯誤,只是沒有 lastNotifiedAt。
    if (updated.ownerEmail === undefined) {
      return res.json(updated);
    }

    try {
      await notifier.deliver({
        ownerEmail: updated.ownerEmail,
        projectId: updated.id,
        projectName: updated.name,
        from: project.status,
        to: updated.status,
      });
    } catch (err) {
      // 通知失敗不讓 PATCH 失敗,但也不能無聲無息:lastNotifiedAt 不更新,
      // 於是「沒通知成功」在 API 上一樣看得見(ADR-004 第三條)。
      console.error(`[notify] 交付失敗 project=${updated.id}`, err);
      return res.json(updated);
    }

    // AC-008:lastNotifiedAt 記的是「成功交付給寄送機制」的時刻 —— 所以在
    // await 之後才取時間,不是在送出之前。它不代表對方收到了。
    const notified: Project = { ...updated, lastNotifiedAt: new Date().toISOString() };
    db.set(project.id, notified);
    res.json(notified);
  },
);
