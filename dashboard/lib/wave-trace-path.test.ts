/**
 * Regresión del QA 2.19: una selección corta entra en modo passthrough
 * (min === max por par) y el dibujo de segmentos verticales aislados
 * renderizaba CERO píxeles — lienzo en blanco con la señal presente.
 *
 * El contrato del polyline: los vértices se encadenan (un solo path), así la
 * conexión entre pares consecutivos dibuja la onda aunque cada par sea
 * degenerado.
 */

import { describe, expect, it } from 'vitest';

import { buildTracePolyline } from './wave-trace-path';

describe('buildTracePolyline', () => {
  it('en passthrough (min === max) el polyline recorre las muestras conectadas', () => {
    // El caso EXACTO del bug: la respuesta de prod traía mins idénticos a maxs.
    const vertices = buildTracePolyline([389.9, 828.9, -332.1], [389.9, 828.9, -332.1]);

    // Un vértice por muestra, en orden: la conexión entre índices consecutivos
    // con valores distintos es un segmento VISIBLE — antes no existía ninguno.
    expect(vertices).toEqual([
      { pair: 0, value: 389.9 },
      { pair: 1, value: 828.9 },
      { pair: 2, value: -332.1 },
    ]);
  });

  it('en modo decimado conserva la barra vertical max→min de cada par', () => {
    const vertices = buildTracePolyline([-5, -1], [7, 3]);
    expect(vertices).toEqual([
      { pair: 0, value: 7 },
      { pair: 0, value: -5 },
      { pair: 1, value: 3 },
      { pair: 1, value: -1 },
    ]);
  });

  it('mezcla de pares degenerados y reales no corta el encadenado', () => {
    const vertices = buildTracePolyline([2, -4], [2, 6]);
    expect(vertices).toEqual([
      { pair: 0, value: 2 },
      { pair: 1, value: 6 },
      { pair: 1, value: -4 },
    ]);
  });

  it('sin pares devuelve un polyline vacío', () => {
    expect(buildTracePolyline([], [])).toEqual([]);
  });
});
