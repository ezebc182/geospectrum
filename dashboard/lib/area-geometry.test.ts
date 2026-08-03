import { describe, expect, it } from 'vitest';

import { areaGeometryWithWorldCopies } from './area-geometry';
import type { AreaGeometry } from './types';

// Cuadrado chico de 2x2 grados, fácil de seguir a ojo al desplazarlo.
const CUADRADO: AreaGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ],
  ],
};

describe('areaGeometryWithWorldCopies', () => {
  it('devuelve siempre un MultiPolygon, aun partiendo de un Polygon', () => {
    const out = areaGeometryWithWorldCopies(CUADRADO, -180, 180);
    expect(out.type).toBe('MultiPolygon');
  });

  it('incluye la copia original sin desplazar', () => {
    const out = areaGeometryWithWorldCopies(CUADRADO, -180, 180);
    expect(out.coordinates).toContainEqual(CUADRADO.coordinates);
  });

  it('replica el polígono a las copias que cubre el viewport', () => {
    // Un viewport de tres mundos de ancho necesita más de una copia, o al
    // panear al este el área desaparece.
    const out = areaGeometryWithWorldCopies(CUADRADO, -540, 540);
    expect(out.coordinates.length).toBeGreaterThan(1);
  });

  it('desplaza la longitud en múltiplos de 360 y deja la latitud intacta', () => {
    const out = areaGeometryWithWorldCopies(CUADRADO, -180, 180);
    for (const rings of out.coordinates) {
      for (const [lon, lat] of rings[0]) {
        expect(Math.abs(lon) % 360).toBeLessThanOrEqual(360);
        expect([-1, 1]).toContain(lat);
        // Toda copia es la original corrida un múltiplo exacto de 360.
        expect((lon + 1) % 360 === 0 || (lon - 1) % 360 === 0).toBe(true);
      }
    }
  });

  it('conserva la cantidad de anillos de cada polígono', () => {
    // Polígono con agujero: si se perdiera el segundo anillo, el área se
    // dibujaría maciza y taparía lo que debería estar excluido.
    const conAgujero: AreaGeometry = {
      type: 'Polygon',
      coordinates: [
        [[-2, -2], [2, -2], [2, 2], [-2, 2], [-2, -2]],
        [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]],
      ],
    };
    const out = areaGeometryWithWorldCopies(conAgujero, -180, 180);
    for (const rings of out.coordinates) {
      expect(rings).toHaveLength(2);
    }
  });

  it('acepta un MultiPolygon y replica todas sus partes', () => {
    // Los cinturones sísmicos se modelan como UNIÓN de rectángulos, así que el
    // MultiPolygon es el caso normal, no un borde raro.
    const multi: AreaGeometry = {
      type: 'MultiPolygon',
      coordinates: [
        [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]],
        [[[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]]],
      ],
    };
    const out = areaGeometryWithWorldCopies(multi, -180, 180);
    // Cada copia del mundo aporta las DOS partes del MultiPolygon.
    expect(out.coordinates.length % 2).toBe(0);
    expect(out.coordinates.length).toBeGreaterThanOrEqual(2);
  });

  it('no muta la geometría de entrada', () => {
    const original = JSON.parse(JSON.stringify(CUADRADO));
    areaGeometryWithWorldCopies(CUADRADO, -540, 540);
    expect(CUADRADO).toEqual(original);
  });
});
