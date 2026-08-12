/**
 * Popups de Leaflet y cambio de idioma en caliente (Fase 4 de i18n-dashboard).
 *
 * Los popups son HTML strings que se arman UNA vez al bindear el marcador:
 * si el effect que los construye no depende del locale/labels POR VALOR, el
 * cambio de idioma deja los popups en el idioma viejo para siempre (la trampa
 * documentada del proyecto: un efecto que lee un ref sin tenerlo en deps corre
 * una vez y nunca más). Este archivo cubre los dos mapas.
 *
 * Se usa Leaflet REAL sobre jsdom con un spy en `Layer.prototype.bindPopup`
 * (no un mock del módulo): leaflet es CJS externalizado y mockear el módulo
 * entero producía dos instancias distintas —una mockeada y una real— según el
 * tick en que corriera cada `import('leaflet')`. El spy sobre el prototype de
 * la instancia real captura TODOS los bindeos sin importar desde qué efecto
 * salgan, que es exactamente el contrato bajo prueba.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import L from 'leaflet';

import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { formats } from '@/i18n/request';
import { AdvancedSeismicMap } from './AdvancedSeismicMap';
import { SeismicMapWithCities } from './SeismicMapWithCities';
import type { SeismicEvent } from '@/lib/types';

/** HTML de cada bindPopup, en orden de bindeo. */
const popups: string[] = [];

// jsdom no trae ResizeObserver y AdvancedSeismicMap lo usa para invalidar el
// tamaño del mapa cuando el contenedor cambia.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/**
 * Renderer inerte para las capas vectoriales: jsdom no implementa
 * `createSVGRect` ni canvas 2D, así que los factories svg()/canvas() de
 * Leaflet devuelven null y agregar cualquier Path (circleMarker, rectangle,
 * geoJSON) revienta. Con este stub los vectores se agregan sin dibujarse,
 * que es exactamente lo que el test necesita: acá se verifica el HTML de los
 * popups, no el render.
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

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  popups.length = 0;
  vi.spyOn(
    L.Map.prototype as unknown as { getRenderer: () => unknown },
    'getRenderer',
  ).mockImplementation(makeFakeRenderer);
  // El popup real no hace falta: capturar el HTML alcanza para verificar el
  // idioma, y bindear popups de verdad sobre un mapa sin tamaño no aporta.
  vi.spyOn(L.Layer.prototype, 'bindPopup').mockImplementation(function (
    this: L.Layer,
    html: unknown,
  ) {
    popups.push(String(html));
    return this;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const REGION = { minlat: -35, maxlat: -30, minlon: -72, maxlon: -68 };

function makeEvento(overrides: Partial<SeismicEvent> = {}): SeismicEvent {
  return {
    id: 'evt-1',
    fuentes: ['USGS'],
    hora_utc: '2026-08-01T12:00:00Z',
    lat: -33.4,
    lon: -70.6,
    prof_km: 35,
    mag: 5.2,
    mag_tipo: 'mww',
    lugar: 'Santiago, Chile',
    sentido: false,
    revisado: true,
    ...overrides,
  };
}

function withIntl(locale: 'es-AR' | 'en-US', ui: React.ReactElement) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === 'es-AR' ? es : en}
      formats={formats}
      timeZone="UTC"
    >
      {ui}
    </NextIntlClientProvider>
  );
}

describe('SeismicMapWithCities — popups y cambio de idioma', () => {
  it('regenera los popups de ciudades en el idioma nuevo al cambiar el locale', async () => {
    const { rerender } = render(
      withIntl('es-AR', <SeismicMapWithCities eventos={[]} region={REGION} />),
    );

    // Con el mapa listo, la capa de ciudades bindea popups en español.
    await waitFor(() => {
      expect(popups.some((h) => h.includes('Población'))).toBe(true);
    });

    popups.length = 0;
    rerender(withIntl('en-US', <SeismicMapWithCities eventos={[]} region={REGION} />));

    // El cambio de locale re-corre el efecto de ciudades: popups nuevos en EN,
    // sin español residual entre lo regenerado.
    await waitFor(() => {
      expect(popups.some((h) => h.includes('Population'))).toBe(true);
    });
    expect(popups.some((h) => h.includes('Población'))).toBe(false);
  });

  it('regenera los popups de eventos con labels y fecha del locale nuevo', async () => {
    const { rerender } = render(
      withIntl('es-AR', <SeismicMapWithCities eventos={[]} region={REGION} />),
    );
    await waitFor(() => {
      expect(popups.length).toBeGreaterThan(0);
    });

    // Con el mapa ya creado, llega el reporte (identidad nueva de `eventos`,
    // como hace SWR): el popup del evento sale en español.
    const eventos = [makeEvento()];
    rerender(withIntl('es-AR', <SeismicMapWithCities eventos={eventos} region={REGION} />));
    await waitFor(() => {
      expect(popups.some((h) => h.includes('Profundidad'))).toBe(true);
    });

    popups.length = 0;
    rerender(withIntl('en-US', <SeismicMapWithCities eventos={eventos} region={REGION} />));

    await waitFor(() => {
      const popup = popups.find((h) => h.includes('Depth'));
      expect(popup).toBeDefined();
      // La fecha también se re-formatea al locale nuevo (en-US antepone el mes).
      expect(popup).toContain('Aug');
      expect(popup).toContain('Source');
    });
    expect(popups.some((h) => h.includes('Profundidad'))).toBe(false);
  });
});

describe('AdvancedSeismicMap — popups y cambio de idioma', () => {
  it('regenera popups de ciudades y eventos al cambiar el locale', async () => {
    const { rerender } = render(
      withIntl('es-AR', <AdvancedSeismicMap eventos={[]} region={REGION} />),
    );

    await waitFor(() => {
      expect(popups.some((h) => h.includes('Población'))).toBe(true);
    });

    // Reporte cargado con el mapa ya vivo (identidad nueva, como SWR).
    const eventos = [makeEvento()];
    rerender(withIntl('es-AR', <AdvancedSeismicMap eventos={eventos} region={REGION} />));
    await waitFor(() => {
      expect(popups.some((h) => h.includes('Profundidad'))).toBe(true);
    });

    popups.length = 0;
    rerender(withIntl('en-US', <AdvancedSeismicMap eventos={eventos} region={REGION} />));

    await waitFor(() => {
      expect(popups.some((h) => h.includes('Population'))).toBe(true);
      expect(popups.some((h) => h.includes('Depth'))).toBe(true);
    });
    expect(popups.some((h) => h.includes('Población'))).toBe(false);
    expect(popups.some((h) => h.includes('Profundidad'))).toBe(false);
  });

  it('muestra el estado revisado/preliminar traducido en el popup del evento', async () => {
    const eventos = [makeEvento({ revisado: false, sentido: true, lugar: null })];
    const { rerender } = render(
      withIntl('en-US', <AdvancedSeismicMap eventos={[]} region={REGION} />),
    );
    await waitFor(() => {
      expect(popups.length).toBeGreaterThan(0);
    });

    rerender(withIntl('en-US', <AdvancedSeismicMap eventos={eventos} region={REGION} />));

    await waitFor(() => {
      const popup = popups.find((h) => h.includes('Preliminary'));
      expect(popup).toBeDefined();
      expect(popup).toContain('Felt');
      // Sin `lugar`, cae al fallback traducido, no al texto hardcodeado.
      expect(popup).toContain('Unknown location');
    });
  });
});
