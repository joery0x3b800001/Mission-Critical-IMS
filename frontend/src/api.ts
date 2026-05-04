const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

// Reusable fetch options with keepalive for connection pooling
const DEFAULT_FETCH_OPTS: RequestInit = {
  keepalive: true,
  headers: { 'Content-Type': 'application/json' },
};

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...DEFAULT_FETCH_OPTS,
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

// Helper to build query strings efficiently (use URLSearchParams for proper encoding)
const buildQuery = (params: Record<string, number>): string => {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => sp.set(k, String(v)));
  return sp.toString();
};

export const api = {
  // Fetch incidents with pagination support
  getIncidents: (offset = 0, limit = 50) =>
    req<{ incidents: import('./types').WorkItem[]; pagination: { offset: number; limit: number; total: number; hasMore: boolean } }>(
      `/incidents?${buildQuery({ offset, limit })}`
    ),
  // Fetch single incident detail with optional raw signals pagination
  getIncident: (id: string, signalOffset = 0, signalLimit = 50) =>
    req<import('./types').IncidentDetail>(
      `/incidents/${id}?${buildQuery({ signalOffset, signalLimit })}`
    ),
  updateStatus: (id: string, status: string) =>
    req(`/incidents/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  submitRca: (id: string, rca: Record<string, string>) =>
    req(`/incidents/${id}/rca`, { method: 'POST', body: JSON.stringify(rca) }),
  getHealth: () => req<Record<string, unknown>>('/health'),
};
