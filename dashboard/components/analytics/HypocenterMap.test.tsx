/**
 * Mapa de hipocentros de /analytics (analytics-professional-panels, 5.6;
 * spec dashboard-ui "Mapa de hipocentros propio de Analytics", design
 * Decision 5, [R26]/M14).
 *
 * Leaflet REAL sobre jsdom con spies sobre el MÓDULO (no `vi.mock`): leaflet
 * es CJS externalizado y mockear el módulo entero produce dos instancias
 * distintas — la trampa UMD-vs-ESM ya documentada en
 * `map-locale-popups.test.tsx`. Espiar `L.map` / `L.circleMarker` sobre la
 * instancia real captura exactamente lo que el componente llama, sin importar
 * en qué tick resuelva su `import('leaflet')`.
 *
 * Lo que se PROTEGE:
 * - `preferCanvas: true` (Decision 5: sin plugin de clustering, el canvas es
 *   lo que sostiene miles de marcadores).
 * - UN `circleMarker` por evento, ninguno descartado en silencio.
 * - El evento con `prof_km: null` lleva el estilo `no-depth`, NUNCA el color
 *   de `< 70 km` que daría `getDepthColor(0)` (M14).
 * - `total` visible y aviso de truncado con `shown`/`total`.
 * - CERO refresco propio: 120 s de timers falsos no disparan nada (el
 *   componente es presentacional, ni siquiera tiene fetch).
 * - Test estático: el componente no importa nada del mapa de /live.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import L from 'leaflet';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import type { HypocentersResponse } from '@/lib/analytics';
import { markerStyle } from '@/lib/hypocenter-markers';
import { IntlTestProvider } from '@/lib/test-intl';
import type { SeismicEvent } from '@/lib/types';
import { getDepthColor } from '@/lib/utils';
import { HypocenterMap } from './HypocenterMap';

/** Opciones capturadas de cada `L.circleMarker`, en orden de creación. */
const circleMarkerOptions: Array<Record<string, unknown>> = [];
/** Opciones capturadas de cada `L.map`. */
const mapOptions: Array<Record<string, unknown>> = [];

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/**
 * Renderer inerte: jsdom no implementa `createSVGRect` ni canvas 2D, así que
 * agregar cualquier Path revienta. Copiado de `map-locale-popups.test.tsx`.
 */
function makeFakeRenderer() {
  return {
    options: { tolerance: 0, padding: 0 },
    _bounds: new L.Bounds(L.point(-1e7, -1e7), L.point(1e7, 1e7)),
    _initPath() {},
    _addPath() {},
    _removePath() {},
    _updatePath() {},
    _updateCircle() {},
    _updatePoly() {},
    _setPath() {},
    _bringToFront() {},
    _bringToBack() {},
    on() {},
    off() {},
  };
}

const popups: string[] = [];

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  circleMarkerOptions.length = 0;
  mapOptions.length = 0;
  popups.length = 0;

  vi.spyOn(
    L.Map.prototype as unknown as { getRenderer: () => unknown },
    'getRenderer',
  ).mockImplementation(makeFakeRenderer);

  vi.spyOn(L.Layer.prototype, 'bindPopup').mockImplementation(function (this: L.Layer, html: unknown) {
    popups.push(String(html));
    return this;
  });

  const realMap = L.map;
  vi.spyOn(L, 'map').mockImplementation((container: unknown, options?: unknown) => {
    mapOptions.push((options ?? {}) as Record<string, unknown>);
    return realMap(container as HTMLElement, options as L.MapOptions);
  });

  const realCircleMarker = L.circleMarker;
  vi.spyOn(L, 'circleMarker').mockImplementation((latlng: unknown, options?: unknown) => {
    circleMarkerOptions.push((options ?? {}) as Record<string, unknown>);
    return realCircleMarker(latlng as L.LatLngExpression, options as L.CircleMarkerOptions);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function event(overrides: Partial<SeismicEvent>): SeismicEvent {
  return {
    id: 'us1',
    fuentes: ['USGS'],
    hora_utc: '2026-09-06T10:00:00Z',
    lat: -31.9,
    lon: -68.3,
    prof_km: 50,
    mag: 4.2,
    mag_tipo: 'ml',
    lugar: 'San Juan',
    sentido: false,
    revisado: false,
    ...overrides,
  };
}

const THREE_EVENTS: SeismicEvent[] = [
  event({ id: 'a', prof_km: 50, mag: 5.1 }),
  event({ id: 'b', prof_km: 200, mag: 4.4, lugar: 'Mendoza' }),
  event({ id: 'c', prof_km: null, mag: 3.2, lugar: null }),
];

function respuesta(over: Partial<HypocentersResponse> = {}): HypocentersResponse {
  return {
    eventos: THREE_EVENTS,
    total: 3,
    truncated: false,
    window_start: '2026-08-07T00:00:00Z',
    window_end: '2026-09-06T00:00:00Z',
    area_slug: 'andes',
    ...over,
  };
}

function renderMap(props: Partial<Parameters<typeof HypocenterMap>[0]> = {}) {
  return render(
    <IntlTestProvider>
      <HypocenterMap data={respuesta()} isLoading={false} {...props} />
    </IntlTestProvider>,
  );
}

describe('HypocenterMap', () => {
  it('monta Leaflet con preferCanvas: true (Decision 5)', async () => {
    renderMap();
    await waitFor(() => expect(mapOptions.length).toBeGreaterThan(0));
    expect(mapOptions[0].preferCanvas).toBe(true);
  });

  it('3 eventos ⇒ 3 circleMarker; ninguno se descarta en silencio', async () => {
    renderMap();
    await waitFor(() => expect(circleMarkerOptions).toHaveLength(3));
  });

  it('el evento con prof_km null lleva el estilo no-depth, NO el color de <70 km (M14)', async () => {
    renderMap();
    await waitFor(() => expect(circleMarkerOptions).toHaveLength(3));

    const sinProfundidad = circleMarkerOptions[2];
    const esperado = markerStyle(THREE_EVENTS[2]);
    expect(esperado.kind).toBe('no-depth');
    expect(sinProfundidad.fillOpacity).toBe(0);
    expect(sinProfundidad.dashArray).toBeDefined();
    expect(sinProfundidad.fillColor).not.toBe(getDepthColor(0));
    expect(sinProfundidad.color).not.toBe(getDepthColor(0));

    // Los que SÍ tienen profundidad usan getDepthColor con SU valor.
    expect(circleMarkerOptions[0].fillColor).toBe(getDepthColor(50));
    expect(circleMarkerOptions[1].fillColor).toBe(getDepthColor(200));
  });

  it('muestra el total de la respuesta', async () => {
    renderMap();
    expect(await screen.findByText(es.analytics.map.total.replace('{total}', '3'))).toBeInTheDocument();
  });

  it('truncated: true ⇒ aviso con la cantidad dibujada y el total', async () => {
    renderMap({ data: respuesta({ total: 5000, truncated: true }) });
    const aviso = await screen.findByTestId('hypocenter-truncated');
    expect(aviso.textContent).toContain('5000');
    expect(aviso.textContent).toContain('3');
  });

  it('truncated: false ⇒ no hay aviso de truncado', async () => {
    renderMap();
    await waitFor(() => expect(circleMarkerOptions).toHaveLength(3));
    expect(screen.queryByTestId('hypocenter-truncated')).toBeNull();
  });

  it('el popup del evento sin profundidad dice "sin profundidad"', async () => {
    renderMap();
    await waitFor(() => expect(popups).toHaveLength(3));
    expect(popups[2]).toContain(es.analytics.map.popup.noDepth);
    expect(popups[0]).toContain('50.0');
    expect(popups[0]).toContain('San Juan');
  });

  it('no se refresca solo: 120 s de timers falsos no crean marcadores nuevos', async () => {
    renderMap();
    await waitFor(() => expect(circleMarkerOptions).toHaveLength(3));

    vi.useFakeTimers();
    vi.advanceTimersByTime(120_000);
    expect(circleMarkerOptions).toHaveLength(3);
  });

  it('sin datos y con error ⇒ role=alert propio, sin montar el mapa', async () => {
    render(
      <IntlTestProvider>
        <HypocenterMap data={undefined} error={new Error('503')} isLoading={false} />
      </IntlTestProvider>,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(es.analytics.map.error);
    expect(mapOptions).toHaveLength(0);
  });

  it('sin datos y sin error ⇒ role=status cargando', () => {
    render(
      <IntlTestProvider>
        <HypocenterMap data={undefined} isLoading />
      </IntlTestProvider>,
    );
    expect(screen.getByRole('status').textContent).toContain(es.analytics.map.loading);
  });

  it('NO comparte comportamiento live: cero referencias a los mapas de /live ni a suscripciones', () => {
    const source = readFileSync(join(__dirname, 'HypocenterMap.tsx'), 'utf8');
    for (const prohibida of [
      'AdvancedSeismicMap',
      'SeismicMapWithCities',
      'StationMiniMap',
      'use-area-refresh',
      '/ws/',
      'EventSource',
      'setInterval',
      'refreshInterval',
      "from 'swr'",
    ]) {
      expect(source).not.toContain(prohibida);
    }
  });
});
