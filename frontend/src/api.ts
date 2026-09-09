import type { EditPlan, Health, JobStatus, Manifest } from './types';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.message || `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  base: API_BASE,
  health: () => fetch(`${API_BASE}/api/health`).then(json<Health>),
  jobs: () => fetch(`${API_BASE}/api/jobs?limit=12`).then(json<{ jobs: JobStatus[] }>),
  job: (id: string) => fetch(`${API_BASE}/api/jobs/${id}`).then(json<JobStatus>),
  manifest: (id: string) => fetch(`${API_BASE}/api/jobs/${id}/manifest`).then(json<Manifest>),
  plan: (id: string) => fetch(`${API_BASE}/api/jobs/${id}/plan`).then(json<EditPlan>),
  createJob: (form: FormData) => fetch(`${API_BASE}/api/jobs`, { method: 'POST', body: form }).then(json<{ job_id: string; state: string }>),
  replan: (id: string, body: { edit_prompt: string; narration_text: string; voice?: string }) =>
    fetch(`${API_BASE}/api/jobs/${id}/replan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json<{ job_id: string; state: string }>),
  updatePlan: (id: string, plan: EditPlan) =>
    fetch(`${API_BASE}/api/jobs/${id}/plan`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan }),
    }).then(json<EditPlan>),
  render: (id: string, aspect_ratio: string, caption_style: string) =>
    fetch(`${API_BASE}/api/jobs/${id}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ aspect_ratio, caption_style }),
    }).then(json<{ job_id: string; state: string }>),
};
