import { Router, type Request, type Response } from 'express';
import type { components, operations } from '../../../generated/api.js';

// 型別全部來自 contract,不手寫。
type Project = components['schemas']['Project'];
type CreateProjectRequest = components['schemas']['CreateProjectRequest'];
type ApiError = components['schemas']['Error'];
type ListResponse =
  operations['listProjects']['responses']['200']['content']['application/json'];

// MVP 用記憶體儲存;正式版換成 DB 時,型別不變。
const db = new Map<string, Project>();

export const projectsRouter = Router();

projectsRouter.get('/', (req: Request, res: Response<ListResponse>) => {
  const status = req.query.status as Project['status'] | undefined;
  const items = [...db.values()].filter((p) => !status || p.status === status);
  res.json({ items });
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
