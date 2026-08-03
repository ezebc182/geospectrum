/**
 * Cliente de áreas de interés (AOI-1).
 *
 * Sigue el patrón de lib/auth.ts (funciones sueltas) y no el de lib/api.ts
 * (clase): estos endpoints SIEMPRE requieren sesión, mientras que SeismicAPI
 * agrupa los públicos. `credentials: 'include'` es obligatorio en las cuatro
 * funciones — la sesión viaja en una cookie HttpOnly y el dashboard corre en
 * otro origen que la API (:3008 vs :8000).
 *
 * Los 401 se devuelven como `null` en vez de tirar: "no hay sesión" es un
 * estado normal del dashboard (usuario anónimo mirando /live), no un error que
 * haya que manejar con try/catch en cada componente. Cualquier OTRO fallo sí
 * se propaga: un 500 no debe disfrazarse de "no estás logueado".
 */

import type { ActiveAreaResponse, Area } from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

async function request<T>(
  path: string,
  init?: RequestInit
): Promise<T | null> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    cache: 'no-store',
    ...init,
  });

  if (response.status === 401) return null;

  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

/** Presets del sistema + áreas propias, en el orden que fija el backend. */
export async function listAreas(): Promise<Area[] | null> {
  return request<Area[]>('/areas');
}

/** Área activa del usuario, con el preset por defecto como fallback. */
export async function getActiveArea(): Promise<ActiveAreaResponse | null> {
  return request<ActiveAreaResponse>('/areas/active');
}

/**
 * Cambia el área activa. `areaId = null` significa "volver al preset por
 * defecto" — es un valor legítimo, no un campo faltante.
 */
export async function setActiveArea(
  areaId: string | null
): Promise<ActiveAreaResponse | null> {
  return request<ActiveAreaResponse>('/areas/active', {
    method: 'PUT',
    body: JSON.stringify({ area_id: areaId }),
  });
}
