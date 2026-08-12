import path from 'path';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // Los specs de e2e/ son de Playwright (otro runner, requieren el stack
    // vivo): sin esta exclusión `vitest run` intentaría ejecutarlos y
    // fallaría al importar '@playwright/test'.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
