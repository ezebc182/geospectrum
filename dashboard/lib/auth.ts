/**
 * Cliente de autenticación para GeoSpectrum API.
 *
 * `credentials: 'include'` es obligatorio en las tres funciones: la sesión
 * viaja en una cookie httpOnly (`session`, ver design.md Decision 1) y el
 * dashboard (localhost:3008) llama a la API en un origen distinto
 * (localhost:8000) — sin `credentials: 'include'` el browser ni manda ni
 * guarda esa cookie en requests cross-origin.
 */

import type {
  AccountExport,
  LoginResult,
  TotpSetupResponse,
  UserProfile,
  UserProfileUpdate,
  UserPublic,
} from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

/**
 * Login. Lanza en cualquier respuesta que no sea 200 (incluye 401 por
 * credenciales inválidas) — el caller (login page) decide cómo mostrar el
 * error genérico que ya devuelve el backend ("invalid credentials").
 *
 * Cuando el usuario tiene 2FA habilitado, el backend responde 200 con
 * `{"requires_2fa": true}` y una cookie `pending_2fa_session` (NO `session`
 * completa) — esto NO es un error, es un resultado válido: se retorna como
 * `{requiresTwoFactor: true}` en vez de lanzar, para que el caller muestre
 * el segundo paso del login (ver design.md Decision 1).
 */
export async function login(email: string, password: string): Promise<LoginResult> {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    throw new Error('invalid credentials');
  }

  const body = await response.json();
  if (body?.requires_2fa === true) {
    return { requiresTwoFactor: true };
  }

  return { requiresTwoFactor: false, user: body as UserPublic };
}

/**
 * Segundo paso del login con 2FA: envía el código TOTP (o un backup code)
 * contra la cookie `pending_2fa_session` emitida por `login()`. En éxito el
 * backend emite la cookie `session` completa y borra `pending_2fa_session`.
 * Lanza en cualquier respuesta que no sea 200 — el body no distingue si el
 * código era TOTP o backup code (mismo criterio de no filtrar información
 * que ya aplica a errores de login por password, ver spec.md).
 */
export async function verifyTotpLogin(code: string): Promise<UserPublic> {
  const response = await fetch(`${API_BASE_URL}/auth/2fa/login-verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ code }),
  });

  if (!response.ok) {
    throw new Error('invalid code');
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

/**
 * Perfil extendido (`full_name`/`address`/`phone`) — DISTINTO de `UserPublic`
 * (nunca viaja en `/auth/me` ni en el JWT, ver design.md Decisión Cerrada #4).
 */
export async function getProfile(): Promise<UserProfile> {
  const response = await fetch(`${API_BASE_URL}/account/profile`, {
    credentials: 'include',
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/** Edición parcial del perfil extendido — campos no enviados no se tocan. */
export async function updateProfile(update: UserProfileUpdate): Promise<UserProfile> {
  const response = await fetch(`${API_BASE_URL}/account/profile`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(update),
  });

  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Inicia (o re-inicia) el setup de 2FA. Devuelve el `otpauth_uri` (para
 * renderizar el QR client-side, ver design.md Decision 7) y los backup codes
 * en texto claro — SOLO en esta respuesta, nunca de nuevo (ver spec.md
 * Requirement: Backup codes expuestos una única vez). Puede fallar con 400/409
 * si el usuario es 100% Google (`password_hash IS NULL`) o ya tiene 2FA activo.
 */
export async function setupTotp(): Promise<TotpSetupResponse> {
  const response = await fetch(`${API_BASE_URL}/auth/2fa/setup`, {
    method: 'POST',
    credentials: 'include',
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `API Error: ${response.status}`);
  }

  return response.json();
}

/** Confirma el setup de 2FA con el primer código generado por la app
 * authenticator — en éxito, `totp_enabled` pasa a `true`. */
export async function verifyTotpSetup(code: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/auth/2fa/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ code }),
  });

  if (!response.ok) {
    throw new Error('invalid code');
  }
}

/** Deshabilita 2FA para el usuario autenticado (idempotente en el backend). */
export async function disableTotp(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/auth/2fa/disable`, {
    method: 'POST',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`);
  }
}

/** Exporta los datos propios de cuenta (sin `password_hash`/`totp_secret`,
 * ya garantizado por el backend). El caller decide cómo descargarlo. */
export async function exportData(): Promise<AccountExport> {
  const response = await fetch(`${API_BASE_URL}/account/export`, {
    credentials: 'include',
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Elimina la cuenta propia (hard-delete). Puede fallar con 409 si el
 * usuario es el último superadmin del sistema (ver spec.md Requirement:
 * Eliminación de la propia cuenta) — el mensaje del backend se propaga tal
 * cual para que la UI lo muestre.
 */
export async function deleteAccount(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/account`, {
    method: 'DELETE',
    credentials: 'include',
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `API Error: ${response.status}`);
  }
}
