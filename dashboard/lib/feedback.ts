/**
 * Cliente del feedback de beta testers (/feedback). Mismo molde que
 * lib/walls.ts: 401 => null (no hay sesión, no es un error); otros !ok =>
 * ApiStatusError con el `detail` del backend, para que la UI distinga un 403
 * (rol degradado en caliente) de un 422 o de una falla genérica.
 *
 * Los valores que viajan al API (`type`, `status`) son SIEMPRE los literales
 * en inglés; las etiquetas humanas son i18n del cliente.
 */

import { ApiStatusError } from './auth';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export type FeedbackType = 'bug' | 'suggestion';
export type FeedbackStatus = 'new' | 'in_analysis' | 'in_progress' | 'done' | 'discarded';

/** Orden de las columnas del flujo; `discarded` se renderiza aparte (no es
 * "otro Hecho"). */
export const FLOW_STATUSES: readonly FeedbackStatus[] = ['new', 'in_analysis', 'in_progress', 'done'];

/** Los cinco estados en el orden del menú "Mover a…": el flujo y, al final,
 * `discarded` (siempre visible y distinguible de `done`). */
export const FEEDBACK_STATUSES: readonly FeedbackStatus[] = [...FLOW_STATUSES, 'discarded'];

/** Guard para ids que llegan sin tipar (p. ej. el `over.id` de dnd-kit). */
export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return typeof value === 'string' && (FEEDBACK_STATUSES as readonly string[]).includes(value);
}

/** Key de SWR del tablero: el widget la revalida tras un 201 para que la
 * tarjeta nueva aparezca en Nuevo si el tablero está montado. */
export const FEEDBACK_SWR_KEY = '/feedback';

export interface FeedbackPayload {
  type: FeedbackType;
  /** 1..2000, NUNCA truncado por el cliente (422 si excede). */
  body: string;
  /** usePathname().slice(0, 300) */
  route: string;
  /** window.location.href.slice(0, 2000) */
  url: string;
  /** navigator.userAgent.slice(0, 400) */
  user_agent: string;
}

export interface FeedbackReportCreated {
  id: string;
  created_at: string;
}

export interface FeedbackReport {
  id: string;
  type: FeedbackType;
  body: string;
  route: string;
  url: string;
  user_agent: string;
  author_email: string;
  created_at: string;
  status: FeedbackStatus;
  /** `null` hasta el primer movimiento (reconciliación 3 del tasks.md). */
  status_changed_at: string | null;
  admin_comment: string | null;
  admin_comment_updated_at: string | null;
}

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
  return response.json() as Promise<T>;
}

export async function submitFeedback(payload: FeedbackPayload): Promise<FeedbackReportCreated | null> {
  return request<FeedbackReportCreated>('/feedback', { method: 'POST', body: JSON.stringify(payload) });
}

/** Desenvuelve el `{"reports": [...]}` del backend: el cliente agrupa por
 * `status`, la API devuelve la lista plana ordenada por `created_at DESC`. */
export async function listFeedbackReports(): Promise<FeedbackReport[] | null> {
  const data = await request<{ reports: FeedbackReport[] }>('/feedback');
  return data === null ? null : data.reports;
}

export async function updateFeedbackStatus(id: string, status: FeedbackStatus): Promise<FeedbackReport | null> {
  return request<FeedbackReport>(`/feedback/${id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
}

/** `null` (o vacío) BORRA el comentario del admin; el backend normaliza. */
export async function updateFeedbackComment(id: string, comment: string | null): Promise<FeedbackReport | null> {
  return request<FeedbackReport>(`/feedback/${id}/comment`, {
    method: 'PUT',
    body: JSON.stringify({ comment }),
  });
}
