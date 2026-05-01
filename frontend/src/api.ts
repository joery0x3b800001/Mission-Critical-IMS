const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  getIncidents: () => req<import('./types').WorkItem[]>('/incidents'),
  getIncident: (id: string) => req<import('./types').IncidentDetail>(`/incidents/${id}`),
  updateStatus: (id: string, status: string) =>
    req(`/incidents/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  submitRca: (id: string, rca: Record<string, string>) =>
    req(`/incidents/${id}/rca`, { method: 'POST', body: JSON.stringify(rca) }),
  getHealth: () => req<Record<string, unknown>>('/health'),
};
