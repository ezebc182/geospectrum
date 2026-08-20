import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { SWRConfig } from 'swr';

import es from '@/messages/es.json';
import type { SeismicEvent } from '@/lib/types';
import { GlobeBroadcastOverlay } from './GlobeBroadcastOverlay';

const { searchEventsMock } = vi.hoisted(() => ({ searchEventsMock: vi.fn() }));
vi.mock('@/lib/api', () => ({ seismicAPI: { searchEvents: searchEventsMock } }));

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

  it('cierra con Escape y con el botón de salir', async () => {
    searchEventsMock.mockResolvedValue([]);
    const onClose = renderOverlay();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Salir del modo transmisión' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
