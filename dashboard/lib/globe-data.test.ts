import { describe, expect, it } from 'vitest';

import {
  eventsToPoints,
  magnitudeColor,
  plateBoundariesToPaths,
  pointAltitude,
} from './globe-data';
import type { SeismicEvent } from '@/lib/types';

function makeEvent(overrides: Partial<SeismicEvent> = {}): SeismicEvent {
  return {
    id: 'evt-1',
    fuentes: ['USGS'],
    hora_utc: '2026-08-01T00:00:00Z',
    lat: -33.4,
    lon: -70.6,
    prof_km: 35,
    mag: 5.2,
    mag_tipo: 'mww',
    lugar: 'Santiago, Chile',
    sentido: false,
    revisado: true,
    ...overrides,
  };
}

describe('magnitudeColor', () => {
  it('asigna un color por tramo de magnitud', () => {
    expect(magnitudeColor(2.1)).toBe('#22c55e');
    expect(magnitudeColor(3.5)).toBe('#eab308');
    expect(magnitudeColor(4.7)).toBe('#f59e0b');
    expect(magnitudeColor(5.9)).toBe('#ea580c');
    expect(magnitudeColor(7.1)).toBe('#dc2626');
  });

  it('incluye el borde inferior de cada tramo', () => {
    // Los límites son los que se ven mal en la práctica: un M5.0 tiene que
    // leerse "fuerte", no "moderado", igual que en la tabla de eventos.
    expect(magnitudeColor(3)).toBe('#eab308');
    expect(magnitudeColor(4)).toBe('#f59e0b');
    expect(magnitudeColor(5)).toBe('#ea580c');
    expect(magnitudeColor(6)).toBe('#dc2626');
  });
});

describe('pointAltitude', () => {
  it('crece con la magnitud', () => {
    expect(pointAltitude(6)).toBeGreaterThan(pointAltitude(4));
    expect(pointAltitude(4)).toBeGreaterThan(pointAltitude(2));
  });

  it('nunca supera el techo de 0.35', () => {
    // Sin techo, un M9 queda tan alto que se lee como desprendido de la
    // superficie y deja de verse dónde ocurrió.
    expect(pointAltitude(9)).toBeLessThanOrEqual(0.35);
    expect(pointAltitude(12)).toBeLessThanOrEqual(0.35);
  });

  it('mantiene visible un evento de magnitud cero', () => {
    // El piso de 0.01 existe para que un M0 no quede enterrado en la esfera:
    // altura 0 en globe.gl es un punto que no se ve.
    expect(pointAltitude(0)).toBeGreaterThan(0);
  });
});

describe('eventsToPoints', () => {
  it('conserva las coordenadas del evento', () => {
    const [point] = eventsToPoints([makeEvent({ lat: -33.4, lon: -70.6 })]);

    expect(point.lat).toBe(-33.4);
    expect(point.lng).toBe(-70.6);
  });

  it('descarta eventos sin coordenadas numéricas', () => {
    // Un NaN en globe.gl no se ve como un punto faltante: se dibuja como un
    // artefacto en el centro de la Tierra.
    const points = eventsToPoints([
      makeEvent({ id: 'ok' }),
      makeEvent({ id: 'sin-lat', lat: null as unknown as number }),
      makeEvent({ id: 'lon-invalida', lon: 'x' as unknown as number }),
      makeEvent({ id: 'nan', lat: NaN }),
      makeEvent({ id: 'sin-lon', lon: undefined as unknown as number }),
    ]);

    expect(points.map((p) => p.id)).toEqual(['ok']);
  });

  it('no confunde una coordenada vacía con el punto (0,0)', () => {
    // Number(null), Number('') y Number([]) valen 0, no NaN. Sin un guard
    // explícito estos eventos se dibujan en el Golfo de Guinea: agua, así que
    // el punto se ve plausible y el error pasa desapercibido.
    const points = eventsToPoints([
      makeEvent({ id: 'lat-null', lat: null as unknown as number }),
      makeEvent({ id: 'lon-vacia', lon: '' as unknown as number }),
      makeEvent({ id: 'lat-array', lat: [] as unknown as number }),
    ]);

    expect(points).toEqual([]);
  });

  it('conserva el (0,0) real cuando las coordenadas son números', () => {
    // El guard descarta valores vacíos, no el origen: un evento en lat 0 /
    // lon 0 es raro pero legítimo y tiene que dibujarse.
    const [point] = eventsToPoints([makeEvent({ id: 'origen', lat: 0, lon: 0 })]);

    expect(point.id).toBe('origen');
    expect(point.lat).toBe(0);
    expect(point.lng).toBe(0);
  });

  it('trata la magnitud faltante como cero en vez de descartar el evento', () => {
    // Un sismo sin magnitud sigue siendo un sismo con ubicación: se muestra.
    const [point] = eventsToPoints([makeEvent({ mag: null as unknown as number })]);

    expect(point.magnitude).toBe(0);
    expect(point.color).toBe(magnitudeColor(0));
  });

  it('arma la etiqueta con magnitud y lugar', () => {
    const [point] = eventsToPoints([makeEvent({ mag: 5.24, lugar: 'Valparaíso' })]);

    expect(point.label).toBe('M5.2 — Valparaíso');
  });

  it('no deja la etiqueta a medias cuando falta el lugar', () => {
    const [point] = eventsToPoints([makeEvent({ lugar: null })]);

    expect(point.label).toBe('M5.2 — sin ubicación');
  });

  it('genera un id de respaldo cuando el evento no lo trae', () => {
    // globe.gl usa el id para reconciliar puntos entre renders: dos undefined
    // se pisan y el segundo evento desaparece del globo.
    const points = eventsToPoints([
      makeEvent({ id: undefined as unknown as string, lat: 10, lon: 20 }),
      makeEvent({ id: undefined as unknown as string, lat: 30, lon: 40 }),
    ]);

    expect(points[0].id).not.toBe(points[1].id);
  });

  it('devuelve una lista vacía sin eventos', () => {
    expect(eventsToPoints([])).toEqual([]);
  });
});

describe('plateBoundariesToPaths', () => {
  it('invierte [lon,lat] de GeoJSON a [lat,lng] de globe.gl', () => {
    // Esta es LA trampa del módulo: equivocarse no tira error, dibuja un mapa
    // espejado que parece plausible. El punto GeoJSON [-70.6, -33.4] es
    // Santiago; leído al revés cae en el Océano Índico.
    const paths = plateBoundariesToPaths({
      features: [
        {
          geometry: {
            type: 'LineString',
            coordinates: [
              [-70.6, -33.4],
              [-71.0, -34.0],
            ],
          },
        },
      ],
    });

    expect(paths[0].coords[0]).toEqual([-33.4, -70.6]);
    expect(paths[0].coords[1]).toEqual([-34.0, -71.0]);
  });

  it('separa un MultiLineString en un path por línea', () => {
    const paths = plateBoundariesToPaths({
      features: [
        {
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [0, 0],
                [1, 1],
              ],
              [
                [10, 10],
                [11, 11],
              ],
            ],
          },
        },
      ],
    });

    expect(paths).toHaveLength(2);
    expect(paths[0].coords).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(paths[1].coords).toEqual([
      [10, 10],
      [11, 11],
    ]);
  });

  it('ignora las geometrías que no son líneas', () => {
    // El dataset de placas es de líneas, pero un Polygon suelto no debe
    // colarse como un path con coordenadas de más.
    const paths = plateBoundariesToPaths({
      features: [
        { geometry: { type: 'Point', coordinates: [0, 0] } },
        {
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
        },
      ],
    });

    expect(paths).toEqual([]);
  });

  it('descarta las líneas que quedan con menos de dos puntos', () => {
    // Un path de un solo punto no dibuja nada y ensucia la capa.
    const paths = plateBoundariesToPaths({
      features: [
        {
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [null, 5],
              ['x', 'y'],
            ],
          },
        },
      ],
    });

    expect(paths).toEqual([]);
  });

  it('filtra los vértices inválidos pero conserva la línea', () => {
    const paths = plateBoundariesToPaths({
      features: [
        {
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [null, 5],
              [2, 2],
              [3, 3],
            ],
          },
        },
      ],
    });

    expect(paths[0].coords).toEqual([
      [0, 0],
      [2, 2],
      [3, 3],
    ]);
  });

  it('aplica el color recibido a cada path', () => {
    const paths = plateBoundariesToPaths(
      {
        features: [
          {
            geometry: {
              type: 'LineString',
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
          },
        ],
      },
      '#ff0000',
    );

    expect(paths[0].color).toBe('#ff0000');
  });

  it('no explota con un GeoJSON malformado', () => {
    // El fetch de placas puede devolver un 404 con cuerpo HTML: el globo tiene
    // que seguir mostrando los eventos, que es el dato que importa.
    expect(plateBoundariesToPaths(null)).toEqual([]);
    expect(plateBoundariesToPaths(undefined)).toEqual([]);
    expect(plateBoundariesToPaths({})).toEqual([]);
    expect(plateBoundariesToPaths({ features: 'no soy un array' })).toEqual([]);
    expect(plateBoundariesToPaths({ features: [{}, { geometry: null }] })).toEqual([]);
  });
});
