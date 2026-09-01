import { Router, type Request, type Response } from 'express';
import type { components, operations } from '@af/contract';

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

projectsRouter.get('/', (req: Request, res: Response<ListResponse | ApiError>) => {
  const status = req.query.status as Project['status'] | undefined;

  // 預設值與範圍皆依 contract 的 schema(limit: 1..100 預設 20;offset: ≥0 預設 0)。
  const limit = intParam(req.query.limit, 20);
  const offset = intParam(req.query.offset, 0);

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
    const body = req.body as Partial<CreateProjectRequest>;

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

    const project: Project = {
      id: crypto.randomUUID(),
      name: body.name.trim(),
      status: 'active',
      createdAt: new Date().toISOString(),
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
  (req: Request, res: Response<Project | ApiError>) => {
    const body = (req.body ?? {}) as Partial<UpdateProjectRequest>;

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
        message: `status 必須是 ${Object.keys(PROJECT_STATUSES).join(' / ')} 其中之一`,
      });
    }

    const projectId = req.params.projectId;
    const project = projectId ? db.get(projectId) : undefined;
    if (!project) {
      return res
        .status(404)
        .json({ code: 'NOT_FOUND', message: '找不到該專案' });
    }

    // 展開既有專案而不是只寫 status —— ownerEmail 這類欄位不該因為一次
    // 封存就消失。contract 只允許改 status,其餘欄位原封不動。
    const updated: Project = { ...project, status: body.status };
    db.set(project.id, updated);
    res.json(updated);
  },
);
