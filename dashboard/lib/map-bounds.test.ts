import { describe, expect, it } from 'vitest';
import { countEventsInBounds, type BoundsLike } from './map-bounds';
import type { SeismicEvent } from './types';

function makeEvento(id: string, lat: number, lon: number): SeismicEvent {
  return {
    id,
    fuentes: ['usgs'],
    hora_utc: '2026-07-13T00:00:00Z',
    lat,
    lon,
    prof_km: 10,
    mag: 4.5,
    mag_tipo: 'mb',
    lugar: null,
    sentido: false,
    revisado: true,
  };
}

/** Bounds rectangular simple compatible con BoundsLike, sin depender de Leaflet real. */
function makeBounds(minLat: number, maxLat: number, minLon: number, maxLon: number): BoundsLike {
  return {
    contains: ([lat, lon]: [number, number]) =>
      lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon,
  };
}

describe('countEventsInBounds', () => {
  it('cuenta 0 eventos visibles cuando ninguno cae dentro de los bounds', () => {
    const eventos = [makeEvento('a', -40, -70), makeEvento('b', -41, -71)];
    const bounds = makeBounds(0, 10, 0, 10);
    expect(countEventsInBounds(eventos, bounds)).toEqual({ visible: 0, total: 2 });
  });

  it('cuenta todos los eventos visibles cuando todos caen dentro de los bounds', () => {
    const eventos = [makeEvento('a', -34, -58), makeEvento('b', -33, -70)];
    const bounds = makeBounds(-40, -30, -75, -55);
    expect(countEventsInBounds(eventos, bounds)).toEqual({ visible: 2, total: 2 });
  });

  it('cuenta un subconjunto parcial de eventos visibles', () => {
    const eventos = [makeEvento('a', -34, -58), makeEvento('b', 10, 10), makeEvento('c', -33, -70)];
    const bounds = makeBounds(-40, -30, -75, -55);
    expect(countEventsInBounds(eventos, bounds)).toEqual({ visible: 2, total: 3 });
  });

  it('retorna {visible: 0, total: 0} sin división por cero cuando no hay eventos', () => {
    const bounds = makeBounds(-40, -30, -75, -55);
    expect(countEventsInBounds([], bounds)).toEqual({ visible: 0, total: 0 });
  });
});
