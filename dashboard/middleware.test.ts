// @vitest-environment node
/**
 * Tests de la allowlist del middleware (tarea 8.2 de email-invitations).
 *
 * Se testea la FUNCIÓN `middleware()` directamente, no el `config.matcher`
 * (el matcher es config estática de Next — excluye `api`, `_next`, assets —
 * y no se puede ejecutar en unit tests; quedó verificado por lectura en el
 * fix post-Fase 5). Lo que importa acá es la regresión de la allowlist:
 * agregar `/invite` NO debe abrir ninguna ruta protegida.
 *
 * Cómo se distinguen los resultados de NextResponse en assertions:
 * - `NextResponse.next()`  → header `x-middleware-next: 1`
 * - `NextResponse.redirect(url)` → status 307 + header `location`
 * - `NextResponse.rewrite(url)`  → header `x-middleware-rewrite`
 */

import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { middleware } from './middleware';

const SECRET = 'vitest-secret-compartido-con-el-backend';

async function signSessionToken(): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: '3f2f8f10-0000-4000-8000-000000000001',
    email: 'admin@example.com',
    role: 'admin',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 3600)
    .sign(new TextEncoder().encode(SECRET));
}

function makeRequest(path: string, sessionCookie?: string): NextRequest {
  const headers = new Headers();
  if (sessionCookie !== undefined) {
    headers.set('cookie', `session=${sessionCookie}`);
  }
  return new NextRequest(`http://localhost:3008${path}`, { headers });
}

function isPassThrough(response: Response): boolean {
  return response.headers.get('x-middleware-next') === '1';
}

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET_KEY', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('middleware — allowlist de rutas públicas', () => {
  it('/invite/abc123 sin cookie pasa sin redirect (link del email usable)', async () => {
    const response = await middleware(makeRequest('/invite/abc123'));

    expect(isPassThrough(response)).toBe(true);
    expect(response.headers.get('location')).toBeNull();
  });

  it('/invite (raíz del prefijo) sin cookie también pasa', async () => {
    const response = await middleware(makeRequest('/invite'));

    expect(isPassThrough(response)).toBe(true);
  });

  it('/login sin cookie pasa (sin loop de redirección)', async () => {
    const response = await middleware(makeRequest('/login'));

    expect(isPassThrough(response)).toBe(true);
  });

  it('una ruta de (app) sin cookie redirige a /login', async () => {
    const response = await middleware(makeRequest('/globe'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3008/login');
  });

  it('una ruta de (app) con cookie de firma inválida redirige a /login', async () => {
    // Regresión: la allowlist no debe convertir un token trucho en sesión.
    const response = await middleware(makeRequest('/globe', 'token-trucho'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3008/login');
  });

  it('una ruta de (app) con cookie válida pasa', async () => {
    const token = await signSessionToken();

    const response = await middleware(makeRequest('/globe', token));

    expect(isPassThrough(response)).toBe(true);
    expect(response.headers.get('location')).toBeNull();
  });

  it('la raíz sin sesión hace rewrite a /landing (no redirect a /login)', async () => {
    // Comportamiento pre-existente de la landing pública: documentado acá
    // para que un cambio accidental de orden en el middleware lo delate.
    const response = await middleware(makeRequest('/'));

    expect(response.headers.get('x-middleware-rewrite')).toContain('/landing');
  });

  it('la raíz CON sesión válida pasa al dashboard (sin rewrite)', async () => {
    const token = await signSessionToken();

    const response = await middleware(makeRequest('/', token));

    expect(isPassThrough(response)).toBe(true);
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('rutas que empiezan parecido a /invite pero no son el prefijo NO pasan', async () => {
    // isPublicPath matchea por segmento (`/invite` o `/invite/...`), no por
    // startsWith pelado: /inviteX debe seguir protegida.
    const response = await middleware(makeRequest('/invitaciones-fake'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3008/login');
  });
});
