import { describe, expect, it } from 'vitest';

import {
  eventsToPoints,
  globePointId,
  magnitudeColor,
  plateBoundariesToPaths,
  pointRadius,
  ringColorInterpolator,
  ringMaxRadius,
  ringRepeatPeriod,
} from './globe-data';
import type { SeismicEvent } from '@/lib/types';

// Strings traducidos que el componente pasa por parametro (Decision 5 de
// i18n-dashboard): en los tests se fijan literales para poder assertar.
const LABELS = { unknownLocation: 'sin ubicación' };

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

describe('pointRadius', () => {
  it('crece con la magnitud', () => {
    // Mismo criterio que el circleMarker del mapa 2D: la magnitud se compara
    // por tamaño del disco, ya no por altura de barra.
    expect(pointRadius(6)).toBeGreaterThan(pointRadius(4));
    expect(pointRadius(4)).toBeGreaterThan(pointRadius(2));
  });

  it('mantiene clickeable un evento de magnitud cero', () => {
    // Sin piso, un M0 sería un disco de radio 0: invisible e imposible de
    // clickear, y el evento parecería no estar en el globo.
    expect(pointRadius(0)).toBeGreaterThanOrEqual(0.15);
  });

  it('no deja que un M9 tape a sus vecinos', () => {
    // En un enjambre las réplicas caen alrededor del principal: un disco sin
    // techo se come los puntos de al lado y no se pueden seleccionar.
    expect(pointRadius(9)).toBeLessThanOrEqual(0.7);
    expect(pointRadius(12)).toBeLessThanOrEqual(0.7);
  });
});

describe('ringMaxRadius', () => {
  it('crece con la magnitud', () => {
    expect(ringMaxRadius(7)).toBeGreaterThan(ringMaxRadius(5));
    expect(ringMaxRadius(5)).toBeGreaterThan(ringMaxRadius(3));
  });

  it('siempre supera al disco para que el pulso se note', () => {
    // Un anillo que muere dentro del disco no se ve nunca: el pulso tiene que
    // salir del punto, en toda magnitud.
    for (const mag of [0, 3, 5, 7, 9]) {
      expect(ringMaxRadius(mag)).toBeGreaterThan(pointRadius(mag));
    }
  });

  it('tiene techo para no envolver el globo', () => {
    // Un pulso de M9 sin techo cruza medio hemisferio y se lee como un
    // artefacto de render, no como un indicador.
    expect(ringMaxRadius(9)).toBeLessThanOrEqual(8);
    expect(ringMaxRadius(12)).toBeLessThanOrEqual(8);
  });
});

describe('ringRepeatPeriod', () => {
  it('pulsa más seguido cuanto mayor la magnitud', () => {
    // La frecuencia es jerarquía visual: un M7 tiene que llamar la atención
    // antes que un M3, igual que el color.
    expect(ringRepeatPeriod(7)).toBeLessThan(ringRepeatPeriod(3));
  });

  it('no baja del piso que vuelve frenético al pulso', () => {
    expect(ringRepeatPeriod(9)).toBeGreaterThanOrEqual(1200);
    expect(ringRepeatPeriod(12)).toBeGreaterThanOrEqual(1200);
  });

  it('no supera el techo que hace parecer muerto al indicador', () => {
    // Con períodos muy largos el anillo desaparece varios segundos y el punto
    // parece estático: el usuario no descubre que la capa existe.
    expect(ringRepeatPeriod(0)).toBeLessThanOrEqual(4000);
  });
});

describe('ringColorInterpolator', () => {
  it('parte del color del evento y se desvanece al expandirse', () => {
    const interpolate = ringColorInterpolator('#dc2626');

    // t=0 es el anillo naciendo en el epicentro; t=1, muriendo en el radio
    // máximo. El formato #rrggbbaa mantiene el color base y sólo baja el alfa.
    expect(interpolate(0)).toBe('#dc2626ff');
    expect(interpolate(1)).toBe('#dc262600');
  });

  it('interpola el alfa de forma monótona', () => {
    const interpolate = ringColorInterpolator('#22c55e');
    const alphaAt = (t: number) => parseInt(interpolate(t).slice(7), 16);

    expect(alphaAt(0.25)).toBeGreaterThan(alphaAt(0.5));
    expect(alphaAt(0.5)).toBeGreaterThan(alphaAt(0.75));
  });
});

describe('globePointId', () => {
  it('usa el id del evento cuando viene', () => {
    expect(globePointId(makeEvent({ id: 'usgs-abc123' }))).toBe('usgs-abc123');
  });

  it('distingue eventos sin id por coordenadas y hora', () => {
    const sinId = { id: undefined as unknown as string };

    expect(globePointId(makeEvent({ ...sinId, lat: 10, lon: 20 }))).not.toBe(
      globePointId(makeEvent({ ...sinId, lat: 30, lon: 40 })),
    );
  });

  it('distingue dos eventos en el mismo lugar a distinta hora', () => {
    // Una réplica cae casi en el mismo punto que el sismo principal: sin la
    // hora en la clave, las dos se pisarían y una desaparecería del globo.
    const sinId = { id: undefined as unknown as string, lat: -33.4, lon: -70.6 };

    expect(globePointId(makeEvent({ ...sinId, hora_utc: '2026-08-01T00:00:00Z' }))).not.toBe(
      globePointId(makeEvent({ ...sinId, hora_utc: '2026-08-01T00:05:00Z' })),
    );
  });

  it('coincide con el id que eventsToPoints le pone al punto', () => {
    // Este es el contrato que hace clickeable un punto: el componente mapea el
    // punto clickeado de vuelta al evento reconstruyendo esta misma clave. Si
    // las dos implementaciones divergen, el click deja de responder en algunos
    // eventos y no hay error que lo delate.
    const eventos = [
      makeEvent({ id: 'con-id' }),
      makeEvent({ id: undefined as unknown as string, lat: 12.5, lon: -80.25 }),
    ];

    expect(eventsToPoints(eventos, LABELS).map((p) => p.id)).toEqual(eventos.map(globePointId));
  });
});

describe('eventsToPoints', () => {
  it('conserva las coordenadas del evento', () => {
    const [point] = eventsToPoints([makeEvent({ lat: -33.4, lon: -70.6 })], LABELS);

    expect(point.lat).toBe(-33.4);
    expect(point.lng).toBe(-70.6);
  });

  it('descarta eventos sin coordenadas numéricas', () => {
    // Un NaN en globe.gl no se ve como un punto faltante: se dibuja como un
    // artefacto en el centro de la Tierra.
    const points = eventsToPoints(
      [
        makeEvent({ id: 'ok' }),
        makeEvent({ id: 'sin-lat', lat: null as unknown as number }),
        makeEvent({ id: 'lon-invalida', lon: 'x' as unknown as number }),
        makeEvent({ id: 'nan', lat: NaN }),
        makeEvent({ id: 'sin-lon', lon: undefined as unknown as number }),
      ],
      LABELS,
    );

    expect(points.map((p) => p.id)).toEqual(['ok']);
  });

  it('no confunde una coordenada vacía con el punto (0,0)', () => {
    // Number(null), Number('') y Number([]) valen 0, no NaN. Sin un guard
    // explícito estos eventos se dibujan en el Golfo de Guinea: agua, así que
    // el punto se ve plausible y el error pasa desapercibido.
    const points = eventsToPoints(
      [
        makeEvent({ id: 'lat-null', lat: null as unknown as number }),
        makeEvent({ id: 'lon-vacia', lon: '' as unknown as number }),
        makeEvent({ id: 'lat-array', lat: [] as unknown as number }),
      ],
      LABELS,
    );

    expect(points).toEqual([]);
  });

  it('conserva el (0,0) real cuando las coordenadas son números', () => {
    // El guard descarta valores vacíos, no el origen: un evento en lat 0 /
    // lon 0 es raro pero legítimo y tiene que dibujarse.
    const [point] = eventsToPoints([makeEvent({ id: 'origen', lat: 0, lon: 0 })], LABELS);

    expect(point.id).toBe('origen');
    expect(point.lat).toBe(0);
    expect(point.lng).toBe(0);
  });

  it('trata la magnitud faltante como cero en vez de descartar el evento', () => {
    // Un sismo sin magnitud sigue siendo un sismo con ubicación: se muestra.
    const [point] = eventsToPoints([makeEvent({ mag: null as unknown as number })], LABELS);

    expect(point.magnitude).toBe(0);
    expect(point.color).toBe(magnitudeColor(0));
  });

  it('arma la etiqueta con magnitud y lugar', () => {
    const [point] = eventsToPoints([makeEvent({ mag: 5.24, lugar: 'Valparaíso' })], LABELS);

    expect(point.label).toBe('M5.2 — Valparaíso');
  });

  it('no deja la etiqueta a medias cuando falta el lugar', () => {
    const [point] = eventsToPoints([makeEvent({ lugar: null })], LABELS);

    expect(point.label).toBe('M5.2 — sin ubicación');
  });

  it('usa el string traducido recibido por parámetro, no uno propio', () => {
    // Decision 5: la lib no conoce el idioma — el fallback del label viene del
    // componente ya traducido. Si la lib clavara su propio texto, el globo
    // mostraría español residual con la UI en inglés.
    const [point] = eventsToPoints(
      [makeEvent({ lugar: null })],
      { unknownLocation: 'unknown location' },
    );

    expect(point.label).toBe('M5.2 — unknown location');
  });

  it('genera un id de respaldo cuando el evento no lo trae', () => {
    // globe.gl usa el id para reconciliar puntos entre renders: dos undefined
    // se pisan y el segundo evento desaparece del globo.
    const points = eventsToPoints(
      [
        makeEvent({ id: undefined as unknown as string, lat: 10, lon: 20 }),
        makeEvent({ id: undefined as unknown as string, lat: 30, lon: 40 }),
      ],
      LABELS,
    );

    expect(points[0].id).not.toBe(points[1].id);
  });

  it('devuelve una lista vacía sin eventos', () => {
    expect(eventsToPoints([], LABELS)).toEqual([]);
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
