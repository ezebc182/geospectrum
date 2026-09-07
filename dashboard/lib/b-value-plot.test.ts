import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BValueNotEstimable, BValueOk, MagnitudeBin } from './analytics';
import {
  MAGNITUDE_BIN_WIDTH,
  fittedLinePoints,
  formatB,
  maxBinMagnitude,
  notEstimableMessageArgs,
  toFmdRows,
} from './b-value-plot';

/** Igual que en signal-picks.test.ts: leer el JSON acá, no copiar el número. */
const constantsFromJson = JSON.parse(
  readFileSync(resolve(__dirname, 'seismic-constants.json'), 'utf-8'),
) as { magnitudeBinWidth: number };

const BASE = {
  method: 'aki-utsu-mle' as const,
  n_total: 100,
  min_events: 50,
  mc_at_catalog_floor: false,
  bins: [] as MagnitudeBin[],
  mag_type_counts: {},
  window_start: '2026-08-07T12:00:00Z',
  window_end: '2026-09-06T12:00:00Z',
  area_slug: null,
};

describe('MAGNITUDE_BIN_WIDTH', () => {
  it('es la magnitudeBinWidth del JSON compartido, no una copia', () => {
    expect(MAGNITUDE_BIN_WIDTH).toBe(constantsFromJson.magnitudeBinWidth);
  });
});

describe('toFmdRows', () => {
  it('devuelve una fila por bin con log10 del acumulado', () => {
    const bins: MagnitudeBin[] = [
      { m: 2.0, count: 900, cumulative: 1000 },
      { m: 2.1, count: 90, cumulative: 100 },
      { m: 2.2, count: 10, cumulative: 10 },
    ];
    const rows = toFmdRows(bins);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ m: 2.0, count: 900, cumulative: 1000, log10Cumulative: 3 });
    expect(rows[2].log10Cumulative).toBe(1);
  });

  it('cumulative 0 ⇒ log10Cumulative null, NUNCA -Infinity', () => {
    const rows = toFmdRows([{ m: 5.0, count: 0, cumulative: 0 }]);
    expect(rows[0].log10Cumulative).toBeNull();
    expect(rows[0].log10Cumulative).not.toBe(-Infinity);
  });

  it('bins vacíos ⇒ []', () => {
    expect(toFmdRows([])).toEqual([]);
  });
});

describe('fittedLinePoints', () => {
  it('el primer punto es EXACTAMENTE (mc, a − b·mc) y el segundo está en maxM', () => {
    // a=6.0, b=1.0, mc=2.0: log10 N(2.0) = 4.0; en M=6.0 ⇒ 0.0
    const points = fittedLinePoints(6.0, 1.0, 2.0, 6.0);
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({ m: 2.0, log10N: 4.0 });
    expect(points[1]).toEqual({ m: 6.0, log10N: 0.0 });
  });

  it('con b=1.5 la pendiente cambia (no es una recta fija)', () => {
    const points = fittedLinePoints(8.0, 1.5, 2.0, 4.0);
    expect(points[0].log10N).toBeCloseTo(5.0, 12);
    expect(points[1].log10N).toBeCloseTo(2.0, 12);
  });

  it('maxM <= mc ⇒ el segundo punto queda un bin a la derecha (nunca longitud cero)', () => {
    const points = fittedLinePoints(6.0, 1.0, 3.0, 3.0);
    expect(points[0].m).toBe(3.0);
    expect(points[1].m).toBeCloseTo(3.0 + MAGNITUDE_BIN_WIDTH, 12);
  });

  it('un parámetro no finito ⇒ [] (nada que dibujar, sin NaN)', () => {
    expect(fittedLinePoints(NaN, 1.0, 2.0, 6.0)).toEqual([]);
    expect(fittedLinePoints(6.0, 1.0, Infinity, 6.0)).toEqual([]);
  });
});

describe('maxBinMagnitude', () => {
  it('es el m del último bin (los bins vienen ordenados)', () => {
    expect(
      maxBinMagnitude([
        { m: 2.0, count: 1, cumulative: 2 },
        { m: 4.5, count: 1, cumulative: 1 },
      ]),
    ).toBe(4.5);
  });

  it('bins vacíos ⇒ null', () => {
    expect(maxBinMagnitude([])).toBeNull();
  });
});

describe('notEstimableMessageArgs', () => {
  it('insufficient ⇒ {kind, n: n_above_mc, min: min_events}', () => {
    const result: BValueNotEstimable = { ...BASE, status: 'insufficient', n_above_mc: 23, mc: 2.0 };
    expect(notEstimableMessageArgs(result)).toEqual({ kind: 'insufficient', n: 23, min: 50 });
  });

  it('degenerate conserva su kind (mensaje distinto al de insuficiente)', () => {
    const result: BValueNotEstimable = { ...BASE, status: 'degenerate', n_above_mc: 60, mc: 3.0 };
    expect(notEstimableMessageArgs(result)).toEqual({ kind: 'degenerate', n: 60, min: 50 });
  });

  it('status ok ⇒ null (no hay mensaje que mostrar)', () => {
    const result: BValueOk = { ...BASE, status: 'ok', n_above_mc: 5295, mc: 1.8, b: 1, a: 5, sigma_b: 0.01 };
    expect(notEstimableMessageArgs(result)).toBeNull();
  });
});

describe('formatB', () => {
  it('0.9963 ± 0.0047 ⇒ "1.00" y "0.00" (dos decimales, Decisión 8)', () => {
    expect(formatB(0.9963, 0.0047)).toEqual({ b: '1.00', sigma: '0.00' });
  });

  it('1.4853 ± 0.125 ⇒ "1.49" y "0.13"', () => {
    expect(formatB(1.4853, 0.125)).toEqual({ b: '1.49', sigma: '0.13' });
  });

  it('un valor no finito ⇒ null (nunca "NaN")', () => {
    expect(formatB(NaN, 0.01)).toBeNull();
    expect(formatB(1.0, Infinity)).toBeNull();
  });
});
