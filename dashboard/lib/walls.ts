/**
 * Cliente del CRUD de muros (/walls). Mismo molde que lib/areas.ts:
 * 401 => null (no hay sesión, no es un error); otros !ok => ApiStatusError
 * para que la UI distinga 409 (nombre duplicado) de fallas genéricas.
 * El backend responde {"detail": "..."} (HTTPException del router).
 */

import { ApiStatusError } from './auth';
import type { Wall, WallPayload } from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

async function request<T>(path: string, init?: RequestInit): Promise<T | null> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    cache: 'no-store',
    ...init,
  });
  if (response.status === 401) return null;
  if (!response.ok) {
    let detail = `API Error: ${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { detail?: unknown } | null;
      if (body?.detail) detail = String(body.detail);
    } catch {
      // body no-JSON: queda el mensaje genérico
    }
    throw new ApiStatusError(response.status, detail);
  }
  if (response.status === 204) return null;
  return response.json() as Promise<T>;
}

export async function listWalls(): Promise<Wall[] | null> {
  return request<Wall[]>('/walls');
}

export async function createWall(payload: WallPayload): Promise<Wall | null> {
  return request<Wall>('/walls', { method: 'POST', body: JSON.stringify(payload) });
}

export async function updateWall(id: string, payload: WallPayload): Promise<Wall | null> {
  return request<Wall>(`/walls/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
}

export async function deleteWall(id: string): Promise<void> {
  await request<unknown>(`/walls/${id}`, { method: 'DELETE' });
}
