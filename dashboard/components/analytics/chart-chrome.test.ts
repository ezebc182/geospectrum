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

  it('el borde del tooltip tampoco queda fijo dentro de un string CSS', () => {
    for (const archivo of PANELES) {
      // `border: '1px solid #374151'` esquiva el patrón de atributo suelto.
      expect(fuente(archivo), `${archivo} tiene un borde de tooltip fijo`).not.toMatch(
        /solid\s+#[0-9a-fA-F]{3,8}/,
      );
    }
  });
});
