/**
 * La leyenda de magnitud y el chip del evento son dos dibujos del mismo dato.
 * Si sus cortes se separan, el mismo sismo queda "leve" en la barra y "micro"
 * en el chip — que es exactamente el bug del 2026-08-22, donde un M3.9 salía
 * amarillo en el globo y verde en la lista.
 *
 * Estos tests atan las dos escalas: no verifican que `tramoDe` devuelva tal
 * cosa (eso es repetir la implementación), sino que devuelva LO MISMO que
 * `getMagnitudeSeverity` para cada magnitud.
 */

import { describe, expect, it } from 'vitest';
import { tramoDe, type MagnitudeBand } from './MagnitudeScale';
import { getMagnitudeSeverity } from '@/lib/utils';

/**
 * Los dos vocabularios nombran los mismos cinco tramos con palabras distintas
 * (la barra habla de "fuerza percibida", el chip de "severidad"). Esta tabla
 * ES el contrato entre ambos: si se agrega un tramo a una escala y no a la
 * otra, la equivalencia deja de ser total y los tests de abajo se caen.
 */
const EQUIVALENCIA: Record<MagnitudeBand, ReturnType<typeof getMagnitudeSeverity>> = {
  minor: 'low',
  light: 'light',
  moderate: 'moderate',
  strong: 'high',
  major: 'critical',
};

describe('MagnitudeScale — cortes compartidos con la severidad', () => {
  it('coincide con getMagnitudeSeverity en los bordes de cada tramo', () => {
    // Los bordes son donde vive el bug: 3.9 vs 4, no 3.5.
    const bordes = [2, 2.9, 3, 3.9, 4, 4.9, 5, 5.9, 6, 7.9, 8, 9.5];

    for (const mag of bordes) {
      expect(EQUIVALENCIA[tramoDe(mag)], `M${mag}`).toBe(getMagnitudeSeverity(mag));
    }
  });

  it('coincide en todo el rango dibujado, no sólo en los bordes elegidos', () => {
    // Barrido de M0 a M10 de a 0.1: si alguien mueve un corte medio grado,
    // esta prueba lo encuentra aunque no esté en la lista de bordes.
    for (let decimas = 0; decimas <= 100; decimas++) {
      const mag = decimas / 10;
      expect(EQUIVALENCIA[tramoDe(mag)], `M${mag.toFixed(1)}`).toBe(getMagnitudeSeverity(mag));
    }
  });

  it('cubre los cinco tramos — la equivalencia no deja ninguno afuera', () => {
    const alcanzados = new Set([2, 3.5, 4.5, 5.5, 7].map((mag) => tramoDe(mag)));
    expect(alcanzados).toEqual(new Set<MagnitudeBand>(Object.keys(EQUIVALENCIA) as MagnitudeBand[]));
  });
});
