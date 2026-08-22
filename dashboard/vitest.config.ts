import path from 'path';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // Sube el techo de espera de testing-library: los mapas cargan Leaflet por
    // import() dinámico y bajo la carga de la suite completa no entran en el
    // default de 1000 ms. Ver vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
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
