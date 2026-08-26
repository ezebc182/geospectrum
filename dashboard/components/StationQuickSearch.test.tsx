/**
 * Buscador rápido del header: filtra el catálogo en memoria y navega por
 * Link. El dropdown de Radix se abre por teclado (jsdom-estable).
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import { seismicAPI } from '@/lib/api';
import { StationQuickSearch } from './StationQuickSearch';

vi.mock('@/lib/api', () => ({
  seismicAPI: { getStationCatalog: vi.fn() },
}));

const CATALOG = [
  {
    channel: 'IU.MAJO.00.BHZ',
    city_id: 'tokyo',
    network: 'IU',
    station: 'MAJO',
    is_live: true,
    is_primary: true,
  },
  {
    channel: 'CI.USC..BHZ',
    city_id: 'los-angeles',
    network: 'CI',
    station: 'USC',
    is_live: false,
    is_primary: true,
  },
];

function renderQuickSearch() {
  vi.mocked(seismicAPI.getStationCatalog).mockResolvedValue(CATALOG as never);
  return render(
    <NextIntlClientProvider locale="es-AR" messages={es} timeZone="UTC">
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <StationQuickSearch />
      </SWRConfig>
    </NextIntlClientProvider>,
  );
}

async function openMenu() {
  const trigger = screen.getByLabelText('Buscar estación para navegar');
  fireEvent.keyDown(trigger, { key: 'Enter' });
  await waitFor(() => expect(screen.getByTestId('quick-search-results')).toBeTruthy());
}

afterEach(() => {
  cleanup();
  vi.mocked(seismicAPI.getStationCatalog).mockReset();
});

describe('StationQuickSearch', () => {
  it('lista el catálogo y cada fila navega al detalle de la estación', async () => {
    renderQuickSearch();
    await openMenu();

    const majo = screen.getByText('IU.MAJO.00.BHZ').closest('a');
    // El SCNL viaja URL-encoded: los puntos del código van escapados.
    expect(majo?.getAttribute('href')).toBe('/stations/IU.MAJO.00.BHZ');
  });

  it('el filtro reduce las filas en memoria, sin salir a la red', async () => {
    renderQuickSearch();
    await openMenu();

    fireEvent.change(screen.getByLabelText('Filtrar estaciones del catálogo'), {
      target: { value: 'usc' },
    });

    expect(screen.getByText('CI.USC..BHZ')).toBeTruthy();
    expect(screen.queryByText('IU.MAJO.00.BHZ')).toBeNull();
    // Una sola llamada: la del catálogo. Filtrar no dispara fetches.
    expect(seismicAPI.getStationCatalog).toHaveBeenCalledTimes(1);
  });

  it('sin coincidencias lo dice, y el pie SIEMPRE lleva a la búsqueda completa', async () => {
    renderQuickSearch();
    await openMenu();

    fireEvent.change(screen.getByLabelText('Filtrar estaciones del catálogo'), {
      target: { value: 'nevado' },
    });

    expect(screen.getByText('Sin coincidencias en el catálogo')).toBeTruthy();
    const full = screen.getByText('Búsqueda completa de estaciones…').closest('a');
    expect(full?.getAttribute('href')).toBe('/stations');
  });
});
