/**
 * Cliente de autenticación para GeoSpectrum API.
 *
 * `credentials: 'include'` es obligatorio en las tres funciones: la sesión
 * viaja en una cookie httpOnly (`session`, ver design.md Decision 1) y el
 * dashboard (localhost:3008) llama a la API en un origen distinto
 * (localhost:8000) — sin `credentials: 'include'` el browser ni manda ni
 * guarda esa cookie en requests cross-origin.
 */

import type { UserPublic } from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

/**
 * Login. Lanza en cualquier respuesta que no sea 200 (incluye 401 por
 * credenciales inválidas) — el caller (login page) decide cómo mostrar el
 * error genérico que ya devuelve el backend ("invalid credentials").
 */
export async function login(email: string, password: string): Promise<UserPublic> {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    throw new Error('invalid credentials');
  }

  return response.json();
}

/**
 * Logout. El endpoint responde 204 incluso sin sesión activa (ver
 * spec: Requirement Logout) — no hay nada que devolver ni que fallar en
 * el caso feliz.
 */
export async function logout(): Promise<void> {
  await fetch(`${API_BASE_URL}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });
}

/**
 * Perfil del usuario autenticado. Un 401 NO es un error de red — es el
 * estado válido "no hay sesión", por eso retorna `null` en vez de lanzar.
 * Cualquier otro fallo (red caída, 500, etc.) se propaga como excepción
 * para que el caller lo distinga de "simplemente no hay sesión".
 */
export async function getMe(): Promise<UserPublic | null> {
  const response = await fetch(`${API_BASE_URL}/auth/me`, {
    credentials: 'include',
    cache: 'no-store',
  });

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}
