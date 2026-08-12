/**
 * E2E mínimo del onboarding (tarea 8.5 de email-invitations) — cubre el
 * riesgo "tour acoplado a la UI" del proposal contra la UI REAL.
 *
 * CÓMO CORRERLO (requiere el stack local vivo):
 *
 *   1. TimescaleDB del proyecto (¡puerto 5433, NO 5432 — en 5432 hay un
 *      Postgres nativo de macOS ajeno al proyecto!):
 *        docker compose -f deploy/docker/docker-compose.yml --profile storage up -d timescaledb
 *   2. Backend (bind IPv4, desde la raíz del repo):
 *        venv/bin/uvicorn src.main:app --host 127.0.0.1 --port 8000
 *   3. E2E (desde dashboard/; el `next dev -p 3008` lo levanta Playwright
 *      solo vía webServer si no está corriendo):
 *        npx playwright test
 *
 * Estrategia de sesión: el login de la UI es SOLO Google (commit 3203e89),
 * así que no se puede loguear por formulario. En su lugar el test FIRMA una
 * cookie `session` legítima con la misma AUTH_SECRET_KEY compartida entre
 * backend y dashboard (leída de dashboard/.env.local) para un usuario de
 * prueba insertado por SQL — exactamente lo que emitiría el backend tras un
 * login real. El usuario se crea con `onboarding_completed_at = NULL` (el
 * estado de un invitado recién registrado) y se borra al final.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import { SignJWT } from 'jose';

// OJO: nada de dominios .local/.test acá — el EmailStr de Pydantic en
// CurrentUser rechaza TLDs reservados y el backend respondería 401 en
// /auth/me con la cookie forjada (bug real encontrado al correr este test).
const E2E_EMAIL = 'e2e-onboarding@example.com';
const TOUR_ANCHOR_IDS = ['map', 'nav-globe', 'area-selector', 'alerts-bell'] as const;

/** Ejecuta SQL dentro del contenedor timescaledb (sin depender de un psql
 * del host, que en esta máquina apunta al Postgres nativo de 5432). */
function sql(query: string): string {
  return execFileSync(
    'docker',
    ['exec', 'timescaledb', 'psql', '-U', 'seismic', '-d', 'seismic', '-tAc', query],
    { encoding: 'utf8' },
  ).trim();
}

/** AUTH_SECRET_KEY desde dashboard/.env.local (mismo valor que usa el
 * backend) — sin imprimirla nunca. */
function readAuthSecret(): string {
  const envFile = readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  const match = envFile.match(/^AUTH_SECRET_KEY=(.+)$/m);
  const secret = match?.[1]?.trim() ?? process.env.AUTH_SECRET_KEY;
  if (!secret) {
    throw new Error('AUTH_SECRET_KEY no encontrada en dashboard/.env.local ni en el entorno');
  }
  return secret;
}

async function signSessionCookie(userId: string): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: userId,
    email: E2E_EMAIL,
    role: 'viewer',
    name: null,
    avatar_url: null,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 3600)
    .sign(new TextEncoder().encode(readAuthSecret()));
}

let userId: string;

test.beforeAll(() => {
  // Usuario de prueba con onboarding pendiente — el estado exacto de un
  // invitado recién dado de alta. Idempotente: si quedó de una corrida
  // anterior, se resetea el onboarding a NULL.
  // psql agrega el command tag ("INSERT 0 1") tras el RETURNING: la primera
  // línea es el id.
  userId = sql(
    `INSERT INTO users (email, password_hash, role, onboarding_completed_at)
     VALUES ('${E2E_EMAIL}', 'e2e-not-a-real-hash', 'viewer', NULL)
     ON CONFLICT (email) DO UPDATE SET onboarding_completed_at = NULL
     RETURNING id;`,
  ).split('\n')[0].trim();
  expect(userId).toMatch(/^[0-9a-f-]{36}$/);
});

test.afterAll(() => {
  sql(`DELETE FROM users WHERE email = '${E2E_EMAIL}';`);
});

test('primer login dispara el wizard, las anclas del tour existen, y saltar persiste', async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: 'session',
      value: await signSessionCookie(userId),
      url: 'http://localhost:3008',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);

  // --- Escenario "Primer login dispara el tour" -------------------------
  await page.goto('/');
  const wizard = page.getByRole('dialog');
  await expect(wizard).toBeVisible({ timeout: 15_000 });
  await expect(wizard.getByText('¡Bienvenido a GeoSpectrum!')).toBeVisible();

  // --- Las 4 anclas data-tour-id del tour existen en la página real -----
  // (attached, no visible: el overlay del Dialog está encima, pero lo que
  // el tour necesita es que los selectores resuelvan a elementos reales)
  for (const anchorId of TOUR_ANCHOR_IDS) {
    await expect(
      page.locator(`[data-tour-id="${anchorId}"]`),
      `ancla data-tour-id="${anchorId}" ausente — el tour quedaría sin ese paso`,
    ).toBeAttached({ timeout: 15_000 });
  }

  // --- Escenario "Saltar el tour también persiste" ----------------------
  const persisted = page.waitForResponse(
    (response) =>
      response.url().includes('/auth/me/onboarding-complete') && response.status() === 204,
    { timeout: 10_000 },
  );
  await wizard.getByRole('button', { name: 'Saltar' }).click();
  await expect(wizard).toBeHidden();
  await persisted;

  // La persistencia es server-side de verdad (no un flag de sesión local)
  const completedAt = sql(
    `SELECT onboarding_completed_at FROM users WHERE email = '${E2E_EMAIL}';`,
  );
  expect(completedAt).not.toBe('');

  // --- Al recargar, el wizard NO reaparece ------------------------------
  await page.reload();
  // Ancla del layout visible = la home terminó de montar (y con ella el
  // OnboardingGate ya corrió su getMe())
  await expect(page.locator('[data-tour-id="map"]')).toBeAttached({ timeout: 15_000 });
  await expect(page.getByText('¡Bienvenido a GeoSpectrum!')).toHaveCount(0);
});
