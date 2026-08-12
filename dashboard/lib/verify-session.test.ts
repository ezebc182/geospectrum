// @vitest-environment node
/**
 * Tests de `verifySession()` (tarea 8.1 de email-invitations).
 *
 * Cubren el contrato que la route `/api/invitations/send` y el middleware
 * necesitan: payload tipado con `role` cuando el token es legítimo, y `null`
 * — nunca una excepción — en todos los caminos de "no hay sesión válida".
 * La distinción de roles es la base de la decisión 401 vs 403 de la route.
 */

import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { verifySession } from './verify-session';

const SECRET = 'vitest-secret-compartido-con-el-backend';

interface SignOptions {
  secret?: string;
  /** Epoch en segundos; por defecto expira en una hora. */
  expiresAt?: number;
}

/** Firma un JWT HS256 igual que `create_access_token()` del backend. */
async function signToken(
  claims: Record<string, unknown>,
  { secret = SECRET, expiresAt }: SignOptions = {},
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expiresAt ?? nowSeconds + 3600)
    .sign(new TextEncoder().encode(secret));
}

const BASE_CLAIMS = {
  sub: '3f2f8f10-0000-4000-8000-000000000001',
  email: 'admin@example.com',
  role: 'admin',
  name: 'Admin de Prueba',
  avatar_url: null,
};

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET_KEY', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('verifySession', () => {
  it('token firmado válido devuelve el payload tipado con rol', async () => {
    const token = await signToken(BASE_CLAIMS);

    const session = await verifySession(token);

    expect(session).not.toBeNull();
    expect(session?.sub).toBe(BASE_CLAIMS.sub);
    expect(session?.email).toBe('admin@example.com');
    expect(session?.role).toBe('admin');
    expect(session?.name).toBe('Admin de Prueba');
    // avatar_url null en el claim se normaliza a null (no undefined)
    expect(session?.avatar_url).toBeNull();
  });

  it('distingue los roles admin / superadmin / viewer / moderador', async () => {
    // La route de envío decide 403 en base a este claim: si verifySession
    // aplanara o inventara roles, un viewer podría mandar emails.
    for (const role of ['superadmin', 'admin', 'moderador', 'viewer'] as const) {
      const token = await signToken({ ...BASE_CLAIMS, role });
      const session = await verifySession(token);
      expect(session?.role).toBe(role);
    }
  });

  it('firma inválida (otro secreto) devuelve null', async () => {
    const token = await signToken(BASE_CLAIMS, { secret: 'otro-secreto-distinto' });

    expect(await verifySession(token)).toBeNull();
  });

  it('token expirado devuelve null', async () => {
    const token = await signToken(BASE_CLAIMS, {
      expiresAt: Math.floor(Date.now() / 1000) - 3600,
    });

    expect(await verifySession(token)).toBeNull();
  });

  it('token ausente (cookie no enviada) devuelve null', async () => {
    expect(await verifySession(undefined)).toBeNull();
    expect(await verifySession('')).toBeNull();
  });

  it('token bien firmado pero sin claim role (pre-auth 2FA) devuelve null', async () => {
    // Un JWT de pre-auth 2FA está igual de bien firmado por el backend pero
    // NO es una sesión completa: sin `role` no debe contar como sesión.
    const token = await signToken({ sub: BASE_CLAIMS.sub, pending_2fa: true, typ: 'pre_auth' });

    expect(await verifySession(token)).toBeNull();
  });

  it('rol fuera del enum devuelve null', async () => {
    const token = await signToken({ ...BASE_CLAIMS, role: 'root' });

    expect(await verifySession(token)).toBeNull();
  });

  it('sin AUTH_SECRET_KEY configurada devuelve null (y no explota)', async () => {
    vi.stubEnv('AUTH_SECRET_KEY', '');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = await signToken(BASE_CLAIMS);

    expect(await verifySession(token)).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
