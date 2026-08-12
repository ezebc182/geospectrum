import { defineConfig, devices } from '@playwright/test';

/**
 * Config de Playwright para los E2E del dashboard (tarea 8.5 de
 * email-invitations). Mínima a propósito: un solo browser (chromium), sin
 * retries — los E2E de este repo son pocos y deterministas.
 *
 * PRERREQUISITO: el stack local tiene que estar vivo (ver el header de
 * e2e/onboarding.spec.ts): TimescaleDB en 5433 (docker) y el backend uvicorn
 * en 8000. El `next dev` en 3008 SÍ lo levanta Playwright solo (webServer),
 * reusando uno existente si ya está corriendo.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3008',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3008/login',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
