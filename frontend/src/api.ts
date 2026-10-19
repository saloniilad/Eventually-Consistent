export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000').replace(
  /\/+$/,
  '',
);
export const WS_URL = API_URL.replace(/^http/, 'ws');

export type Role = 'owner' | 'editor' | 'viewer';

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface DocMeta {
  id: string;
  title: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}
export type DocSummary = DocMeta & { role: Role };

export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

export interface VersionList {
  head: number;
  snapshots: Array<{ seq: number; createdAt: string }>;
}

export interface Comparison {
  from: { seq: number; text: string };
  to: { seq: number; text: string };
  diff: DiffLine[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'ec.token';
export const tokenStore = {
  get: (): string | null => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string): void => {
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch {
      /* storage unavailable */
    }
  },
  clear: (): void => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
  },
};

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: (() => void) | null): void => {
  onUnauthorized = fn;
};

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const token = tokenStore.get();
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, `Cannot reach the server at ${API_URL}`);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 401 && opts.auth !== false) onUnauthorized?.();
    throw new ApiError(res.status, String(json.error ?? `Request failed (${res.status})`));
  }
  return json as T;
}

export const api = {
  register: (name: string, email: string, password: string) =>
    request<{ token: string; user: User }>('/api/auth/register', {
      method: 'POST',
      body: { name, email, password },
      auth: false,
    }),
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    }),
  me: () => request<{ user: User }>('/api/auth/me'),

  listDocs: () => request<{ documents: DocSummary[] }>('/api/docs'),
  createDoc: (title: string) =>
    request<{ document: DocSummary }>('/api/docs', { method: 'POST', body: { title } }),
  getDoc: (id: string) =>
    request<{ document: DocMeta; role: Role; text: string; seq: number }>(`/api/docs/${id}`),
  renameDoc: (id: string, title: string) =>
    request<{ ok: true; title: string }>(`/api/docs/${id}`, { method: 'PATCH', body: { title } }),
  share: (id: string, email: string, role: 'editor' | 'viewer') =>
    request<{ ok: true; userId: string; role: string }>(`/api/docs/${id}/members`, {
      method: 'POST',
      body: { email, role },
    }),

  versions: (id: string) => request<VersionList>(`/api/docs/${id}/versions`),
  versionAt: (id: string, seq: number) =>
    request<{ requested: number; seq: number; text: string }>(`/api/docs/${id}/versions/${seq}`),
  compare: (id: string, from: number, to?: number) =>
    request<Comparison>(`/api/docs/${id}/compare?from=${from}${to === undefined ? '' : `&to=${to}`}`),
  restore: (id: string, seq: number) =>
    request<{ ok: true; restoredFrom: number; inserted: number; deleted: number; seq: number }>(
      `/api/docs/${id}/versions/${seq}/restore`,
      { method: 'POST' },
    ),
};
