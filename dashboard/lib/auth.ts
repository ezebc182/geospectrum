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
  Invitation,
  InvitationLocale,
  InvitationValidation,
  InvitationWithToken,
  LoginResult,
  MeResponse,
  TotpSetupResponse,
  UserListItem,
  UserProfile,
  UserProfileUpdate,
  UserPublic,
  UserRole,
} from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

/**
 * Error con el status HTTP adjunto. Los helpers de invitaciones lo lanzan
 * en vez de un Error pelado porque la UI NECESITA distinguir códigos de la
 * matriz de design.md Decision 3 (403 escalación de rol, 409 duplicado,
 * 404/410 de validate, 410/422 de register) para mostrar el mensaje y la
 * recuperación correctos — un string no alcanza.
 */
export class ApiStatusError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiStatusError';
    this.status = status;
  }
}

/** Extrae el `{"error": "..."}` del shape de error estándar del backend,
 * con fallback si el body no es JSON o no trae el campo. */
async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : fallback;
}

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
 *
 * Lanza `ApiStatusError` (no un Error pelado) desde user-management: el
 * backend distingue 401 "credenciales inválidas" de 403 "cuenta
 * desactivada" (este último SOLO con password verificada, para no volver el
 * endpoint un oráculo de enumeración — design.md Decision 3), y la UI
 * necesita el status para mostrar copy distinto. El mensaje sigue siendo el
 * genérico del backend en el 401.
 */
export async function login(email: string, password: string): Promise<LoginResult> {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    throw new ApiStatusError(
      response.status,
      await readErrorMessage(response, 'invalid credentials'),
    );
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
export async function getMe(): Promise<MeResponse | null> {
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
 * Marca el onboarding como completado (204, idempotente en el backend: la
 * primera marca no se pisa). Lo llama el gate tanto al completar el tour como
 * al saltarlo. Lanza en fallo — pero el caller lo trata como best-effort: el
 * wizard se cierra IGUAL en la sesión actual (nunca bloqueante, a lo sumo
 * reaparece en el próximo login).
 */
export async function completeOnboarding(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/auth/me/onboarding-complete`, {
    method: 'POST',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`);
  }
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

// ============================================================================
// Invitaciones (email-invitations, Fase 6). El flujo de creación es en DOS
// pasos orquestados por la UI admin: (1) createInvitation() contra el backend
// devuelve el token en claro UNA sola vez; (2) sendInvitationEmail() contra la
// route de Next dispara el email. Todos lanzan ApiStatusError para que la UI
// distinga los códigos de la matriz de Decision 3 y muestre el resultado de
// cada paso por separado.
// ============================================================================

/**
 * Paso 1: crea la invitación en el backend (admin+). El `token` de la
 * respuesta es la única vez que el sistema entrega el claro — usarlo YA para
 * el paso 2 y no guardarlo. Errores: 403 (rol superior al propio), 409
 * (email con cuenta, o pendiente vigente duplicada — el mensaje del backend
 * distingue), 401 sin sesión.
 */
export async function createInvitation(
  email: string,
  role: UserRole,
  // Idioma del email de invitación (pulido post-rollout). Opcional con
  // default 'es' — mismo default que backend y migración 010 — para no
  // romper a los callers existentes.
  locale: InvitationLocale = 'es',
): Promise<InvitationWithToken> {
  const response = await fetch(`${API_BASE_URL}/auth/invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, role, locale }),
  });

  if (!response.ok) {
    throw new ApiStatusError(
      response.status,
      await readErrorMessage(response, 'no se pudo crear la invitación'),
    );
  }

  return response.json();
}

/** Listado admin+ con `status` derivado por el backend. */
export async function listInvitations(): Promise<Invitation[]> {
  const response = await fetch(`${API_BASE_URL}/auth/invitations`, {
    credentials: 'include',
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new ApiStatusError(
      response.status,
      await readErrorMessage(response, 'no se pudo listar las invitaciones'),
    );
  }

  return response.json();
}

/** Revoca una invitación (204). 409 si ya fue aceptada — revocar una
 * invitación consumida no des-crea al usuario, el backend la rechaza. */
export async function revokeInvitation(invitationId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/auth/invitations/${invitationId}`, {
    method: 'DELETE',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new ApiStatusError(
      response.status,
      await readErrorMessage(response, 'no se pudo revocar la invitación'),
    );
  }
}

/**
 * Reenvío: el backend regenera token + expiración (el link anterior queda
 * MUERTO) y resetea `email_sent_at`. El caller debe encadenar
 * `sendInvitationEmail()` con el token NUEVO. 409 si aceptada o revocada;
 * una expirada revive.
 */
export async function resendInvitation(invitationId: string): Promise<InvitationWithToken> {
  const response = await fetch(`${API_BASE_URL}/auth/invitations/${invitationId}/resend`, {
    method: 'POST',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new ApiStatusError(
      response.status,
      await readErrorMessage(response, 'no se pudo regenerar la invitación'),
    );
  }

  return response.json();
}

/**
 * Validación PÚBLICA del token (página /invite/[token], sin sesión — por
 * eso NO lleva `credentials`). NO consume la invitación. 404 = token
 * desconocido ("invitación no válida"); 410 = conocida pero expirada,
 * revocada o ya usada ("vencida — pedí un reenvío"). La página traduce
 * ambos códigos a mensajes distintos (design.md Decision 3).
 */
export async function validateInvitationToken(token: string): Promise<InvitationValidation> {
  const response = await fetch(
    `${API_BASE_URL}/auth/invitations/validate?token=${encodeURIComponent(token)}`,
    { cache: 'no-store' },
  );

  if (!response.ok) {
    throw new ApiStatusError(
      response.status,
      await readErrorMessage(response, 'invitación no válida'),
    );
  }

  return response.json();
}

/**
 * Registro por invitación (`POST /auth/register` con `invitation_token`).
 * No emite cookie de sesión (Decision 5) — tras el 201 el caller encadena
 * `login()` con las mismas credenciales. Errores de la matriz: 403 sin
 * invitación, 410 token inválido/expirado/consumido, 422 email distinto del
 * invitado, 409 email ya registrado.
 */
export async function registerWithInvitation(
  email: string,
  password: string,
  invitationToken: string,
): Promise<UserPublic> {
  const response = await fetch(`${API_BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, invitation_token: invitationToken }),
  });

  if (!response.ok) {
    throw new ApiStatusError(
      response.status,
      await readErrorMessage(response, 'no se pudo crear la cuenta'),
    );
  }

  return response.json();
}

// ============================================================================
// Gestión de usuarios (user-management, Fase 2). Los tres endpoints exigen
// rol admin+ en el backend (`require_min_role(ADMIN)`), que es la autoridad
// REAL de permisos — la UI deshabilitando botones es UX, no seguridad.
// Todos lanzan ApiStatusError porque la pantalla mapea copy por status:
// 403 jerarquía, 404 inexistente, 409 self o estado ya alcanzado
// (design.md § Interfaces / Contracts).
// ============================================================================

/** Listado completo de usuarios (admin+). Incluye superadmins y al propio
 * actor: la UI deshabilita las acciones que el backend rechazaría. */
export async function listUsers(): Promise<UserListItem[]> {
  const response = await fetch(`${API_BASE_URL}/auth/users`, {
    credentials: 'include',
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new ApiStatusError(
      response.status,
      await readErrorMessage(response, 'no se pudo listar los usuarios'),
    );
  }

  return response.json();
}

/**
 * Desactiva una cuenta (soft-delete, 204). Bloquea los tres caminos de
 * acceso: login por password, login por Google y las sesiones ya emitidas
 * (que mueren en el request siguiente). Errores: 409 auto-desactivación,
 * 404 inexistente, 403 rol igual o superior, 409 ya desactivada.
 */
export async function deactivateUser(userId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/auth/users/${userId}/deactivate`, {
    method: 'POST',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new ApiStatusError(
      response.status,
      await readErrorMessage(response, 'no se pudo desactivar la cuenta'),
    );
  }
}

/** Reactiva una cuenta desactivada (204). Misma matriz de errores que
 * `deactivateUser`, con 409 cuando la cuenta ya estaba activa. */
export async function reactivateUser(userId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/auth/users/${userId}/reactivate`, {
    method: 'POST',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new ApiStatusError(
      response.status,
      await readErrorMessage(response, 'no se pudo reactivar la cuenta'),
    );
  }
}

/** Input del paso 2 — exactamente lo que devolvió `createInvitation()` /
 * `resendInvitation()`, con los nombres que espera la route de Next. */
export interface SendInvitationEmailInput {
  invitationId: string;
  email: string;
  role: UserRole;
  token: string;
  expiresAt: string;
  /** Idioma del email — la route lo valida y cae a 'es' si falta. */
  locale?: InvitationLocale;
}

/**
 * Paso 2: dispara el email vía `POST /api/invitations/send` (route de Next,
 * mismo origen — la cookie `session` viaja sola). Un fallo acá NO rompe la
 * invitación del paso 1: queda `pending` con "email sin confirmar" y
 * "reenviar" como recuperación. Errores: 401/403 sesión o rol, 502 Resend.
 */
export async function sendInvitationEmail(input: SendInvitationEmailInput): Promise<void> {
  const response = await fetch('/api/invitations/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new ApiStatusError(
      response.status,
      await readErrorMessage(response, 'no se pudo enviar el email de invitación'),
    );
  }
}
