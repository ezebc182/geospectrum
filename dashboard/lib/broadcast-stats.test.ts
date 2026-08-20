import { describe, it, expect } from 'vitest';
import { computeBroadcastStats } from './broadcast-stats';
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
