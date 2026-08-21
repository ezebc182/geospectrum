import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { SWRConfig } from 'swr';

import es from '@/messages/es.json';
import type { SeismicEvent } from '@/lib/types';
import { GlobeBroadcastOverlay } from './GlobeBroadcastOverlay';

const { searchEventsMock, getLiveChannelsMock, getGlobalWallMock } = vi.hoisted(() => ({
  searchEventsMock: vi.fn(),
  getLiveChannelsMock: vi.fn(),
  getGlobalWallMock: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  seismicAPI: {
    searchEvents: searchEventsMock,
    getLiveChannels: getLiveChannelsMock,
    getGlobalWall: getGlobalWallMock,
  },
}));

// SeismicGlobe usa WebGL: en jsdom se stubbea (mismo criterio que el resto
// del repo, la lógica del globo se testea en lib/globe-data.test.ts).
vi.mock('@/components/SeismicGlobe', () => ({
  SeismicGlobe: () => null,
}));

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

function renderOverlay(onClose = vi.fn()) {
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
  render(
    <NextIntlClientProvider locale="es-AR" messages={es}>
      {/* Caché de SWR fresco por test: la clave 'broadcast-events' es la
          misma en todos y el caché de módulo filtraría datos entre tests. */}
      <SWRConfig value={{ provider: () => new Map() }}>
        <GlobeBroadcastOverlay onClose={onClose} />
      </SWRConfig>
    </NextIntlClientProvider>
  );
  return onClose;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
    const onClose = renderOverlay();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Salir del modo transmisión' }));
    expect(onClose).toHaveBeenCalledTimes(2);
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
    const onClose = renderOverlay();
    await waitFor(() => expect(screen.getByTestId('spectro-strips')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Modo cartelera' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('billboard-wall')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
