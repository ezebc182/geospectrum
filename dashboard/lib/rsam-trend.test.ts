import { describe, expect, it } from 'vitest';
import type { RsamResponse } from './api';
import { MAX_SIGNAL_WINDOW_HOURS, mergeSeriesByTime, signalWindowFromHours, type SettledSeries } from './rsam-trend';

// Tres instantes, con el formato REAL de /rsam (6 decimales).
const T0 = '2026-09-06T20:05:00.000000Z';
const T1 = '2026-09-06T20:15:00.000000Z';
const T2 = '2026-09-06T20:25:00.000000Z';
const T0_MS = Date.UTC(2026, 8, 6, 20, 5);
const T1_MS = Date.UTC(2026, 8, 6, 20, 15);
const T2_MS = Date.UTC(2026, 8, 6, 20, 25);

function response(channel: string, samples: { t: string; value: number }[]): RsamResponse {
  return {
    channel,
    sampling_rate: 20,
    period_seconds: 600,
    starttime: T0,
    endtime: T2,
    samples,
  };
}

function fulfilled(channel: string, samples: { t: string; value: number }[]): SettledSeries {
  return { channel, result: { status: 'fulfilled', value: response(channel, samples) } };
}

function rejected(channel: string, reason: unknown): SettledSeries {
  return { channel, result: { status: 'rejected', reason } };
}

const A = fulfilled('A', [
  { t: T0, value: 10 },
  { t: T1, value: 20 },
  { t: T2, value: 30 },
]);

describe('mergeSeriesByTime', () => {
  it('dos canales alineados ⇒ 3 filas completas, la primera {t: t0, A: 10, B: 1}', () => {
    const B = fulfilled('B', [
      { t: T0, value: 1 },
      { t: T1, value: 2 },
      { t: T2, value: 3 },
    ]);
    const merged = mergeSeriesByTime([A, B]);
    expect(merged.rows).toHaveLength(3);
    expect(merged.rows[0]).toEqual({ t: T0_MS, A: 10, B: 1 });
    expect(merged.rows[2]).toEqual({ t: T2_MS, A: 30, B: 3 });
    expect(merged.channels).toEqual(['A', 'B']);
    expect(merged.errors).toEqual({});
  });

  it('B sin t1 ⇒ siguen siendo 3 filas y B es null (no 0) en t1', () => {
    const B = fulfilled('B', [
      { t: T0, value: 1 },
      { t: T2, value: 3 },
    ]);
    const merged = mergeSeriesByTime([A, B]);
    expect(merged.rows).toHaveLength(3);
    expect(merged.rows[1].t).toBe(T1_MS);
    expect(merged.rows[1].A).toBe(20);
    expect(merged.rows[1].B).toBeNull();
    expect(merged.rows[1].B).not.toBe(0);
  });

  it('un canal rechazado ⇒ sus claves ausentes de las filas y errors[B] con la razón', () => {
    const merged = mergeSeriesByTime([A, rejected('B', new Error('API Error: 404 Not Found'))]);
    expect(merged.rows).toHaveLength(3);
    for (const row of merged.rows) expect('B' in row).toBe(false);
    expect(merged.channels).toEqual(['A']);
    expect(merged.errors).toEqual({ B: 'API Error: 404 Not Found' });
  });

  it('una razón que no es Error se convierte a string', () => {
    const merged = mergeSeriesByTime([rejected('C', 'timeout')]);
    expect(merged.errors).toEqual({ C: 'timeout' });
    expect(merged.rows).toEqual([]);
  });

  it('las filas quedan ordenadas por t aunque un canal venga desordenado', () => {
    const B = fulfilled('B', [
      { t: T2, value: 3 },
      { t: T0, value: 1 },
    ]);
    const merged = mergeSeriesByTime([B, A]);
    expect(merged.rows.map((r) => r.t)).toEqual([T0_MS, T1_MS, T2_MS]);
  });

  it('el mismo instante con formato distinto (Z vs +00:00) es UNA sola fila', () => {
    const B = fulfilled('B', [{ t: '2026-09-06T20:05:00+00:00', value: 1 }]);
    const merged = mergeSeriesByTime([A, B]);
    expect(merged.rows).toHaveLength(3);
    expect(merged.rows[0]).toEqual({ t: T0_MS, A: 10, B: 1 });
  });

  it('un value no finito viaja como null; un t imparseable se descarta', () => {
    const B = fulfilled('B', [
      { t: T0, value: NaN },
      { t: 'bogus', value: 5 },
    ]);
    const merged = mergeSeriesByTime([B]);
    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0].B).toBeNull();
  });

  it('entrada vacía ⇒ sin filas, sin canales, sin errores', () => {
    expect(mergeSeriesByTime([])).toEqual({ rows: [], channels: [], errors: {} });
  });
});

describe('signalWindowFromHours', () => {
  const NOW = Date.UTC(2026, 8, 6, 22, 0, 0);

  it('devuelve start/end ISO UTC con end − start === h·3600·1000 y end === now', () => {
    const window = signalWindowFromHours(6, NOW);
    expect(window.end).toBe('2026-09-06T22:00:00.000Z');
    expect(window.start).toBe('2026-09-06T16:00:00.000Z');
    expect(Date.parse(window.end) - Date.parse(window.start)).toBe(6 * 3600 * 1000);
    expect(window.endMs - window.startMs).toBe(6 * 3600 * 1000);
    expect(window.endMs).toBe(NOW);
  });

  it('24 h es el tope permitido', () => {
    expect(MAX_SIGNAL_WINDOW_HOURS).toBe(24);
    const window = signalWindowFromHours(24, NOW);
    expect(window.endMs - window.startMs).toBe(24 * 3600 * 1000);
  });

  it('h > 24 lanza (el tope de FDSN, nunca se pide más)', () => {
    expect(() => signalWindowFromHours(25, NOW)).toThrow();
  });

  it('h <= 0 o no finito lanza', () => {
    expect(() => signalWindowFromHours(0, NOW)).toThrow();
    expect(() => signalWindowFromHours(NaN, NOW)).toThrow();
  });
});
