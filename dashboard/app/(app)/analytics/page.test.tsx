/**
 * Página `/analytics` con los paneles nuevos (analytics-professional-panels,
 * tarea 5.8; spec dashboard-ui "Selectores de ventana temporal y de canales
 * en /analytics", design Decision 8 / [R21]).
 *
 * Lo que se PROTEGE acá son las PETICIONES, no el pixel: la spec exige
 * "observar las peticiones (mock de `fetch` con contador por URL), no el
 * resultado visual". Por eso `fetch` global se mockea y cada test cuenta por
 * prefijo de URL. Un panel que se cuelga de la ventana equivocada (uptime
 * reaccionando a `signalWindow`, RSAM reaccionando a `catalogDays`) muere acá
 * aunque en pantalla se vea igual.
 *
 * `HypocenterMap` se mockea: es PRESENTACIONAL (la página es dueña de su
 * `useSWR`, Decision 8), así que el mock no esconde ninguna request — y monta
 * Leaflet real, que en jsdom necesita el andamio entero de
 * `HypocenterMap.test.tsx`. Lo que ese componente hace con los datos ya está
 * cubierto por su propio test.
 *
 * SWR es el REAL, con caché nueva por test (patrón `feedback/page.test.tsx`):
 * si se mockeara, la revalidación por área probaría el mock y no el
 * `useAreaRefresh` de producción.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import { emitAreaChanged } from '@/lib/area-events';
import { IntlTestProvider } from '@/lib/test-intl';

import AnalyticsPage from './page';

const A = es.analytics;

// El mapa se reemplaza por una marca inerte (ver cabecera). Se declara con
// `vi.hoisted` para que la fábrica del mock no capture nada del scope del test.
vi.mock('@/components/analytics/HypocenterMap', () => ({
  HypocenterMap: () => <div data-testid="hypocenter-map-stub" />,
}));

// Recharts se reemplaza por elementos inertes, igual que en los tests de los
// componentes: `ResponsiveContainer` mide 0×0 en jsdom y exige `ResizeObserver`.
// Acá no se assertan gráficos — se cuentan peticiones.
vi.mock('recharts', () => {
  const passthrough = (props: { children?: ReactNode }) => <div>{props.children}</div>;
  return {
  ResponsiveContainer: passthrough,
  BarChart: passthrough,
  LineChart: passthrough,
  ComposedChart: passthrough,
  ScatterChart: passthrough,
  Bar: () => null,
  Line: () => null,
  Scatter: () => null,
  Area: () => null,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  ZAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  ReferenceArea: () => null,
  ReferenceLine: () => null,
  };
});

/** Contador de peticiones por URL completa, en orden de llegada. */
const requestedUrls: string[] = [];

function countMatching(pattern: RegExp): number {
  return requestedUrls.filter((url) => pattern.test(url)).length;
}

const REPORT = {
  timestamp_utc_generacion: '2026-09-07T00:00:00Z',
  region_monitorizada: { minlat: -56, maxlat: -17.5, minlon: -76.5, maxlon: -66 },
  data_source_errors: [],
  kpis: {
    total_eventos: 1,
    tasa_eventos_por_hora: 0.04,
    magnitud_max: 4.2,
    magnitud_promedio_ponderada_por_energia: 4.2,
    profundidad_media_M_ge_4: 50,
    eventos_sentidos: 0,
    porcentaje_eventos_sentidos: 0,
    minutos_desde_M_ge_5: null,
  },
  alertas: [],
  eventos: [
    {
      id: 'ev-1',
      fuentes: ['USGS'],
      hora_utc: '2026-09-06T12:00:00Z',
      lat: -33,
      lon: -70,
      prof_km: 50,
      mag: 4.2,
      mag_tipo: 'mb',
      lugar: 'Región Metropolitana',
      sentido: false,
      revisado: true,
    },
  ],
};

const B_VALUE = {
  status: 'ok',
  b: 1.0,
  a: 3.0,
  sigma_b: 0.05,
  mc: 3.0,
  mc_at_catalog_floor: false,
  n_above_mc: 120,
  min_events: 50,
  method: 'MLE (Aki-Utsu)',
  bins: [{ mag: 3.0, count: 60, cumulative: 120 }],
  mag_type_counts: { mb: 120 },
  window_start: '2026-08-08T00:00:00Z',
  window_end: '2026-09-07T00:00:00Z',
  area_slug: null,
};

const HYPOCENTERS = {
  eventos: REPORT.eventos,
  total: 1,
  truncated: false,
  window_start: '2026-08-08T00:00:00Z',
  window_end: '2026-09-07T00:00:00Z',
  area_slug: null,
};

const UPTIME = {
  bucket: 'hour',
  window_start: '2026-08-08T00:00:00Z',
  window_end: '2026-09-07T00:00:00Z',
  expected_columns_per_hour: 900,
  stations: {
    'CX.PB01..HHZ': [
      {
        bucket_start: '2026-09-06T10:00:00Z',
        columns_count: 900,
        observed_hours: 1,
        expected: 900,
        ratio: 1,
        in_progress: false,
      },
    ],
  },
  overall: { 'CX.PB01..HHZ': 1 },
};

const CATALOG = [
  { channel: 'CX.PB01..HHZ', city_id: 'iquique', network: 'CX', station: 'PB01', is_live: true, is_primary: true },
  { channel: 'CX.PB02..HHZ', city_id: 'iquique', network: 'CX', station: 'PB02', is_live: true, is_primary: false },
];

const RSAM = { channel: 'CX.PB01..HHZ', period_seconds: 600, samples: [] };

const TREMOR = {
  channel: 'CX.PB01..HHZ',
  window_start: '2026-09-06T18:00:00Z',
  window_end: '2026-09-07T00:00:00Z',
  samples: [],
  episodes: [],
  baseline_rsam: 40,
  threshold_rsam: 100,
  tremor_fraction: 0,
  parameters: { baseline_factor: 2, min_duration_periods: 3, period_seconds: 600 },
};

/** Rutas que devuelven 503 en el test en curso (para el escenario (d)). */
let failing: RegExp | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Service Unavailable',
    json: async () => body,
  } as Response;
}

function routeFor(url: string): Response {
  if (failing && failing.test(url)) return jsonResponse({ detail: 'sin event_store' }, 503);
  if (url.includes('/analytics/b-value')) return jsonResponse(B_VALUE);
  if (url.includes('/analytics/hypocenters')) return jsonResponse(HYPOCENTERS);
  if (url.includes('/analytics/station-uptime')) return jsonResponse(UPTIME);
  if (url.includes('/analytics/tremor/')) return jsonResponse(TREMOR);
  if (url.includes('/rsam')) return jsonResponse(RSAM);
  if (url.includes('/spectrograms/station-catalog')) return jsonResponse(CATALOG);
  if (url.includes('/report')) return jsonResponse(REPORT);
  throw new Error(`URL sin ruta en el mock: ${url}`);
}

beforeEach(() => {
  requestedUrls.length = 0;
  failing = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      requestedUrls.push(url);
      return routeFor(url);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPage() {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <IntlTestProvider>
        <AnalyticsPage />
      </IntlTestProvider>
    </SWRConfig>,
  );
}

/** Espera a que el reporte haya pintado (la página deja de mostrar el loader). */
async function renderLoaded() {
  renderPage();
  await screen.findByText(A.fullEventsTable);
  // El catálogo del picker llega por su propio efecto: esperarlo evita que un
  // `act()` tardío contamine el conteo del test siguiente.
  await within(screen.getByTestId('station-picker')).findByRole('button', {
    name: /CX\.PB01\.\.HHZ/,
  });
}

/** Toca un canal del `StationPicker` (el ranking de uptime también tiene
 * botones con el mismo nombre: la búsqueda se acota al picker). */
function pickChannel(name: RegExp) {
  fireEvent.click(within(screen.getByTestId('station-picker')).getByRole('button', { name }));
}

/** Elige un preset por su etiqueta dentro del grupo indicado. */
function clickPreset(groupLabel: string, buttonLabel: string) {
  const group = screen.getByRole('group', { name: groupLabel });
  const button = Array.from(group.querySelectorAll('button')).find((b) => b.textContent === buttonLabel);
  if (!button) throw new Error(`No hay preset "${buttonLabel}" en el grupo "${groupLabel}"`);
  fireEvent.click(button);
}

describe('/analytics — peticiones de la carga inicial', () => {
  it('pide el reporte y los tres paneles de catálogo con days=30, y nada de señal sin canales', async () => {
    await renderLoaded();

    expect(countMatching(/\/report(\?|$)/)).toBe(1);
    expect(countMatching(/\/analytics\/b-value\?days=30/)).toBe(1);
    expect(countMatching(/\/analytics\/hypocenters\?days=30/)).toBe(1);
    expect(countMatching(/\/analytics\/station-uptime\?days=30/)).toBe(1);
    // Sin canales elegidos no hay ni RSAM ni tremor.
    expect(countMatching(/\/rsam/)).toBe(0);
    expect(countMatching(/\/analytics\/tremor\//)).toBe(0);
  });

  it('no le agrega parámetros nuevos a /report', async () => {
    await renderLoaded();

    const reportUrls = requestedUrls.filter((url) => /\/report(\?|$)/.test(url));
    expect(reportUrls).toHaveLength(1);
    expect(reportUrls[0]).not.toContain('days=');
    expect(reportUrls[0]).not.toContain('?');
  });
});

describe('/analytics — cambiar la ventana de catálogo', () => {
  it('elegir 7 días re-pide b-value, hipocentros y uptime, y NADA más', async () => {
    await renderLoaded();
    requestedUrls.length = 0;

    clickPreset(A.window.catalogDays, A.window.days.replace('{count}', '7'));

    await waitFor(() => expect(countMatching(/\/analytics\/b-value\?days=7/)).toBe(1));
    await waitFor(() => expect(countMatching(/\/analytics\/hypocenters\?days=7/)).toBe(1));
    await waitFor(() => expect(countMatching(/\/analytics\/station-uptime\?days=7/)).toBe(1));
    expect(countMatching(/\/report(\?|$)/)).toBe(0);
    expect(countMatching(/\/rsam/)).toBe(0);
    expect(countMatching(/\/analytics\/tremor\//)).toBe(0);
  });
});

describe('/analytics — cambiar la ventana de señal', () => {
  it('con 2 canales elegidos, 6 h re-pide 2 RSAM y 1 tremor de 6 h, y ningún panel de catálogo', async () => {
    await renderLoaded();

    pickChannel(/CX\.PB01\.\.HHZ/);
    pickChannel(/CX\.PB02\.\.HHZ/);
    // Se espera a que la selección se asiente antes de contar: `RsamTrendChart`
    // reinicia sus series cuando cambia la lista de canales (comportamiento
    // propio ya cubierto por su test), así que el conteo de acá no puede
    // arrancar en medio de esa cascada.
    await waitFor(() =>
      expect(countMatching(/\/stations\/CX\.PB02\.\.HHZ\/rsam/)).toBeGreaterThan(0),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    requestedUrls.length = 0;
    clickPreset(A.window.signalWindow, A.window.hours.replace('{count}', '6'));

    await waitFor(() => expect(countMatching(/\/rsam/)).toBe(2));
    await waitFor(() => expect(countMatching(/\/analytics\/tremor\//)).toBe(1));
    expect(countMatching(/\/report(\?|$)/)).toBe(0);
    expect(countMatching(/\/analytics\/b-value/)).toBe(0);
    expect(countMatching(/\/analytics\/hypocenters/)).toBe(0);
    expect(countMatching(/\/analytics\/station-uptime/)).toBe(0);

    // La ventana viaja como start/end absolutos y mide exactamente 6 h.
    const tremorUrl = requestedUrls.find((url) => url.includes('/analytics/tremor/'))!;
    const params = new URLSearchParams(tremorUrl.split('?')[1]);
    const spanMs = Date.parse(params.get('end')!) - Date.parse(params.get('start')!);
    expect(spanMs).toBe(6 * 3600 * 1000);

    // El tremor es de UN canal: el primero elegido (el endpoint es por canal).
    expect(tremorUrl).toContain(encodeURIComponent('CX.PB01..HHZ'));
  });
});

describe('/analytics — un panel que falla no tumba la página', () => {
  it('uptime en 503 muestra su propio role="alert" y los paneles existentes siguen', async () => {
    failing = /\/analytics\/station-uptime/;
    await renderLoaded();

    await waitFor(() => expect(screen.getByText(A.uptime.error)).toBeInTheDocument());
    expect(screen.getByText(A.uptime.error).closest('[role="alert"]')).not.toBeNull();

    // El error de página NO aparece y los tres bloques viejos siguen montados.
    expect(screen.queryByText(A.loadError)).toBeNull();
    expect(screen.getByText(A.fullEventsTable)).toBeInTheDocument();
    expect(screen.getByText(es.charts.magnitudeVsTime)).toBeInTheDocument();
    expect(screen.getByText(es.charts.depthDistribution)).toBeInTheDocument();
  });
});

describe('/analytics — cambio de área', () => {
  it('revalida reporte, b-value e hipocentros; NO uptime, RSAM ni tremor', async () => {
    await renderLoaded();

    pickChannel(/CX\.PB01\.\.HHZ/);
    await waitFor(() => expect(countMatching(/\/rsam/)).toBe(1));
    await waitFor(() => expect(countMatching(/\/analytics\/tremor\//)).toBe(1));

    requestedUrls.length = 0;
    emitAreaChanged();

    await waitFor(() => expect(countMatching(/\/report(\?|$)/)).toBe(1));
    await waitFor(() => expect(countMatching(/\/analytics\/b-value/)).toBe(1));
    await waitFor(() => expect(countMatching(/\/analytics\/hypocenters/)).toBe(1));
    expect(countMatching(/\/analytics\/station-uptime/)).toBe(0);
    expect(countMatching(/\/rsam/)).toBe(0);
    expect(countMatching(/\/analytics\/tremor\//)).toBe(0);
  });

  it('el indicador sigue encendido mientras cualquiera de las TRES sigue en vuelo (Promise.all)', async () => {
    // Falsabilidad del `Promise.all`: si el handler devolviera SOLO `mutate()`
    // del reporte, el indicador se apagaría apenas resuelve el reporte aunque
    // hipocentros siga viajando. Acá se retiene hipocentros, se libera el
    // resto, y el indicador TIENE que seguir prendido.
    await renderLoaded();

    let releaseHypocenters: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      releaseHypocenters = resolve;
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        requestedUrls.push(url);
        if (/\/analytics\/hypocenters/.test(url)) await held;
        return routeFor(url);
      },
    );

    requestedUrls.length = 0;
    emitAreaChanged();

    // Encendido: hay al menos una revalidación en vuelo.
    await waitFor(() => expect(screen.getByText(es.common.refreshingArea)).toBeInTheDocument());
    // El reporte y el b-value ya resolvieron; hipocentros no. Sigue encendido.
    await waitFor(() => expect(countMatching(/\/analytics\/b-value/)).toBe(1));
    expect(screen.getByText(es.common.refreshingArea)).toBeInTheDocument();

    releaseHypocenters!();
    await waitFor(() => expect(screen.queryByText(es.common.refreshingArea)).toBeNull());
  });
});
