import { api, type Project } from './api-client.js';

function renderRow(p: Project): string {
  // 這裡每一個欄位存取都受 contract 約束。
  // 若 openapi.yaml 把 name 改名,這行會在 typecheck 直接失敗。
  return `<li data-id="${p.id}">
    <strong>${p.name}</strong>
    <span class="status status--${p.status}">${p.status}</span>
    <time>${new Date(p.createdAt).toLocaleDateString()}</time>
  </li>`;
}

export async function mount(root: HTMLElement): Promise<void> {
  const { items } = await api.listProjects();
  root.innerHTML = items.length
    ? `<ul class="projects">${items.map(renderRow).join('')}</ul>`
    : `<p class="empty">尚無專案</p>`;
}

export async function handleCreate(name: string, root: HTMLElement) {
  await api.createProject({ name });
  await mount(root);
}
