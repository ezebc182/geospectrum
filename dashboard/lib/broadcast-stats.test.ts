import { describe, it, expect } from 'vitest';
import {
  computeBroadcastStats,
  latestEvents,
  isFreshEvent,
  formatUtcClock,
  parseRegion,
  topRegions,
  hourlyBuckets,
  minutesSinceMag,
} from './broadcast-stats';
import type { SeismicEvent } from './types';

function makeEvento(overrides: Partial<SeismicEvent> = {}): SeismicEvent {
  return {
    id: 'ev-1',
    fuentes: ['USGS'],
    hora_utc: '2026-08-20T12:00:00+00:00',
    lat: -31.5,
    lon: -68.5,
    prof_km: 10,
    mag: 4.2,
    mag_tipo: 'ML',
    lugar: '43 km SE de San Juan, Argentina',
    sentido: false,
    revisado: false,
    ...overrides,
  };
}

const NOW = new Date('2026-08-20T13:00:00Z');

describe('computeBroadcastStats', () => {
  it('sin eventos devuelve todo en cero', () => {
    expect(computeBroadcastStats([], NOW)).toEqual({ last24h: 0, todayM5: 0, todayM6: 0 });
  });

  it('cuenta las últimas 24h con corte exacto', () => {
    const eventos = [
      makeEvento({ id: 'a', hora_utc: '2026-08-20T12:59:00+00:00' }),
      makeEvento({ id: 'b', hora_utc: '2026-08-19T13:00:01+00:00' }), // justo adentro
      makeEvento({ id: 'c', hora_utc: '2026-08-19T12:59:59+00:00' }), // justo afuera
    ];
    expect(computeBroadcastStats(eventos, NOW).last24h).toBe(2);
  });

  it('todayM5/M6 cuentan solo el día UTC en curso, no la ventana de 24h', () => {
    const eventos = [
      // Ayer a la noche (dentro de las 24h, fuera de "hoy"): no cuenta para today*
      makeEvento({ id: 'a', mag: 6.5, hora_utc: '2026-08-19T22:00:00+00:00' }),
      // Hoy: M5.1 y M6.2
      makeEvento({ id: 'b', mag: 5.1, hora_utc: '2026-08-20T02:00:00+00:00' }),
      makeEvento({ id: 'c', mag: 6.2, hora_utc: '2026-08-20T08:30:00+00:00' }),
      // Hoy pero débil
      makeEvento({ id: 'd', mag: 4.9, hora_utc: '2026-08-20T09:00:00+00:00' }),
    ];
    const stats = computeBroadcastStats(eventos, NOW);
    expect(stats.last24h).toBe(4);
    expect(stats.todayM5).toBe(2); // el M6.2 también es >=5
    expect(stats.todayM6).toBe(1);
  });

  it('ignora eventos con hora futura respecto de now (relojes desincronizados)', () => {
    const eventos = [makeEvento({ hora_utc: '2026-08-20T13:05:00+00:00' })];
    expect(computeBroadcastStats(eventos, NOW).last24h).toBe(0);
  });
});

describe('latestEvents', () => {
  it('ordena del más nuevo al más viejo y recorta a n', () => {
    const eventos = [
      makeEvento({ id: 'viejo', hora_utc: '2026-08-20T01:00:00+00:00' }),
      makeEvento({ id: 'nuevo', hora_utc: '2026-08-20T12:00:00+00:00' }),
      makeEvento({ id: 'medio', hora_utc: '2026-08-20T06:00:00+00:00' }),
    ];
    expect(latestEvents(eventos, 2).map((e) => e.id)).toEqual(['nuevo', 'medio']);
  });

  it('no muta el array original', () => {
    const eventos = [
      makeEvento({ id: 'a', hora_utc: '2026-08-20T01:00:00+00:00' }),
      makeEvento({ id: 'b', hora_utc: '2026-08-20T12:00:00+00:00' }),
    ];
    latestEvents(eventos, 2);
    expect(eventos[0].id).toBe('a');
  });
});

describe('isFreshEvent', () => {
  it('true dentro de la ventana, false fuera y false en el futuro', () => {
    expect(isFreshEvent(makeEvento({ hora_utc: '2026-08-20T12:50:00+00:00' }), NOW, 15)).toBe(true);
    expect(isFreshEvent(makeEvento({ hora_utc: '2026-08-20T12:40:00+00:00' }), NOW, 15)).toBe(false);
    expect(isFreshEvent(makeEvento({ hora_utc: '2026-08-20T13:10:00+00:00' }), NOW, 15)).toBe(false);
  });
});

describe('parseRegion', () => {
  it('toma lo que sigue a la última coma (formato USGS)', () => {
    expect(parseRegion('153 km N of Waingapu, Indonesia')).toBe('Indonesia');
    expect(parseRegion('5 km S of San José del Palmar, Colombia')).toBe('Colombia');
  });

  it('sin coma usa el string entero (formato EMSC)', () => {
    expect(parseRegion('GREENLAND SEA')).toBe('GREENLAND SEA');
  });

  it('null o vacío devuelven null', () => {
    expect(parseRegion(null)).toBeNull();
    expect(parseRegion('algo,  ')).toBeNull();
  });
});

describe('topRegions', () => {
  it('agrupa sin distinguir mayúsculas y ordena por cantidad', () => {
    const eventos = [
      makeEvento({ id: 'a', lugar: '10 km N of X, Chile' }),
      makeEvento({ id: 'b', lugar: 'OFF COAST, CHILE' }),
      makeEvento({ id: 'c', lugar: '5 km S of Y, Indonesia' }),
    ];
    expect(topRegions(eventos, 5)).toEqual([
      { region: 'Chile', count: 2 },
      { region: 'Indonesia', count: 1 },
    ]);
  });
});

describe('hourlyBuckets', () => {
  it('pone cada evento en su hora, con la más nueva a la derecha', () => {
    const eventos = [
      makeEvento({ id: 'a', hora_utc: '2026-08-20T12:30:00+00:00' }), // hace 30 min
      makeEvento({ id: 'b', mag: 5.5, hora_utc: '2026-08-20T10:30:00+00:00' }), // hace 2.5 h
      makeEvento({ id: 'c', hora_utc: '2026-08-19T12:00:00+00:00' }), // hace 25 h: afuera
    ];
    const buckets = hourlyBuckets(eventos, NOW);
    expect(buckets).toHaveLength(24);
    expect(buckets[23]).toEqual({ count: 1, hasM5: false });
    expect(buckets[21]).toEqual({ count: 1, hasM5: true });
    expect(buckets.reduce((s, b) => s + b.count, 0)).toBe(2);
  });
});

describe('minutesSinceMag', () => {
  it('mide desde el último evento que supera el umbral', () => {
    const eventos = [
      makeEvento({ id: 'a', mag: 5.2, hora_utc: '2026-08-20T10:00:00+00:00' }),
      makeEvento({ id: 'b', mag: 4.0, hora_utc: '2026-08-20T12:30:00+00:00' }),
    ];
    expect(minutesSinceMag(eventos, NOW, 5)).toBe(180);
    expect(minutesSinceMag(eventos, NOW, 6)).toBeNull();
  });
});

describe('formatUtcClock', () => {
  it('formatea la hora en UTC sin importar el huso local', () => {
    expect(formatUtcClock('2026-08-20T12:33:17+00:00')).toBe('12:33:17 UTC');
    expect(formatUtcClock('2026-08-20T12:33:17-03:00')).toBe('15:33:17 UTC');
  });
});
