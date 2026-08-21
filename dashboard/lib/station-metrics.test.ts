import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchStationMetrics,
  formatWallMetricsLine,
  latencySeconds,
  type StationMetrics,
} from './station-metrics';

const SAMPLE: StationMetrics = {
  channel: 'IU.MAJO.00.BHZ',
  endtime: '2026-08-21T14:32:10.000000Z',
  rsam: 123.4,
  freq_hz: 2.4,
  fi: -0.12,
  peak_db: 87.3,
  events_hour: 3,
};

describe('fetchStationMetrics', () => {
  beforeEach(() => {
    // tipar el spy con los args de fetch — la lección del W2: un vi.fn()
    // pelado tipa mock.calls[0] como [] y tsc --noEmit revienta.
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ metrics: { [SAMPLE.channel]: SAMPLE } }),
        } as Response),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('arma el query con channel repetido y devuelve el mapa', async () => {
    const result = await fetchStationMetrics(['IU.MAJO.00.BHZ', 'JP.JYT..BHZ']);

    const fetchMock = vi.mocked(fetch);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/stations/metrics?');
    expect(url).toContain('channel=IU.MAJO.00.BHZ');
    expect(url).toContain('channel=JP.JYT..BHZ');
    expect(result['IU.MAJO.00.BHZ']).toEqual(SAMPLE);
  });

  it('sin canales no llama a fetch y devuelve vacío', async () => {
    expect(await fetchStationMetrics([])).toEqual({});
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('con respuesta no-ok devuelve vacío (la UI muestra guiones, no rompe)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
    expect(await fetchStationMetrics(['IU.MAJO.00.BHZ'])).toEqual({});
  });
});

describe('latencySeconds', () => {
  it('resta el endtime del ahora, redondeado a segundos', () => {
    const now = Date.parse('2026-08-21T14:32:18.000Z');
    expect(latencySeconds(SAMPLE.endtime, now)).toBe(8);
  });

  it('endtime inválido devuelve null', () => {
    expect(latencySeconds('no-es-fecha', Date.now())).toBeNull();
  });
});

describe('formatWallMetricsLine', () => {
  it('formatea la banda compacta RSAM · FI · lat', () => {
    const now = Date.parse('2026-08-21T14:32:18.000Z');
    expect(formatWallMetricsLine(SAMPLE, now)).toBe('RSAM 123 · FI -0.12 · 8s');
  });

  it('los null salen como guion', () => {
    const now = Date.parse('2026-08-21T14:32:18.000Z');
    const m = { ...SAMPLE, rsam: null, fi: null };
    expect(formatWallMetricsLine(m, now)).toBe('RSAM — · FI — · 8s');
  });
});
