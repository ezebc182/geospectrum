/**
 * Corte de profundidad de /analytics (analytics-professional-panels, 5.9).
 *
 * Lo que se PROTEGE: un evento sin profundidad NO puede entrar al corte con un
 * 0 inventado —sería la misma mentira que M14 evita en el mapa—, y tampoco
 * puede desaparecer en silencio: se cuenta y el panel lo dice.
 */

import { describe, expect, it } from 'vitest';

import { depthAxisDomain, formatDepthTick, toDepthSectionPoints } from './depth-section';
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

describe('depthAxisDomain', () => {
  it('con profundidades positivas el eje arranca en 0', () => {
    // La superficie es la referencia del corte: el eje no empieza en el
    // evento más superficial, empieza en 0.
    expect(depthAxisDomain([10, 105, 44])).toEqual([0, 105]);
  });

  it('un evento sobre el nivel del mar abre el eje hacia arriba', () => {
    expect(depthAxisDomain([-35, 20])).toEqual([-35, 20]);
  });

  it('sin puntos devuelve un rango degenerado pero usable', () => {
    expect(depthAxisDomain([])).toEqual([0, 1]);
  });

  it('todos a la misma profundidad no colapsa el eje', () => {
    // min === max dejaría el eje sin alto y el punto no se vería.
    const [min, max] = depthAxisDomain([50, 50]);
    expect(min).toBeLessThan(max);
  });
});

describe('formatDepthTick', () => {
  it('la profundidad se muestra positiva hacia abajo', () => {
    expect(formatDepthTick(105)).toBe('105');
    expect(formatDepthTick(0)).toBe('0');
  });

  it('una profundidad negativa CONSERVA el signo', () => {
    // Es un evento sobre el nivel del mar: mostrar "35" mentiría.
    expect(formatDepthTick(-35)).toBe('-35');
  });

  it('redondea los decimales que mete el algoritmo de ticks', () => {
    expect(formatDepthTick(33.333333)).toBe('33.3');
  });
});
