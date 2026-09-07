import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TremorEpisode, TremorResponse } from './analytics';
import {
  TREMOR_BASELINE_FACTOR,
  bandLabelKey,
  episodesToReferenceAreas,
  fiSignLabelKey,
  samplesToRows,
  thresholdLine,
} from './tremor-episodes';

const constantsFromJson = JSON.parse(
  readFileSync(resolve(__dirname, 'seismic-constants.json'), 'utf-8'),
) as { tremorBaselineFactor: number };

function episode(overrides: Partial<TremorEpisode>): TremorEpisode {
  return {
    start: '2026-09-06T03:25:00Z',
    end: '2026-09-06T04:05:00Z',
    samples: 5,
    duration_s: 3000,
    mean_ratio: 2.4,
    peak_rsam: 120,
    peak_ratio: 3.0,
    onset_ratio: 0.4,
    mean_dominant_hz: 1.5,
    mean_fi: -0.3,
    band: 'low',
    fi_sign: 'lp_like',
    ...overrides,
  };
}

const RESPONSE: TremorResponse = {
  channel: 'GE.KBU..BHZ',
  sampling_rate: 20,
  period_seconds: 600,
  baseline_rsam: 40,
  threshold_rsam: 123,
  tremor_fraction: 0.2,
  parameters: { baseline_factor: 2, min_duration_periods: 3 },
  // El formato REAL de prod: 6 decimales, como /rsam.
  samples: [
    { t: '2026-09-06T20:05:00.000000Z', rsam: 40.12, dominant_hz: 1.5, fi: -0.3 },
    { t: '2026-09-06T20:15:00.000000Z', rsam: 41.0, dominant_hz: null, fi: null },
  ],
  episodes: [],
};

describe('TREMOR_BASELINE_FACTOR', () => {
  it('es el tremorBaselineFactor del JSON compartido (para la leyenda, no para recalcular)', () => {
    expect(TREMOR_BASELINE_FACTOR).toBe(constantsFromJson.tremorBaselineFactor);
  });
});

describe('episodesToReferenceAreas', () => {
  it('dos episodios ⇒ dos áreas con EXACTAMENTE sus start/end (en ms epoch)', () => {
    const episodes = [
      episode({ start: '2026-09-06T03:25:00Z', end: '2026-09-06T04:05:00Z' }),
      episode({ start: '2026-09-06T10:15:00Z', end: '2026-09-06T11:45:00Z' }),
    ];
    const areas = episodesToReferenceAreas(episodes);
    expect(areas).toHaveLength(2);
    expect(areas[0]).toEqual({ x1: Date.UTC(2026, 8, 6, 3, 25), x2: Date.UTC(2026, 8, 6, 4, 5) });
    expect(areas[1]).toEqual({ x1: Date.UTC(2026, 8, 6, 10, 15), x2: Date.UTC(2026, 8, 6, 11, 45) });
  });

  it('acepta el offset +00:00 de Pydantic igual que la Z', () => {
    const areas = episodesToReferenceAreas([
      episode({ start: '2026-09-06T03:25:00+00:00', end: '2026-09-06T04:05:00+00:00' }),
    ]);
    expect(areas[0]).toEqual({ x1: Date.UTC(2026, 8, 6, 3, 25), x2: Date.UTC(2026, 8, 6, 4, 5) });
  });

  it('sin episodios ⇒ [] (cero ReferenceArea)', () => {
    expect(episodesToReferenceAreas([])).toEqual([]);
  });

  it('un episodio con borde imparseable se descarta (nunca x NaN)', () => {
    const areas = episodesToReferenceAreas([episode({ start: 'bogus' }), episode({})]);
    expect(areas).toHaveLength(1);
  });
});

describe('bandLabelKey / fiSignLabelKey', () => {
  it('mapean cada literal a su clave i18n bajo analytics.tremor', () => {
    expect(bandLabelKey('low')).toBe('tremor.band.low');
    expect(bandLabelKey('mid')).toBe('tremor.band.mid');
    expect(bandLabelKey('high')).toBe('tremor.band.high');
    expect(bandLabelKey('undefined')).toBe('tremor.band.undefined');
    expect(fiSignLabelKey('lp_like')).toBe('tremor.fiSign.lp_like');
    expect(fiSignLabelKey('vt_like')).toBe('tremor.fiSign.vt_like');
    expect(fiSignLabelKey('undefined')).toBe('tremor.fiSign.undefined');
  });
});

describe('thresholdLine', () => {
  it('devuelve threshold_rsam TAL CUAL, aunque baseline × factor dé otra cosa', () => {
    // baseline 40 × factor 2 = 80 ≠ 123: el cliente NO recalcula.
    expect(RESPONSE.baseline_rsam! * RESPONSE.parameters.baseline_factor).not.toBe(123);
    expect(thresholdLine(RESPONSE)).toBe(123);
  });

  it('threshold_rsam null (sin datos) ⇒ null, no 0', () => {
    expect(thresholdLine({ ...RESPONSE, baseline_rsam: null, threshold_rsam: null })).toBeNull();
  });
});

describe('samplesToRows', () => {
  it('parsea el t de 6 decimales a ms epoch y conserva rsam, dominantHz y fi (null incluido)', () => {
    const rows = samplesToRows(RESPONSE.samples);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ t: Date.UTC(2026, 8, 6, 20, 5), rsam: 40.12, dominantHz: 1.5, fi: -0.3 });
    expect(rows[1].t).toBe(Date.UTC(2026, 8, 6, 20, 15));
    expect(rows[1].dominantHz).toBeNull();
    expect(rows[1].fi).toBeNull();
  });

  it('sin muestras ⇒ []', () => {
    expect(samplesToRows([])).toEqual([]);
  });

  it('una muestra con t imparseable se descarta', () => {
    const rows = samplesToRows([{ t: 'bogus', rsam: 1, dominant_hz: null, fi: null }, ...RESPONSE.samples]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => Number.isFinite(r.t))).toBe(true);
  });
});
