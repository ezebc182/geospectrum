/**
 * Verificación de la cookie de sesión (`session`) compartida entre el
 * middleware (Edge) y las API routes de Next (Node).
 *
 * Este helper existía duplicado dentro de `dashboard/middleware.ts`: la
 * route `app/api/invitations/send/route.ts` necesita exactamente la misma
 * verificación PERO además el claim `role` (el middleware solo respondía
 * sí/no). Extraerlo evita que las dos copias diverjan — si mañana el backend
 * cambia el algoritmo o el nombre de la cookie, se toca un solo lugar.
 *
 * `jose` (no `jsonwebtoken`) porque es la librería edge-compatible: usa Web
 * Crypto, disponible tanto en el Edge runtime del middleware como en Node.
 * Firma el mismo HS256 que el backend (ver src/services/auth_service.py,
 * JWT_ALGORITHM).
 *
 * AUTH_SECRET_KEY debe ser EXACTAMENTE el mismo valor que
 * settings.auth_secret_key en el backend — si no coinciden, todo token
 * emitido por la API es rechazado acá. Se lee como env server-side (sin
 * prefijo NEXT_PUBLIC_ — nunca debe llegar al bundle del cliente).
 */

import { jwtVerify } from 'jose';

import type { UserRole } from './types';

export const SESSION_COOKIE_NAME = 'session';

/**
 * Payload de la cookie `session` (sesión COMPLETA), tal como lo emite
 * `AuthService.create_access_token(pending_2fa=False)`. `name` y
 * `avatar_url` son claims opcionales (null en usuarios de password).
 *
 * El JWT de pre-auth de 2FA (`{pending_2fa: true, typ: "pre_auth"}`) viaja
 * en OTRA cookie (`pending_2fa_session`) y NO tiene claim `role` — por eso
 * `verifySession()` lo rechaza explícitamente abajo: un token de pre-auth
 * nunca debe contar como sesión.
 */
export interface SessionPayload {
  sub: string;
  email: string;
  role: UserRole;
  name: string | null;
  avatar_url: string | null;
  iat: number;
  exp: number;
}

const VALID_ROLES: readonly string[] = ['superadmin', 'admin', 'moderador', 'viewer'];

/**
 * Verifica un JWT de sesión y devuelve su payload tipado.
 *
 * Retorna `null` (nunca lanza) en TODOS los casos de "no hay sesión válida":
 * token ausente, firma inválida, token expirado, `AUTH_SECRET_KEY` sin
 * configurar, o payload sin la forma esperada (p. ej. un token de pre-auth
 * 2FA). El caller decide qué hacer con ese null — el middleware redirige a
 * /login, la API route responde 401 JSON.
 */
export async function verifySession(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;

  const secret = process.env.AUTH_SECRET_KEY;
  if (!secret) {
    // Configuración de servidor faltante, no una condición de sesión
    // inválida del cliente — mismo criterio que el fail-fast del backend
    // (src/main.py lifespan(): AUTH_SECRET_KEY ausente es un error de
    // arranque, no un 401). Acá no podemos abortar el proceso Next.js, así
    // que se trata como "sin sesión válida" y se loguea para que no pase
    // desapercibido en desarrollo.
    console.error(
      '[verify-session] AUTH_SECRET_KEY no está configurada — todas las rutas protegidas van a redirigir a /login hasta que se configure.'
    );
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
    });

    // La firma válida garantiza que el token lo emitió el backend, no que
    // sea el token que esperamos: un pre-auth de 2FA está igual de bien
    // firmado y no trae `role`. Se valida la forma antes de tipar.
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
      return null;
    }
    if (typeof payload.role !== 'string' || !VALID_ROLES.includes(payload.role)) {
      return null;
    }

    return {
      sub: payload.sub,
      email: payload.email,
      role: payload.role as UserRole,
      name: typeof payload.name === 'string' ? payload.name : null,
      avatar_url: typeof payload.avatar_url === 'string' ? payload.avatar_url : null,
      iat: typeof payload.iat === 'number' ? payload.iat : 0,
      exp: typeof payload.exp === 'number' ? payload.exp : 0,
    };
  } catch {
    // Firma inválida o token expirado: mismo resultado que el backend
    // (401 en /auth/me) — acá simplemente no hay sesión válida.
    return null;
  }
}
