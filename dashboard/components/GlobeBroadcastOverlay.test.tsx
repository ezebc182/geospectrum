import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { SWRConfig } from 'swr';

import es from '@/messages/es.json';
import type { SeismicEvent } from '@/lib/types';
import { globePointId } from '@/lib/globe-data';
import { AREA_CHANGED_EVENT } from '@/lib/area-events';
import { GlobeBroadcastOverlay, type GlobeBroadcastOverlayProps } from './GlobeBroadcastOverlay';

const { searchEventsMock, getLiveChannelsMock, getGlobalWallMock, listWallsMock, getActiveAreaMock } =
  vi.hoisted(() => ({
    searchEventsMock: vi.fn(),
    getLiveChannelsMock: vi.fn(),
    getGlobalWallMock: vi.fn(),
    listWallsMock: vi.fn(),
    getActiveAreaMock: vi.fn(),
  }));
vi.mock('@/lib/api', () => ({
  seismicAPI: {
    searchEvents: searchEventsMock,
    getLiveChannels: getLiveChannelsMock,
    getGlobalWall: getGlobalWallMock,
  },
}));
vi.mock('@/lib/walls', () => ({
  listWalls: listWallsMock,
}));
vi.mock('@/lib/areas', () => ({
  getActiveArea: getActiveAreaMock,
}));

// SeismicGlobe usa WebGL: en jsdom se stubbea (mismo criterio que el resto
// del repo, la lógica del globo se testea en lib/globe-data.test.ts). Se
// capturan las props recibidas (Task 6: invocar onEventClick a mano desde
// el test, como si fuera un clic real sobre un punto del globo).
let capturedGlobeProps: Record<string, unknown> = {};
vi.mock('@/components/SeismicGlobe', () => ({
  SeismicGlobe: (props: Record<string, unknown>) => {
    capturedGlobeProps = props;
    return null;
  },
}));

// pickSpotlight real (Task 2) envuelto en un spy: permite contar cuántas
// veces el componente efectivamente "pickeó" sin mockear la decisión en sí
// (mismo patrón de mock parcial que LocaleSync.test.tsx).
vi.mock('@/lib/event-focus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/event-focus')>();
  return { ...actual, pickSpotlight: vi.fn(actual.pickSpotlight) };
});
import { pickSpotlight } from '@/lib/event-focus';
const pickSpotlightSpy = vi.mocked(pickSpotlight);

function makeEvento(overrides: Partial<SeismicEvent> = {}): SeismicEvent {
  return {
    id: 'ev-1',
    fuentes: ['USGS'],
    hora_utc: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
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

// Acepta props parciales para no duplicar el helper en cada task que agrega
// props al overlay (fullscreen/embeddedHeight, etc.). Devuelve el resultado
// de `render` (incluye `container`, necesario para los tests del modo
// embebido) más `onClose`, que la mayoría de los tests existentes usa como
// si fuera el valor de retorno directo.
function renderOverlay(props?: Partial<GlobeBroadcastOverlayProps>) {
  if (getLiveChannelsMock.getMockImplementation() === undefined) {
    getLiveChannelsMock.mockResolvedValue([]);
  }
  if (getGlobalWallMock.getMockImplementation() === undefined) {
    getGlobalWallMock.mockResolvedValue({
      id: 'global',
      name: 'Global',
      layout: { columns: [], showMetrics: false },
    });
  }
  if (listWallsMock.getMockImplementation() === undefined) {
    listWallsMock.mockResolvedValue([]);
  }
  if (getActiveAreaMock.getMockImplementation() === undefined) {
    getActiveAreaMock.mockResolvedValue(null);
  }
  const onClose = props?.onClose ?? vi.fn();
  const renderResult = render(
    <NextIntlClientProvider locale="es-AR" messages={es}>
      {/* Caché de SWR fresco por test: la clave 'broadcast-events' es la
          misma en todos y el caché de módulo filtraría datos entre tests. */}
      <SWRConfig value={{ provider: () => new Map() }}>
        <GlobeBroadcastOverlay {...props} onClose={onClose} />
      </SWRConfig>
    </NextIntlClientProvider>
  );
  return { ...renderResult, onClose };
}

// jsdom no implementa scrollIntoView: el useEffect que resalta la fila
// enfocada lo llama al montar/actualizar, y sin el stub el test explota.
Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  capturedGlobeProps = {};
});

describe('GlobeBroadcastOverlay', () => {
  it('pide 24h de eventos con piso M3 (parámetros explícitos, no defaults)', async () => {
    searchEventsMock.mockResolvedValue([]);
    renderOverlay();
    await waitFor(() =>
      expect(searchEventsMock).toHaveBeenCalledWith({ windowMinutes: 1440, minMag: 3 })
    );
  });

  it('muestra los contadores calculados de los eventos', async () => {
    const hoy = new Date().toISOString();
    searchEventsMock.mockResolvedValue([
      makeEvento({ id: 'a', mag: 6.5, hora_utc: hoy }),
      makeEvento({ id: 'b', mag: 5.1, hora_utc: hoy }),
      makeEvento({ id: 'c', mag: 3.5, hora_utc: hoy }),
    ]);
    renderOverlay();

    await waitFor(() => expect(screen.getByText('3')).toBeTruthy());
    expect(screen.getByText('Últimas 24 h')).toBeTruthy();
    // Hoy >=M5: el 6.5 y el 5.1
    expect(screen.getByText('2')).toBeTruthy();
    // Hoy >=M6: solo el 6.5
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('muestra el feed lateral con el evento más nuevo primero', async () => {
    const ahora = Date.now();
    searchEventsMock.mockResolvedValue([
      makeEvento({
        id: 'viejo',
        lugar: 'Viejo, Chile',
        hora_utc: new Date(ahora - 3 * 60 * 60 * 1000).toISOString(),
      }),
      makeEvento({
        id: 'nuevo',
        lugar: 'Nuevo, Japón',
        hora_utc: new Date(ahora - 5 * 60 * 1000).toISOString(),
      }),
    ]);
    renderOverlay();

    await waitFor(() => expect(screen.getByText('Nuevo, Japón')).toBeTruthy());
    const feed = screen.getByTestId('broadcast-feed');
    const filas = within(feed).getAllByRole('listitem');
    expect(filas[0].textContent).toContain('Nuevo, Japón');
    expect(filas[1].textContent).toContain('Viejo, Chile');
    // El de hace 5 min lleva el punto de "recién llegado"; el de 3 horas no.
    expect(filas[0].querySelector('[title="Evento reciente"]')).toBeTruthy();
    expect(filas[1].querySelector('[title="Evento reciente"]')).toBeNull();
  });

  it('muestra las analíticas y el ticker generados de los datos', async () => {
    const ahora = Date.now();
    searchEventsMock.mockResolvedValue([
      makeEvento({ id: 'a', lugar: '10 km N of X, Chile', hora_utc: new Date(ahora - 10 * 60_000).toISOString() }),
      makeEvento({ id: 'b', lugar: 'OFF COAST, CHILE', hora_utc: new Date(ahora - 30 * 60_000).toISOString() }),
      makeEvento({ id: 'c', mag: 5.4, lugar: '5 km S of Y, Indonesia', hora_utc: new Date(ahora - 2 * 60 * 60_000).toISOString() }),
    ]);
    renderOverlay();

    await waitFor(() => expect(screen.getByText('Regiones más activas (24 h)')).toBeTruthy());
    // Chile lidera el ranking con 2 eventos
    expect(screen.getByText('Chile')).toBeTruthy();
    // El ticker menciona la región más activa (contenido duplicado para el loop)
    expect(
      screen.getAllByText(/Región más activa: Chile con 2 eventos/).length
    ).toBeGreaterThanOrEqual(1);
    // El feed scrollea
    expect(document.querySelector('.overflow-y-auto')).toBeTruthy();
  });

  it('apila una tira de espectrograma por canal en vivo, con tope de 8', async () => {
    searchEventsMock.mockResolvedValue([]);
    getLiveChannelsMock.mockResolvedValue([
      { city_id: 'tokyo', channel: 'JP.JYT..BHZ' },
      { city_id: 'seattle', channel: 'UW.LON..HHZ' },
      { city_id: 'lima', channel: 'II.NNA.00.BHZ' },
      { city_id: 'osaka', channel: 'JP.JWT..BHZ' },
      { city_id: 'taipei', channel: 'IU.TATO.00.BHZ' },
      { city_id: 'guam', channel: 'IU.GUMO.00.BHZ' },
      { city_id: 'quito', channel: 'EC.PULU..HHZ' },
      { city_id: 'santiago', channel: 'C1.MT18..BHZ' },
      { city_id: 'anchorage', channel: 'AK.RC01..BHZ' }, // 9no: afuera del tope
    ]);
    renderOverlay();

    await waitFor(() => expect(screen.getByText('Espectrogramas en vivo')).toBeTruthy());
    expect(screen.getByText('Tokyo')).toBeTruthy();
    expect(screen.getByText('Santiago')).toBeTruthy();
    expect(screen.queryByText('Anchorage')).toBeNull();
  });

  it('permite ocultar y volver a mostrar paneles desde el engranaje', async () => {
    const ahora = Date.now();
    searchEventsMock.mockResolvedValue([
      makeEvento({ id: 'a', lugar: 'X, Chile', hora_utc: new Date(ahora - 10 * 60_000).toISOString() }),
    ]);
    renderOverlay();
    await waitFor(() => expect(screen.getByTestId('broadcast-feed')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Configurar paneles' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Feed de eventos' }));
    expect(screen.queryByTestId('broadcast-feed')).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Feed de eventos' }));
    expect(screen.getByTestId('broadcast-feed')).toBeTruthy();
  });

  it('permite agregar y quitar estaciones del stack de espectrogramas', async () => {
    searchEventsMock.mockResolvedValue([]);
    getLiveChannelsMock.mockResolvedValue([
      { city_id: 'tokyo', channel: 'JP.JYT..BHZ' },
      { city_id: 'seattle', channel: 'UW.LON..HHZ' },
    ]);
    renderOverlay();
    await waitFor(() => expect(screen.getByTestId('spectro-strips')).toBeTruthy());
    expect(within(screen.getByTestId('spectro-strips')).getByText('Tokyo')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Configurar paneles' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tokyo' }));
    expect(within(screen.getByTestId('spectro-strips')).queryByText('Tokyo')).toBeNull();
    expect(within(screen.getByTestId('spectro-strips')).getByText('Seattle')).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Tokyo' }));
    expect(within(screen.getByTestId('spectro-strips')).getByText('Tokyo')).toBeTruthy();
  });

  it('cierra con Escape y con el botón de salir', async () => {
    searchEventsMock.mockResolvedValue([]);
    const { onClose } = renderOverlay();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Salir de pantalla completa' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('la X llama a onClose para salir de pantalla completa', async () => {
    const onClose = vi.fn();
    renderOverlay({ onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Salir de pantalla completa' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('embebido, el boton pide volver a pantalla completa', () => {
    renderOverlay({ fullscreen: false, embeddedHeight: 720 });
    expect(screen.getByRole('button', { name: 'Pantalla completa' })).toBeTruthy();
  });

  it('embebido, Escape con la cartelera cerrada no hace nada', () => {
    // Rama vacía del efecto: en modo embebido no hay pantalla completa de la
    // que salir, así que Escape sin cartelera abierta no debe llamar onClose.
    // Borde frágil: Task 3 toca este mismo efecto.
    const { onClose } = renderOverlay({ fullscreen: false, embeddedHeight: 720 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('no revienta al prerenderizar en el servidor (sin DOM)', async () => {
    // Regresión: `'use client'` NO evita el prerender en el servidor, y ahí
    // `document` no existe. Mientras el overlay se montaba recién al hacer
    // clic esto no salía; desde que /globe ES la transmisión, el componente
    // es lo primero que renderiza la ruta y pasa por SSR.
    // Sin el guard `mounted`: "document is not defined".
    const { renderToString } = await import('react-dom/server');
    searchEventsMock.mockResolvedValue([]);

    expect(() =>
      renderToString(
        <NextIntlClientProvider locale="es-AR" messages={es}>
          <SWRConfig value={{ provider: () => new Map() }}>
            <GlobeBroadcastOverlay fullscreen onClose={vi.fn()} />
          </SWRConfig>
        </NextIntlClientProvider>
      )
    ).not.toThrow();
  });

  it('en fullscreen usa fixed y portalea a body', () => {
    const { container } = renderOverlay();
    // El portal saca el overlay del container de RTL.
    expect(container.querySelector('.fixed')).toBeNull();
    expect(document.body.querySelector('.fixed.inset-0')).toBeTruthy();
  });

  it('embebido renderiza en el árbol, sin fixed, con el alto pedido', () => {
    const { container } = renderOverlay({ fullscreen: false, embeddedHeight: 720 });
    const root = container.querySelector('[data-testid="broadcast-root"]');
    expect(root).toBeTruthy();
    expect(root?.className).not.toContain('fixed');
    expect((root as HTMLElement).style.height).toBe('720px');
  });
});

describe('cartelera (billboard)', () => {
  const NUEVE_CANALES = [
    { city_id: 'tokyo', channel: 'JP.JYT..BHZ' },
    { city_id: 'seattle', channel: 'UW.LON..HHZ' },
    { city_id: 'lima', channel: 'II.NNA.00.BHZ' },
    { city_id: 'osaka', channel: 'JP.JWT..BHZ' },
    { city_id: 'taipei', channel: 'IU.TATO.00.BHZ' },
    { city_id: 'guam', channel: 'IU.GUMO.00.BHZ' },
    { city_id: 'quito', channel: 'EC.PULU..HHZ' },
    { city_id: 'santiago', channel: 'C1.MT18..BHZ' },
    { city_id: 'anchorage', channel: 'AK.RC01..BHZ' },
  ];

  afterEach(() => {
    window.localStorage.clear();
  });

  it('el stack recorta la selección al tope: sin scroll, todo visible', async () => {
    // El usuario seleccionó 9 estaciones: antes desbordaban ocultas bajo el
    // overflow-hidden del panel. Ahora el stack muestra las primeras 8 y el
    // muro completo vive en la cartelera.
    window.localStorage.setItem(
      'globe.broadcast.spectros.v1',
      JSON.stringify(NUEVE_CANALES.map((c) => c.channel))
    );
    searchEventsMock.mockResolvedValue([]);
    getLiveChannelsMock.mockResolvedValue(NUEVE_CANALES);
    renderOverlay();

    await waitFor(() => expect(screen.getByTestId('spectro-strips')).toBeTruthy());
    const stack = screen.getByTestId('spectro-strips');
    expect(within(stack).getByText('Tokyo')).toBeTruthy();
    expect(within(stack).queryByText('Anchorage')).toBeNull();
  });

  it('el botón cartelera abre el muro con TODAS las estaciones vivas', async () => {
    searchEventsMock.mockResolvedValue([]);
    getLiveChannelsMock.mockResolvedValue(NUEVE_CANALES);
    getGlobalWallMock.mockResolvedValue({
      id: 'global',
      name: 'Global',
      layout: {
        columns: [
          {
            groups: [
              {
                title: 'ASIA-PACÍFICO',
                channels: NUEVE_CANALES.slice(0, 6).map((c) => ({
                  channel: c.channel,
                  label: c.city_id,
                })),
              },
            ],
          },
          {
            groups: [
              {
                title: 'AMÉRICA',
                channels: NUEVE_CANALES.slice(6).map((c) => ({
                  channel: c.channel,
                  label: c.city_id,
                })),
              },
            ],
          },
        ],
        showMetrics: false,
      },
    });
    renderOverlay();
    await waitFor(() => expect(screen.getByTestId('spectro-strips')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Modo cartelera' }));
    const muro = screen.getByTestId('billboard-wall');
    // El muro llega con layout SPECTRONET: encabezados de grupo por región...
    await waitFor(() => expect(within(muro).getByText('ASIA-PACÍFICO')).toBeTruthy());
    expect(within(muro).getByText('AMÉRICA')).toBeTruthy();
    // ...y una tira por cada uno de los 9 canales, sin recortar.
    expect(within(muro).getAllByText(/tokyo|seattle|lima|osaka|taipei|guam|quito|santiago|anchorage/i)).toHaveLength(9);
  });

  it('rota manualmente entre muro y analíticas', async () => {
    const ahora = Date.now();
    searchEventsMock.mockResolvedValue([
      makeEvento({ id: 'a', lugar: 'X, Chile', hora_utc: new Date(ahora - 10 * 60_000).toISOString() }),
    ]);
    getLiveChannelsMock.mockResolvedValue(NUEVE_CANALES);
    renderOverlay();
    await waitFor(() => expect(screen.getByTestId('spectro-strips')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Modo cartelera' }));
    expect(screen.getByTestId('billboard-wall').classList.contains('hidden')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Siguiente panel' }));
    // El muro queda MONTADO pero oculto: desmontar ~74 tiras (1 WS + 1 fetch
    // cada una) en cada rotación era una tormenta de reconexiones.
    expect(screen.getByTestId('billboard-wall').classList.contains('hidden')).toBe(true);
    expect(screen.getByTestId('billboard-analytics')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Panel anterior' }));
    expect(screen.getByTestId('billboard-wall').classList.contains('hidden')).toBe(false);
  });

  it('prev desde el primer slide da la vuelta al último (índice negativo)', async () => {
    const ahora = Date.now();
    searchEventsMock.mockResolvedValue([
      makeEvento({ id: 'a', lugar: 'X, Chile', hora_utc: new Date(ahora - 10 * 60_000).toISOString() }),
    ]);
    getLiveChannelsMock.mockResolvedValue(NUEVE_CANALES);
    renderOverlay();
    await waitFor(() => expect(screen.getByTestId('spectro-strips')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Modo cartelera' }));
    fireEvent.click(screen.getByRole('button', { name: 'Panel anterior' }));
    expect(screen.getByTestId('billboard-analytics')).toBeTruthy();
  });

  it('Escape con la cartelera abierta cierra la cartelera, no la transmisión', async () => {
    searchEventsMock.mockResolvedValue([]);
    getLiveChannelsMock.mockResolvedValue(NUEVE_CANALES);
    const { onClose } = renderOverlay();
    await waitFor(() => expect(screen.getByTestId('spectro-strips')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Modo cartelera' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('billboard-wall')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('selector de muro', () => {
  const USER_WALL = {
    id: 'w1',
    name: 'Andes',
    layout: {
      columns: [{ groups: [{ title: 'MI GRUPO', channels: [{ channel: 'II.NNA.00.BHZ', label: 'Lima' }] }] }],
      showMetrics: false,
    },
    created_at: '',
    updated_at: '',
  };

  afterEach(() => {
    window.localStorage.clear();
  });

  it('?wall= renderiza el muro del usuario en la cartelera', async () => {
    searchEventsMock.mockResolvedValue([]);
    listWallsMock.mockResolvedValue([USER_WALL]);
    window.history.replaceState(null, '', '?wall=w1');
    renderOverlay();
    fireEvent.click(await screen.findByRole('button', { name: 'Modo cartelera' }));
    await waitFor(() => expect(screen.getByText('MI GRUPO')).toBeTruthy());
    window.history.replaceState(null, '', '/');
  });

  it('un wall id desconocido cae al muro Global', async () => {
    searchEventsMock.mockResolvedValue([]);
    listWallsMock.mockResolvedValue([USER_WALL]);
    window.history.replaceState(null, '', '?wall=fantasma');
    renderOverlay();
    fireEvent.click(await screen.findByRole('button', { name: 'Modo cartelera' }));
    // el muro global mockeado por getGlobalWallMock sigue en pantalla
    await waitFor(() => expect(screen.getByTestId('billboard-wall')).toBeTruthy());
    expect(screen.queryByText('MI GRUPO')).toBeNull();
    window.history.replaceState(null, '', '/');
  });

  it('elegir un muro en la config lo persiste en localStorage', async () => {
    searchEventsMock.mockResolvedValue([]);
    listWallsMock.mockResolvedValue([USER_WALL]);
    renderOverlay();
    fireEvent.click(await screen.findByRole('button', { name: 'Configurar paneles' }));
    const select = await screen.findByRole('combobox', { name: 'Muro' });
    fireEvent.change(select, { target: { value: 'w1' } });
    await waitFor(() => expect(localStorage.getItem('globe.broadcast.wall.v1')).toBe('w1'));
  });
});

describe('foco de eventos', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  // El testid `feed-row-focused` lo introduce Task 6: el sidebar marca con
  // esta fila cuál evento es el spotlight actual.
  it('en modo latest el spotlight es el evento más nuevo', async () => {
    const ahora = Date.now();
    const NEWEST_MOCK_PLACE = 'Nuevo, Japón';
    searchEventsMock.mockResolvedValue([
      makeEvento({
        id: 'viejo',
        lugar: 'Viejo, Chile',
        hora_utc: new Date(ahora - 3 * 60 * 60 * 1000).toISOString(),
      }),
      makeEvento({
        id: 'nuevo',
        lugar: NEWEST_MOCK_PLACE,
        hora_utc: new Date(ahora - 5 * 60 * 1000).toISOString(),
      }),
    ]);
    window.history.replaceState(null, '', '?focus=latest');
    renderOverlay();
    await waitFor(() => {
      expect(screen.getByTestId('feed-row-focused').textContent).toContain(NEWEST_MOCK_PLACE);
    });
    window.history.replaceState(null, '', '/');
  });

  it('arranca con el evento del link como spotlight (Task 3)', async () => {
    const ahora = Date.now();
    const LINK_PLACE = 'Viejo, Chile';
    const eventos = [
      // El más viejo: en modo latest (default) NO es el que ganaría solo.
      makeEvento({
        id: 'viejo',
        lugar: LINK_PLACE,
        hora_utc: new Date(ahora - 3 * 60 * 60 * 1000).toISOString(),
      }),
      makeEvento({
        id: 'nuevo',
        lugar: 'Nuevo, Japón',
        hora_utc: new Date(ahora - 5 * 60 * 1000).toISOString(),
      }),
    ];
    searchEventsMock.mockResolvedValue(eventos);
    renderOverlay({ initialEventId: globePointId(eventos[0]) });
    await waitFor(() => {
      expect(screen.getByTestId('feed-row-focused').textContent).toContain(LINK_PLACE);
    });
  });

  it('sin initialEventId el spotlight lo elige el focusMode (Task 3)', async () => {
    const ahora = Date.now();
    const NEWEST_MOCK_PLACE = 'Nuevo, Japón';
    searchEventsMock.mockResolvedValue([
      makeEvento({
        id: 'viejo',
        lugar: 'Viejo, Chile',
        hora_utc: new Date(ahora - 3 * 60 * 60 * 1000).toISOString(),
      }),
      makeEvento({
        id: 'nuevo',
        lugar: NEWEST_MOCK_PLACE,
        hora_utc: new Date(ahora - 5 * 60 * 1000).toISOString(),
      }),
    ]);
    renderOverlay();
    await waitFor(() => {
      expect(screen.getByTestId('feed-row-focused').textContent).toContain(NEWEST_MOCK_PLACE);
    });
  });

  it('el clic en un evento del globo lo enfoca y resalta en el sidebar', async () => {
    const CLICKED_PLACE = 'Nuevo, Japón';
    searchEventsMock.mockResolvedValue([
      makeEvento({ id: 'viejo', lugar: 'Viejo, Chile' }),
      makeEvento({ id: 'nuevo', lugar: CLICKED_PLACE }),
    ]);
    renderOverlay();
    await waitFor(() => expect(screen.getByTestId('broadcast-feed')).toBeTruthy());

    act(() => (capturedGlobeProps.onEventClick as ((id: string) => void) | undefined)?.('nuevo'));

    await waitFor(() => {
      expect(screen.getByTestId('feed-row-focused').textContent).toContain(CLICKED_PLACE);
    });
  });

  it('el toggle de foco cambia el modo y lo persiste', async () => {
    searchEventsMock.mockResolvedValue([]);
    renderOverlay();
    await waitFor(() => expect(screen.getByTestId('broadcast-feed')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Configurar paneles' }));
    fireEvent.click(screen.getByRole('radio', { name: /latest/i }));
    expect(localStorage.getItem('globe.broadcast.focus.v1')).toBe('latest');
  });

  describe('cadencia del interval en modo random (regresión code review)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('un refetch de SWR (nueva referencia de eventos) NO reinicia el interval de FOCUS_INTERVAL_MS', async () => {
      // Bug real: `eventos` en las deps del efecto del interval hacía que
      // CADA refetch de SWR (cada REFRESH_SECONDS=30s, nueva referencia de
      // array aunque el contenido sea el mismo) desmontara y remontara el
      // timer entero — clearInterval + pick inmediato + setInterval nuevo —
      // también en modo random, cortando la cadencia de FOCUS_INTERVAL_MS
      // (20s). Si esa mutación (volver a poner `eventos` en las deps del
      // interval) se reintroduce, el refetch de t=30s suma un pick extra
      // ahí mismo y este test debe fallar.
      //
      // Cronología esperada con el fix (interval montado en t≈0, cadencia
      // 20s; refetch de SWR en t=30s):
      //   t=0   pick inicial (primeros datos)         → 1
      //   t=15  (antes del interval real)              → sigue en 1
      //   t=20  tick NATURAL del interval de foco       → 2
      //   t=30  refetch de SWR (nueva referencia)       → sigue en 2 (el bug sumaría un 3er pick acá)
      //   t=40  próximo tick natural del interval       → 3
      searchEventsMock.mockResolvedValue([
        makeEvento({ id: 'a' }),
        makeEvento({ id: 'b' }),
        makeEvento({ id: 'c' }),
      ]);
      window.history.replaceState(null, '', '?focus=random');
      renderOverlay();

      // Con fake timers, `waitFor` (que hace polling en tiempo real) no es
      // confiable: se flushean microtasks a mano para dejar que el mock de
      // searchEvents resuelva y los efectos posteriores corran.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId('broadcast-feed')).toBeTruthy();
      expect(pickSpotlightSpy).toHaveBeenCalledTimes(1); // t=0: pick inicial

      await act(async () => {
        vi.advanceTimersByTime(15_000); // t=15s: antes del interval real
      });
      expect(pickSpotlightSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(5_000); // t=20s: tick natural del interval
      });
      expect(pickSpotlightSpy).toHaveBeenCalledTimes(2);

      // Refetch real de SWR en t=30s: nueva ronda de datos. Si el interval
      // dependiera de `eventos`, este refetch por sí solo reiniciaría el
      // timer y dispararía un pick inmediato — el conteo saltaría a 3 acá,
      // 10s antes del próximo tick natural (t=40s).
      await act(async () => {
        vi.advanceTimersByTime(10_000); // t=30s: refetch de SWR
      });
      expect(searchEventsMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(pickSpotlightSpy).toHaveBeenCalledTimes(2);

      await act(async () => {
        vi.advanceTimersByTime(10_000); // t=40s: próximo tick natural
      });
      expect(pickSpotlightSpy).toHaveBeenCalledTimes(3);

      window.history.replaceState(null, '', '/');
    });
  });

  describe('encuadre por área activa', () => {
    // Los Andes: área real del proyecto, angosta en longitud y larga en
    // latitud, así que el centro y la altitud que se derivan son distinguibles
    // de cualquier default global.
    function andesArea() {
      return {
        area: {
          id: 'area-andes',
          slug: 'andes',
          name: 'Andes',
          is_system: true,
          geometry: {
            type: 'Polygon' as const,
            coordinates: [
              [
                [-75, -55],
                [-65, -55],
                [-65, -15],
                [-75, -15],
                [-75, -55],
              ],
            ],
          },
          bbox: { minlat: -55, maxlat: -15, minlon: -75, maxlon: -65 },
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
        is_default: false,
      };
    }

    // Cascadia: otra área real del proyecto, con centro bien distinto al de
    // los Andes — sirve para distinguir "sigue mostrando el foco viejo" de
    // "se reencuadró de verdad" tras un cambio de área.
    function cascadiaArea() {
      return {
        area: {
          id: 'area-cascadia',
          slug: 'cascadia',
          name: 'Cascadia',
          is_system: true,
          geometry: {
            type: 'Polygon' as const,
            coordinates: [
              [
                [-128, 40],
                [-120, 40],
                [-120, 50],
                [-128, 50],
                [-128, 40],
              ],
            ],
          },
          bbox: { minlat: 40, maxlat: 50, minlon: -128, maxlon: -120 },
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
        is_default: false,
      };
    }

    it('le pasa al globo el foco del área activa', async () => {
      // El bug: el overlay se montaba sin focusArea, así que en transmisión
      // cambiar de área no movía la cámara. SeismicGlobe ya sabe convivir con
      // spotlight (se abstiene mientras isAreaAnimating) — sólo faltaba el dato.
      searchEventsMock.mockResolvedValue([]);
      getActiveAreaMock.mockResolvedValue(andesArea());

      renderOverlay();

      await waitFor(() => expect(capturedGlobeProps.focusArea).toBeTruthy());

      const focus = capturedGlobeProps.focusArea as {
        lat: number;
        lng: number;
        altitude: number;
      };
      // Centro del bbox de los Andes, no el (0,0) del default global.
      expect(focus.lat).toBeCloseTo(-35, 5);
      expect(focus.lng).toBeCloseTo(-70, 5);
      // Altitud proporcional al lado más largo (40° de latitud), dentro del
      // rango que declara globeFocusFromBounds.
      expect(focus.altitude).toBeGreaterThan(1.4);
      expect(focus.altitude).toBeLessThan(2.8);
    });

    it('sin área resuelta no fuerza ningún foco', async () => {
      // Un anónimo sin sesión, o /areas/active caído: la transmisión sigue
      // andando con el globo libre en vez de romperse o clavarse en (0,0).
      searchEventsMock.mockResolvedValue([]);
      getActiveAreaMock.mockResolvedValue(null);

      renderOverlay();

      await waitFor(() => expect(searchEventsMock).toHaveBeenCalled());
      expect(capturedGlobeProps.focusArea ?? null).toBeNull();
    });

    it('reencuadra la camara al cambiar de area, sin recargar la pagina', async () => {
      // Residual de 50632ee: el overlay leía /areas/active por SWR pero no se
      // suscribía al evento, así que en /globe (donde nadie más monta esa
      // key) la cámara no se movía hasta que SWR revalidara por su cuenta.
      searchEventsMock.mockResolvedValue([]);
      getActiveAreaMock.mockResolvedValue(andesArea());

      renderOverlay();

      await waitFor(() => expect(capturedGlobeProps.focusArea).toBeTruthy());
      const andesFocus = capturedGlobeProps.focusArea as { lat: number; lng: number };
      expect(andesFocus.lat).toBeCloseTo(-35, 5);

      getActiveAreaMock.mockResolvedValue(cascadiaArea());
      act(() => {
        window.dispatchEvent(new CustomEvent(AREA_CHANGED_EVENT));
      });

      await waitFor(
        () => {
          const focus = capturedGlobeProps.focusArea as { lat: number; lng: number };
          expect(focus.lat).toBeCloseTo(45, 5);
        },
        { timeout: 2000 }
      );
    });
  });
});

/**
 * Los contadores en 0 con la lista llena (reporte del usuario, 2026-08-23).
 *
 * La pantalla mostraba `0` y no `—`, o sea que el fetch RESOLVIÓ con datos:
 * el problema no era la petición sino el `now` contra el que se comparan.
 * `statsNow` arranca en null y el fallback era `new Date(0)` — el 1 de enero
 * de 1970 —, así que ningún evento caía dentro de "últimas 24 h".
 */
describe('estadísticas de la cartelera', () => {
  it('cuenta los eventos recibidos en vez de mostrar 0', async () => {
    const eventos = [
      makeEvento({ id: 'a', hora_utc: new Date(Date.now() - 30 * 60 * 1000).toISOString() }),
      makeEvento({ id: 'b', hora_utc: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }),
      makeEvento({ id: 'c', hora_utc: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() }),
    ];
    searchEventsMock.mockResolvedValue(eventos);
    renderOverlay();

    await waitFor(() => {
      expect(searchEventsMock).toHaveBeenCalled();
    });

    // El contador de ÚLTIMAS 24 H tiene que reflejar los 3 eventos. Con el
    // fallback a 1970 quedaba en 0 pese a tener la lista entera cargada.
    // Se ancla en la etiqueta y se lee su hermano: buscar un "3" suelto
    // engancharía cualquier otro número de la cartelera.
    await waitFor(() => {
      const label = screen.getByText(es.globe.broadcast.last24h);
      expect(label.parentElement?.textContent).toContain('3');
    });
  });

  it('no cuenta eventos anteriores a la ventana de 24 h', async () => {
    searchEventsMock.mockResolvedValue([
      makeEvento({ id: 'viejo', hora_utc: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() }),
    ]);
    renderOverlay();

    await waitFor(() => {
      expect(searchEventsMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      const label = screen.getByText(es.globe.broadcast.last24h);
      expect(label.parentElement?.textContent).toContain('0');
    });
  });
});

/**
 * El globo se montaba pelado mientras cargaba: `eventos ?? []` colapsa
 * "todavía no llegó" y "no hubo sismos" en el mismo valor, así que la Tierra
 * giraba sin puntos y el feed quedaba vacío, sin decir cuál de las dos cosas
 * estaba pasando (pedido del usuario, 2026-08-24).
 */
describe('estado de carga del feed', () => {
  it('avisa que está cargando en vez de mostrar el feed vacío', async () => {
    // Promesa que no resuelve: deja la vista en el estado de carga.
    searchEventsMock.mockReturnValue(new Promise(() => {}));
    renderOverlay();

    await waitFor(() => {
      expect(screen.getByText(es.globe.broadcast.loadingEvents)).toBeTruthy();
    });
  });

  it('distingue "sin sismos" de "cargando" cuando la respuesta viene vacía', async () => {
    searchEventsMock.mockResolvedValue([]);
    renderOverlay();

    await waitFor(() => {
      expect(screen.getByText(es.globe.broadcast.noEvents)).toBeTruthy();
    });
    expect(screen.queryByText(es.globe.broadcast.loadingEvents)).toBeNull();
  });

  it('no muestra ningún cartel cuando hay eventos', async () => {
    searchEventsMock.mockResolvedValue([makeEvento({ id: 'a' })]);
    renderOverlay();

    await waitFor(() => {
      expect(searchEventsMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByText(es.globe.broadcast.loadingEvents)).toBeNull();
    });
    expect(screen.queryByText(es.globe.broadcast.noEvents)).toBeNull();
  });
});

/**
 * Los contadores en 0 con la lista llena (reporte del usuario, 2026-08-23).
 *
 * La pantalla mostraba `0` y no `—`, o sea que el fetch RESOLVIÓ con datos:
 * el problema no era la petición sino el `now` contra el que se comparan.
 * `statsNow` arranca en null y el fallback era `new Date(0)` — el 1 de enero
 * de 1970 —, así que ningún evento caía dentro de "últimas 24 h".
 */
describe('estadísticas de la cartelera', () => {
  it('cuenta los eventos recibidos en vez de mostrar 0', async () => {
    const eventos = [
      makeEvento({ id: 'a', hora_utc: new Date(Date.now() - 30 * 60 * 1000).toISOString() }),
      makeEvento({ id: 'b', hora_utc: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }),
      makeEvento({ id: 'c', hora_utc: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() }),
    ];
    searchEventsMock.mockResolvedValue(eventos);
    renderOverlay();

    await waitFor(() => {
      expect(searchEventsMock).toHaveBeenCalled();
    });

    // El contador de ÚLTIMAS 24 H tiene que reflejar los 3 eventos. Con el
    // fallback a 1970 quedaba en 0 pese a tener la lista entera cargada.
    // Se ancla en la etiqueta y se lee su hermano: buscar un "3" suelto
    // engancharía cualquier otro número de la cartelera.
    await waitFor(() => {
      const label = screen.getByText(es.globe.broadcast.last24h);
      expect(label.parentElement?.textContent).toContain('3');
    });
  });

  it('no cuenta eventos anteriores a la ventana de 24 h', async () => {
    searchEventsMock.mockResolvedValue([
      makeEvento({ id: 'viejo', hora_utc: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() }),
    ]);
    renderOverlay();

    await waitFor(() => {
      expect(searchEventsMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      const label = screen.getByText(es.globe.broadcast.last24h);
      expect(label.parentElement?.textContent).toContain('0');
    });
  });
});

/**
 * El globo se montaba pelado mientras cargaba: `eventos ?? []` colapsa
 * "todavía no llegó" y "no hubo sismos" en el mismo valor, así que la Tierra
 * giraba sin puntos y el feed quedaba vacío, sin decir cuál de las dos cosas
 * estaba pasando (pedido del usuario, 2026-08-24).
 */
describe('estado de carga del feed', () => {
  it('avisa que está cargando en vez de mostrar el feed vacío', async () => {
    // Promesa que no resuelve: deja la vista en el estado de carga.
    searchEventsMock.mockReturnValue(new Promise(() => {}));
    renderOverlay();

    await waitFor(() => {
      expect(screen.getByText(es.globe.broadcast.loadingEvents)).toBeTruthy();
    });
  });

  it('distingue "sin sismos" de "cargando" cuando la respuesta viene vacía', async () => {
    searchEventsMock.mockResolvedValue([]);
    renderOverlay();

    await waitFor(() => {
      expect(screen.getByText(es.globe.broadcast.noEvents)).toBeTruthy();
    });
    expect(screen.queryByText(es.globe.broadcast.loadingEvents)).toBeNull();
  });

  it('no muestra ningún cartel cuando hay eventos', async () => {
    searchEventsMock.mockResolvedValue([makeEvento({ id: 'a' })]);
    renderOverlay();

    await waitFor(() => {
      expect(searchEventsMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByText(es.globe.broadcast.loadingEvents)).toBeNull();
    });
    expect(screen.queryByText(es.globe.broadcast.noEvents)).toBeNull();
  });
});
