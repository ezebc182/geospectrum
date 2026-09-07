/**
 * Corte de profundidad de /analytics (analytics-professional-panels, 5.9).
 *
 * Lo que se PROTEGE: un evento sin profundidad NO puede entrar al corte con un
 * 0 inventado —sería la misma mentira que M14 evita en el mapa—, y tampoco
 * puede desaparecer en silencio: se cuenta y el panel lo dice.
 */

import { describe, expect, it } from 'vitest';

import { toDepthSectionPoints } from './depth-section';
import type { SeismicEvent } from './types';

function evento(over: Partial<SeismicEvent> = {}): SeismicEvent {
  return {
    id: 'ev',
    fuentes: ['USGS'],
    hora_utc: '2026-09-06T12:00:00Z',
    lat: -33,
    lon: -70,
    prof_km: 50,
    mag: 4.2,
    mag_tipo: 'mb',
    lugar: 'Lugar',
    sentido: false,
    revisado: true,
    ...over,
  };
}

describe('toDepthSectionPoints', () => {
  it('omite los eventos sin profundidad y los cuenta', () => {
    const { points, omitted } = toDepthSectionPoints([
      evento({ id: 'a', prof_km: 10 }),
      evento({ id: 'b', prof_km: null }),
      evento({ id: 'c', prof_km: 200 }),
    ]);

    expect(points).toHaveLength(2);
    expect(points.map((p) => p.id)).toEqual(['a', 'c']);
    expect(omitted).toBe(1);
  });

  it('una profundidad no finita cuenta como sin profundidad, no como 0', () => {
    const { points, omitted } = toDepthSectionPoints([
      evento({ id: 'nan', prof_km: Number.NaN }),
    ]);

    expect(points).toHaveLength(0);
    expect(omitted).toBe(1);
    // Falsabilidad: si se colara con `?? 0` habría un punto en profundidad 0.
    expect(points.some((p) => p.depthKm === 0)).toBe(false);
  });

  it('conserva magnitud, profundidad y color de magnitud de cada punto', () => {
    const { points } = toDepthSectionPoints([evento({ id: 'a', mag: 6.1, prof_km: 33 })]);

    expect(points[0]).toMatchObject({ id: 'a', mag: 6.1, depthKm: 33, color: '#dc2626' });
  });

  it('una profundidad NEGATIVA es un dato real y entra al corte', () => {
    // Observado en prod: EMSC/USGS reportan hipocentros sobre el nivel del mar.
    const { points, omitted } = toDepthSectionPoints([evento({ id: 'neg', prof_km: -35 })]);

    expect(omitted).toBe(0);
    expect(points[0].depthKm).toBe(-35);
  });

  it('lista vacía ⇒ sin puntos y sin omitidos', () => {
    expect(toDepthSectionPoints([])).toEqual({ points: [], omitted: 0 });
  });
});
