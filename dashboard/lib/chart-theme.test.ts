/**
 * Cromo tematizado de los gráficos (analytics-professional-panels, Fase 5).
 *
 * Lo que se protege acá es el CONTRATO: el cromo sale de tokens HSL de
 * `globals.css` y NO de hex fijos. Un hex fijo es exactamente el bug que
 * reportó el usuario (gris medio sobre casi-negro en oscuro), así que el test
 * falla si alguien vuelve a meter un `#...`.
 *
 * Además se verifica que cada token referenciado EXISTE en `:root` y en
 * `.dark`: un `var()` inexistente cae al fallback en silencio y el gráfico se
 * vería "casi bien" sin que nadie se entere.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CHART_AXIS_STROKE,
  CHART_GRID_STROKE,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
} from './chart-theme';

const CSS = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');

/** Tokens `--x` referenciados por una cadena `hsl(var(--x))`. */
function tokensDe(...valores: string[]): string[] {
  return valores.flatMap((v) => [...v.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]));
}

const TODOS = tokensDe(
  CHART_GRID_STROKE,
  CHART_AXIS_STROKE,
  ...Object.values(CHART_TOOLTIP_CONTENT_STYLE),
  ...Object.values(CHART_TOOLTIP_LABEL_STYLE),
);

describe('chart-theme', () => {
  it('el cromo no lleva NINGUN color hex fijo', () => {
    const todos = [
      CHART_GRID_STROKE,
      CHART_AXIS_STROKE,
      ...Object.values(CHART_TOOLTIP_CONTENT_STYLE),
      ...Object.values(CHART_TOOLTIP_LABEL_STYLE),
    ];

    for (const valor of todos) {
      expect(valor, `${valor} es un hex fijo, no se adapta al tema`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });

  it('grilla, ejes y tooltip salen de tokens hsl(var(--...))', () => {
    expect(CHART_GRID_STROKE).toMatch(/^hsl\(var\(--[a-z-]+\)\)$/);
    expect(CHART_AXIS_STROKE).toMatch(/^hsl\(var\(--[a-z-]+\)\)$/);
    expect(CHART_TOOLTIP_CONTENT_STYLE.backgroundColor).toMatch(/^hsl\(var\(--[a-z-]+\)\)$/);
    expect(CHART_TOOLTIP_CONTENT_STYLE.color).toMatch(/^hsl\(var\(--[a-z-]+\)\)$/);
  });

  it('los ticks usan un token de TEXTO, no el de borde', () => {
    // `--border` es separador: no llega a 4.5:1 y los ticks son texto.
    expect(CHART_AXIS_STROKE).toBe('hsl(var(--muted-foreground))');
  });

  it('cada token referenciado existe en :root Y en .dark', () => {
    expect(TODOS.length).toBeGreaterThan(0);

    for (const token of new Set(TODOS)) {
      const definiciones = [...CSS.matchAll(new RegExp(`^\\s*${token}:`, 'gm'))];
      expect(definiciones.length, `${token} deberia estar definido en :root y en .dark`).toBe(2);
    }
  });
});
