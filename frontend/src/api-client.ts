import type { components, operations } from '@af/contract';

export type Project = components['schemas']['Project'];
export type CreateProjectRequest = components['schemas']['CreateProjectRequest'];

type ListResponse =
  operations['listProjects']['responses']['200']['content']['application/json'];

const BASE = import.meta.env?.VITE_API_BASE ?? 'http://localhost:3000';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const err = (await res.json()) as components['schemas']['Error'];
    throw new Error(`${err.code}: ${err.message}`);
  }
  return (await res.json()) as T;
}

export const api = {
  listProjects(status?: Project['status']): Promise<ListResponse> {
    const qs = status ? `?status=${status}` : '';
    return request<ListResponse>(`/projects${qs}`);
  },

  createProject(body: CreateProjectRequest): Promise<Project> {
    return request<Project>('/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  getProject(projectId: string): Promise<Project> {
    return request<Project>(`/projects/${projectId}`);
  },
};
