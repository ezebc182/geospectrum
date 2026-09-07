/**
 * Contraste del cromo de los paneles de /analytics (Fase 5).
 *
 * El bug reportado: `MagnitudeTimeChart` — el molde que copiaron todos los
 * paneles nuevos — hardcodeaba `stroke="#374151"` (grilla) y `stroke="#9ca3af"`
 * (ejes). Son valores FIJOS: iguales en claro y en oscuro. En oscuro quedan
 * gris medio sobre casi-negro y no se leen.
 *
 * Este test mira el FUENTE de cada panel, no el render: las props de cromo se
 * pierden en los mocks de Recharts de los otros archivos (`XAxis: () => null`),
 * así que assertear el DOM no probaría nada. Lo que se prohíbe es la causa
 * raíz — un hex fijo en cualquier atributo de cromo — de modo que el test
 * falla ante CUALQUIER panel nuevo que vuelva a copiar el molde viejo.
 *
 * Los colores que CODIFICAN dato (magnitud, profundidad, series) quedan
 * fuera: esos son escala semántica, no cromo, y siguen siendo hex a propósito.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Paneles de la fase que dibujan ejes/grilla/tooltip. */
const PANELES = [
  'RsamTrendChart.tsx',
  'StationUptimeChart.tsx',
  'BValueChart.tsx',
  'TremorPanel.tsx',
  'DepthSectionChart.tsx',
];

/**
 * Atributos que son CROMO (chrome) y por lo tanto tienen que ser tematizados.
 * `fill` NO entra: en Cell/Bar/Scatter codifica dato.
 */
const CROMO_HEX = /(?:stroke|backgroundColor|borderColor|color)\s*[=:]\s*['"]#[0-9a-fA-F]{3,8}['"]/g;

function fuente(archivo: string): string {
  return readFileSync(join(__dirname, archivo), 'utf8');
}

describe('cromo de los paneles de analytics', () => {
  it.each(PANELES)('%s no hardcodea hex en grilla, ejes ni tooltip', (archivo) => {
    const encontrados = [...fuente(archivo).matchAll(CROMO_HEX)].map((m) => m[0]);

    expect(encontrados, `${archivo} usa cromo fijo que no se adapta al tema oscuro`).toEqual([]);
  });

  it.each(PANELES)('%s consume los tokens compartidos de chart-theme', (archivo) => {
    expect(fuente(archivo)).toMatch(/from '@\/lib\/chart-theme'/);
  });

  /**
   * Bug reportado con captura (modo oscuro): las FILAS del tooltip salían en
   * gris oscuro sobre panel oscuro mientras la etiqueta se leía bien.
   *
   * Recharts estila el tooltip por defecto en TRES tramos independientes:
   * `contentStyle` (contenedor), `labelStyle` (etiqueta) e `itemStyle` (cada
   * fila). El `color` de `contentStyle` no cascadea a las filas — a falta de
   * `itemStyle`, Recharts le pinta a cada fila el color de SU serie. Por eso
   * `contentStyle` solo no alcanza y hay que pasar las tres props.
   *
   * Los paneles con `content={...}` propio quedan fuera: ahí el markup es
   * nuestro y ya usa `text-popover-foreground` de Tailwind.
   */
  it.each(PANELES)('%s usa las tres props si estila el tooltip por defecto', (archivo) => {
    const src = fuente(archivo);
    if (!src.includes('contentStyle')) return; // tooltip con `content` propio

    expect(src, `${archivo} estila el contenedor del tooltip pero no la etiqueta`).toMatch(
      /labelStyle=\{CHART_TOOLTIP_LABEL_STYLE\}/,
    );
    expect(src, `${archivo} estila el contenedor del tooltip pero no las filas`).toMatch(
      /itemStyle=\{CHART_TOOLTIP_ITEM_STYLE\}/,
    );
  });

  /**
   * Un gris de Tailwind SIN pareja `dark:` es el mismo valor en los dos temas,
   * igual que un hex. Medido con la fórmula WCAG contra los tokens reales:
   * `text-gray-400` (#9ca3af) sobre `--popover` da 2,54:1 en claro — falla AA
   * (4,5:1) — aunque en oscuro dé 7,05:1.
   *
   * El par `text-gray-700 dark:text-gray-300` SÍ se adapta y queda fuera: lo
   * que se prohíbe es el gris huérfano, que es el que rompe en un tema.
   */
  it.each(PANELES)('%s no deja grises de Tailwind sin variante dark', (archivo) => {
    const GRIS = String.raw`text-(?:gray|slate|zinc|neutral|stone)-\d{2,3}`;
    // Solo dentro de listas de clases: un gris NOMBRADO en un comentario que
    // explica el arreglo no es un gris APLICADO, y si contara, el test no
    // podría satisfacerse nunca sin borrar su propia documentación.
    const huerfanos = [...fuente(archivo).matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/g)]
      .flatMap((m) => {
        const clases = m[1] ?? m[2] ?? m[3] ?? '';
        // La pareja `dark:` vive en el MISMO className.
        if (new RegExp(`dark:(?:${GRIS}|text-white)`).test(clases)) return [];
        return [...clases.matchAll(new RegExp(`(?<!dark:)\\b${GRIS}`, 'g'))].map((g) => g[0]);
      });

    expect(huerfanos, `${archivo} tiene un gris fijo sin variante para oscuro`).toEqual([]);
  });

  it('el borde del tooltip tampoco queda fijo dentro de un string CSS', () => {
    for (const archivo of PANELES) {
      // `border: '1px solid #374151'` esquiva el patrón de atributo suelto.
      expect(fuente(archivo), `${archivo} tiene un borde de tooltip fijo`).not.toMatch(
        /solid\s+#[0-9a-fA-F]{3,8}/,
      );
    }
  });
});
