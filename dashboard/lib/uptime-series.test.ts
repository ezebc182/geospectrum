import { describe, expect, it } from 'vitest';
import type { StationUptimeResponse, UptimeBucket } from './analytics';
import { percentLabel, rankStations, stationTimeline } from './uptime-series';

function bucket(overrides: Partial<UptimeBucket>): UptimeBucket {
  return {
    bucket_start: '2026-09-05T12:00:00Z',
    columns_count: 900,
    observed_hours: 1,
    expected: 900,
    ratio: 1.0,
    in_progress: false,
    ...overrides,
  };
}

const RESPONSE: StationUptimeResponse = {
  bucket: 'hour',
  window_start: '2026-09-05T12:00:00Z',
  window_end: '2026-09-05T16:00:00Z',
  expected_columns_per_hour: 900,
  stations: {
    'GE.KBU..BHZ': [
      bucket({ bucket_start: '2026-09-05T12:00:00Z', ratio: 1.0 }),
      bucket({ bucket_start: '2026-09-05T13:00:00Z', columns_count: 0, ratio: 0.0 }),
      bucket({ bucket_start: '2026-09-05T14:00:00Z', columns_count: 0, observed_hours: 0, expected: 0, ratio: null }),
      bucket({ bucket_start: '2026-09-05T15:00:00Z', columns_count: 450, ratio: 0.5, in_progress: true }),
    ],
  },
  overall: { 'GE.KBU..BHZ': 0.5 },
};

describe('rankStations', () => {
  it('ordena peor primero y deja los null al final: {A:0.9,B:0.3,C:null,D:0.6} ⇒ B, D, A, C', () => {
    const ranked = rankStations({ A: 0.9, B: 0.3, C: null, D: 0.6 });
    expect(ranked.map((r) => r.channel)).toEqual(['B', 'D', 'A', 'C']);
    expect(ranked[3]).toEqual({ channel: 'C', ratio: null, kind: 'unobserved' });
    expect(ranked[0]).toEqual({ channel: 'B', ratio: 0.3, kind: 'observed' });
  });

  it('es estable: empates y varios null conservan el orden de entrada', () => {
    const ranked = rankStations({ X: 0.5, N1: null, Y: 0.5, N2: null, Z: 0.5 });
    expect(ranked.map((r) => r.channel)).toEqual(['X', 'Y', 'Z', 'N1', 'N2']);
  });

  it('0.0 es observado (peor que todo) y NO se confunde con null', () => {
    const ranked = rankStations({ A: 0.2, MUTE: 0.0, NOBODY: null });
    expect(ranked.map((r) => r.channel)).toEqual(['MUTE', 'A', 'NOBODY']);
    expect(ranked[0].ratio).toBe(0);
    expect(ranked[0].kind).toBe('observed');
    expect(ranked[2].ratio).toBeNull();
  });

  it('overall vacío ⇒ []', () => {
    expect(rankStations({})).toEqual([]);
  });
});

describe('stationTimeline', () => {
  it('una fila por bucket, con t en ms epoch y el ratio SIN convertir null en 0', () => {
    const rows = stationTimeline(RESPONSE, 'GE.KBU..BHZ');
    expect(rows).toHaveLength(4);
    expect(rows[0].t).toBe(Date.UTC(2026, 8, 5, 12));
    expect(rows[0].ratio).toBe(1.0);
    expect(rows[1].ratio).toBe(0.0);
    expect(rows[2].ratio).toBeNull();
    expect(rows[2].observedHours).toBe(0);
    expect(rows[2].expected).toBe(0);
    expect(rows[3].ratio).toBe(0.5);
    expect(rows[3].columnsCount).toBe(450);
  });

  it('marca inProgress SOLO en el bucket en curso', () => {
    const rows = stationTimeline(RESPONSE, 'GE.KBU..BHZ');
    expect(rows.map((r) => r.inProgress)).toEqual([false, false, false, true]);
  });

  it('las filas quedan ordenadas por t aunque la respuesta venga desordenada', () => {
    const shuffled: StationUptimeResponse = {
      ...RESPONSE,
      stations: { 'GE.KBU..BHZ': [...RESPONSE.stations['GE.KBU..BHZ']].reverse() },
    };
    const rows = stationTimeline(shuffled, 'GE.KBU..BHZ');
    expect(rows.map((r) => r.t)).toEqual([...rows.map((r) => r.t)].sort((a, b) => a - b));
    expect(rows[2].ratio).toBeNull();
  });

  it('canal ausente en stations ⇒ [] (no lanza, no inventa buckets)', () => {
    expect(stationTimeline(RESPONSE, 'XX.NOPE..BHZ')).toEqual([]);
  });

  it('un bucket_start imparseable se descarta en vez de producir t NaN', () => {
    const broken: StationUptimeResponse = {
      ...RESPONSE,
      stations: { 'GE.KBU..BHZ': [bucket({ bucket_start: 'bogus' }), bucket({ bucket_start: '2026-09-05T12:00:00Z' })] },
    };
    const rows = stationTimeline(broken, 'GE.KBU..BHZ');
    expect(rows).toHaveLength(1);
    expect(Number.isFinite(rows[0].t)).toBe(true);
  });
});

describe('percentLabel', () => {
  it('0 ⇒ "0 %" (se miró y no había nada)', () => {
    expect(percentLabel(0)).toBe('0 %');
  });

  it('null ⇒ null (el componente pone "sin observación"), nunca "0 %" ni "NaN %"', () => {
    expect(percentLabel(null)).toBeNull();
  });

  it('1 ⇒ "100 %", 0.5 ⇒ "50 %", 0.996 ⇒ "100 %" (redondeo entero)', () => {
    expect(percentLabel(1)).toBe('100 %');
    expect(percentLabel(0.5)).toBe('50 %');
    expect(percentLabel(0.996)).toBe('100 %');
  });

  it('NaN ⇒ null (no "NaN %")', () => {
    expect(percentLabel(NaN)).toBeNull();
  });
});
