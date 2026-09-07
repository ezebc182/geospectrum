import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiStatusError } from './auth';
import {
  type BValueResponse,
  getBValue,
  getHypocenters,
  getStationUptime,
  getTremor,
  type StationUptimeResponse,
  type TremorResponse,
} from './analytics';

/** Molde de `lib/feedback.test.ts`: fetch stub que devuelve un status y un body. */
function mockFetch(status: number, body: unknown = null) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: () => Promise.resolve(body),
  } as Response;
  const spy = vi.fn((_input: string, _init?: RequestInit) => Promise.resolve(response));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function lastCall(spy: ReturnType<typeof mockFetch>): [string, RequestInit] {
  return spy.mock.calls[0] as [string, RequestInit];
}

/** Solo la parte `path?query` de la URL: el host viene de NEXT_PUBLIC_API_URL. */
function pathOf(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, '');
}

const B_VALUE_OK: BValueResponse = {
  status: 'ok',
  method: 'aki-utsu-mle',
  n_total: 7633,
  n_above_mc: 5295,
  min_events: 50,
  mc: 1.8,
  mc_at_catalog_floor: false,
  bins: [{ m: 1.8, count: 900, cumulative: 5295 }],
  mag_type_counts: { ml: 5000, mb: 295 },
  window_start: '2026-08-07T12:00:00Z',
  window_end: '2026-09-06T12:00:00Z',
  area_slug: 'global',
  b: 0.9963,
  a: 5.6,
  sigma_b: 0.0047,
};

const UPTIME: StationUptimeResponse = {
  bucket: 'hour',
  window_start: '2026-09-05T12:00:00Z',
  window_end: '2026-09-06T12:00:00Z',
  expected_columns_per_hour: 900,
  stations: {
    'GE.KBU..BHZ': [
      {
        bucket_start: '2026-09-05T12:00:00Z',
        columns_count: 0,
        observed_hours: 0,
        expected: 0,
        ratio: null,
        in_progress: false,
      },
    ],
  },
  overall: { 'GE.KBU..BHZ': null },
};

const TREMOR: TremorResponse = {
  channel: 'GE.KBU..BHZ',
  sampling_rate: 20,
  period_seconds: 600,
  baseline_rsam: 40,
  threshold_rsam: 80,
  tremor_fraction: 0,
  parameters: { baseline_factor: 2, min_duration_periods: 3 },
  samples: [{ t: '2026-09-06T20:05:00.000000Z', rsam: 40.12, dominant_hz: 1.5, fi: -0.3 }],
  episodes: [],
};

afterEach(() => vi.unstubAllGlobals());

describe('getBValue', () => {
  it('hace GET /analytics/b-value?days=30 con credentials include y sin params opcionales ausentes', async () => {
    const spy = mockFetch(200, B_VALUE_OK);
    const result = await getBValue(30);
    const [url, init] = lastCall(spy);
    expect(pathOf(url)).toBe('/analytics/b-value?days=30');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.credentials).toBe('include');
    expect(init.cache).toBe('no-store');
    expect(result).toEqual(B_VALUE_OK);
  });

  it('agrega min_mag y mc SOLO cuando se pasan', async () => {
    const spy = mockFetch(200, B_VALUE_OK);
    await getBValue(90, 2.5, 2);
    expect(pathOf(lastCall(spy)[0])).toBe('/analytics/b-value?days=90&min_mag=2.5&mc=2');
  });

  it('preserva el body "insufficient" SIN inventar una clave b', async () => {
    const body = { ...B_VALUE_OK, status: 'insufficient', n_above_mc: 23 } as Record<string, unknown>;
    delete body.b;
    delete body.a;
    delete body.sigma_b;
    mockFetch(200, body);
    const result = await getBValue(7);
    expect(result.status).toBe('insufficient');
    expect('b' in result).toBe(false);
  });

  it('503 (sin event_store) lanza ApiStatusError con el detail', async () => {
    mockFetch(503, { detail: 'El histórico de eventos no está disponible' });
    const error = await getBValue(30).catch((e) => e);
    expect(error).toBeInstanceOf(ApiStatusError);
    expect(error.status).toBe(503);
    expect(error.message).toContain('no está disponible');
  });
});

describe('getHypocenters', () => {
  it('hace GET /analytics/hypocenters?days=30 y devuelve el catálogo tal cual', async () => {
    const body = {
      eventos: [
        {
          id: 'us1',
          fuentes: ['USGS'],
          hora_utc: '2026-09-06T10:00:00Z',
          lat: -31.9,
          lon: -68.3,
          prof_km: null,
          mag: 4.2,
          mag_tipo: 'ml',
          lugar: 'San Juan',
          sentido: false,
          revisado: false,
        },
      ],
      total: 1,
      truncated: false,
      window_start: '2026-08-07T12:00:00Z',
      window_end: '2026-09-06T12:00:00Z',
      area_slug: 'global',
    };
    const spy = mockFetch(200, body);
    const result = await getHypocenters(30);
    const [url, init] = lastCall(spy);
    expect(pathOf(url)).toBe('/analytics/hypocenters?days=30');
    expect(init.credentials).toBe('include');
    expect(result).toEqual(body);
    // `prof_km: null` viaja como null, no se convierte en 0 en el cliente.
    expect(result.eventos[0].prof_km).toBeNull();
  });

  it('agrega min_mag y limit cuando se pasan', async () => {
    const spy = mockFetch(200, { eventos: [], total: 0, truncated: false });
    await getHypocenters(365, 3, 5000);
    expect(pathOf(lastCall(spy)[0])).toBe('/analytics/hypocenters?days=365&min_mag=3&limit=5000');
  });

  it('422 (limit fuera de rango) lanza ApiStatusError', async () => {
    mockFetch(422, { detail: 'limit' });
    const error = await getHypocenters(30, undefined, 5001).catch((e) => e);
    expect(error).toBeInstanceOf(ApiStatusError);
    expect(error.status).toBe(422);
  });
});

describe('getStationUptime', () => {
  it('hace GET /analytics/station-uptime?days=7&bucket=hour sin channel cuando no se piden canales', async () => {
    const spy = mockFetch(200, UPTIME);
    const result = await getStationUptime(7, 'hour');
    const [url, init] = lastCall(spy);
    expect(pathOf(url)).toBe('/analytics/station-uptime?days=7&bucket=hour');
    expect(init.credentials).toBe('include');
    expect(result).toEqual(UPTIME);
    // null ≠ 0: el cliente no toca el ratio.
    expect(result.stations['GE.KBU..BHZ'][0].ratio).toBeNull();
    expect(result.overall['GE.KBU..BHZ']).toBeNull();
  });

  it('repite channel= por cada canal pedido, en orden y URL-encoded', async () => {
    const spy = mockFetch(200, UPTIME);
    await getStationUptime(30, 'day', ['GE.KBU..BHZ', 'IU.MAJO.00.BHZ']);
    expect(pathOf(lastCall(spy)[0])).toBe(
      '/analytics/station-uptime?days=30&bucket=day&channel=GE.KBU..BHZ&channel=IU.MAJO.00.BHZ',
    );
  });

  it('lista vacía de canales ⇒ sin channel= (todos)', async () => {
    const spy = mockFetch(200, UPTIME);
    await getStationUptime(1, 'hour', []);
    expect(pathOf(lastCall(spy)[0])).toBe('/analytics/station-uptime?days=1&bucket=hour');
  });

  it('503 (sin db_pool) lanza ApiStatusError', async () => {
    mockFetch(503, { detail: 'El historial de disponibilidad no está disponible' });
    const error = await getStationUptime(7, 'hour').catch((e) => e);
    expect(error).toBeInstanceOf(ApiStatusError);
    expect(error.status).toBe(503);
  });
});

describe('getTremor', () => {
  const WINDOW = { startMs: Date.UTC(2026, 8, 6, 0, 0, 0), endMs: Date.UTC(2026, 8, 6, 6, 0, 0) };

  it('hace GET /analytics/tremor/{channel}?start&end en ISO UTC y devuelve {kind: "data"}', async () => {
    const spy = mockFetch(200, TREMOR);
    const result = await getTremor('GE.KBU..BHZ', WINDOW);
    const [url, init] = lastCall(spy);
    expect(pathOf(url)).toBe(
      '/analytics/tremor/GE.KBU..BHZ?start=2026-09-06T00%3A00%3A00.000Z&end=2026-09-06T06%3A00%3A00.000Z',
    );
    expect(init.credentials).toBe('include');
    expect(result).toEqual({ kind: 'data', data: TREMOR });
  });

  it('404 (sin datos FDSN) ⇒ {kind: "no-data"} con el detail, NO una excepción', async () => {
    mockFetch(404, { detail: 'Sin datos FDSN para GE.KBU..BHZ' });
    const result = await getTremor('GE.KBU..BHZ', WINDOW);
    expect(result.kind).toBe('no-data');
    if (result.kind === 'no-data') expect(result.detail).toContain('Sin datos FDSN');
  });

  it('422 (ventana > 24 h) lanza ApiStatusError', async () => {
    mockFetch(422, { detail: 'la ventana no puede superar 24 horas' });
    const error = await getTremor('GE.KBU..BHZ', WINDOW).catch((e) => e);
    expect(error).toBeInstanceOf(ApiStatusError);
    expect(error.status).toBe(422);
    expect(error.message).toContain('24 horas');
  });

  it('503 lanza ApiStatusError (solo el 404 es un estado, no un error)', async () => {
    mockFetch(503, { detail: 'boom' });
    const error = await getTremor('GE.KBU..BHZ', WINDOW).catch((e) => e);
    expect(error).toBeInstanceOf(ApiStatusError);
    expect(error.status).toBe(503);
  });
});
