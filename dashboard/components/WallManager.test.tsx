import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import es from '@/messages/es.json';
import { ApiStatusError } from '@/lib/auth';
import { WallManager } from './WallManager';

const LAYOUT = {
  columns: [{ groups: [{ title: 'ASIA', channels: [{ channel: 'IU.MAJO.00.BHZ', label: 'Tokyo' }] }] }],
  showMetrics: false,
};

const { wallsMock, apiMock } = vi.hoisted(() => ({
  wallsMock: {
    listWalls: vi.fn(),
    createWall: vi.fn(),
    updateWall: vi.fn(),
    deleteWall: vi.fn(),
  },
  apiMock: {
    getGlobalWall: vi.fn(),
    getLiveChannels: vi.fn(),
    getStationCatalog: vi.fn(),
  },
}));

vi.mock('@/lib/walls', () => wallsMock);
vi.mock('@/lib/api', () => ({ seismicAPI: apiMock }));
vi.mock('./SpectronetWall', () => ({
  SpectronetWall: ({ wall }: { wall: { name: string } }) => (
    <div data-testid="preview-wall">{wall.name}</div>
  ),
}));

function renderManager() {
  render(
    <NextIntlClientProvider locale="es-AR" messages={es}>
      <SWRConfig value={{ provider: () => new Map() }}>
        <WallManager />
      </SWRConfig>
    </NextIntlClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Entradas del catálogo completo de subestaciones (PR-W3). */
const CATALOG = [
  {
    channel: 'IU.MAJO.00.BHZ',
    city_id: 'tokyo',
    network: 'IU',
    station: 'MAJO',
    is_live: true,
    is_primary: true,
  },
];

function arrange(walls: unknown[] | null = [], catalog: unknown[] = CATALOG) {
  wallsMock.listWalls.mockResolvedValue(walls);
  apiMock.getGlobalWall.mockResolvedValue({ id: 'global', name: 'Global', layout: LAYOUT });
  apiMock.getStationCatalog.mockResolvedValue(catalog);
}

describe('WallManager', () => {
  it('lista los muros del usuario y muestra la preview del seleccionado', async () => {
    arrange([{ id: 'w1', name: 'Andes', layout: LAYOUT, created_at: '', updated_at: '' }]);
    renderManager();
    await waitFor(() => expect(screen.getByText('Andes')).toBeTruthy());
    fireEvent.click(screen.getByText('Andes'));
    await waitFor(() => expect(screen.getByTestId('preview-wall').textContent).toBe('Andes'));
  });

  it('guarda un muro nuevo con createWall', async () => {
    arrange([]);
    wallsMock.createWall.mockResolvedValue({ id: 'w9', name: 'Nuevo', layout: LAYOUT, created_at: '', updated_at: '' });
    renderManager();
    await waitFor(() => expect(wallsMock.listWalls).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText('Mi muro'), { target: { value: 'Nuevo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() =>
      expect(wallsMock.createWall).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Nuevo' })
      )
    );
  });

  it('un 409 muestra el error de nombre duplicado', async () => {
    arrange([]);
    wallsMock.createWall.mockRejectedValue(new ApiStatusError(409, 'conflict'));
    renderManager();
    await waitFor(() => expect(wallsMock.listWalls).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText('Mi muro'), { target: { value: 'Repetido' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(screen.getByText('Ya tenés un muro con ese nombre')).toBeTruthy());
  });

  it('sin sesión (listWalls null) muestra el aviso y deshabilita guardar', async () => {
    arrange(null);
    renderManager();
    await waitFor(() => expect(screen.getByText('Iniciá sesión para guardar muros')).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Guardar' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('duplicar el muro Global precarga su layout con nombre "Global (copia)"', async () => {
    arrange([]);
    renderManager();
    await waitFor(() => expect(apiMock.getGlobalWall).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Duplicar' }));
    await waitFor(() =>
      expect((screen.getByPlaceholderText('Mi muro') as HTMLInputElement).value).toBe('Global (copia)')
    );
  });

  it('createWall devuelve null (401) => avisa sesión vencida, NO "Guardado"', async () => {
    arrange([]);
    wallsMock.createWall.mockResolvedValue(null);
    renderManager();
    await waitFor(() => expect(wallsMock.listWalls).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText('Mi muro'), { target: { value: 'Nuevo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(screen.getByText('Iniciá sesión para guardar muros')).toBeTruthy());
    expect(screen.queryByText('Guardado')).toBeNull();
    // Tampoco revalidó la lista: no hubo persistencia real.
    expect(wallsMock.listWalls).toHaveBeenCalledTimes(1);
  });

  it('deleteWall devuelve false (401) => avisa sesión vencida y preserva la selección', async () => {
    arrange([{ id: 'w1', name: 'Andes', layout: LAYOUT, created_at: '', updated_at: '' }]);
    wallsMock.deleteWall.mockResolvedValue(false);
    renderManager();
    await waitFor(() => expect(screen.getByText('Andes')).toBeTruthy());
    fireEvent.click(screen.getByText('Andes'));
    await waitFor(() =>
      expect((screen.getByPlaceholderText('Mi muro') as HTMLInputElement).value).toBe('Andes')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar muro' }));
    await waitFor(() => expect(screen.getByText('Iniciá sesión para guardar muros')).toBeTruthy());
    // El muro sigue seleccionado y la lista no se revalidó (mismo criterio
    // que el fallo por excepción, más abajo).
    expect(screen.getByRole('button', { name: 'Eliminar muro' })).toBeTruthy();
    expect(wallsMock.listWalls).toHaveBeenCalledTimes(1);
  });

  it('un fallo al borrar muestra el error y no resetea la selección', async () => {
    arrange([{ id: 'w1', name: 'Andes', layout: LAYOUT, created_at: '', updated_at: '' }]);
    wallsMock.deleteWall.mockRejectedValue(new ApiStatusError(500, 'boom'));
    renderManager();
    await waitFor(() => expect(screen.getByText('Andes')).toBeTruthy());
    fireEvent.click(screen.getByText('Andes'));
    await waitFor(() =>
      expect((screen.getByPlaceholderText('Mi muro') as HTMLInputElement).value).toBe('Andes')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar muro' }));
    await waitFor(() => expect(screen.getByText('No se pudo guardar el muro')).toBeTruthy());
    // El muro sigue seleccionado: el botón Eliminar (solo visible con una
    // selección != 'new') sigue en pantalla y listWalls no se revalidó.
    expect(screen.getByRole('button', { name: 'Eliminar muro' })).toBeTruthy();
    expect(wallsMock.listWalls).toHaveBeenCalledTimes(1);
  });

  // --- catálogo completo de subestaciones (PR-W3) -------------------------
  const SANTIAGO_CATALOG = [
    {
      channel: 'C1.MT05..BHZ',
      city_id: 'santiago',
      network: 'C1',
      station: 'MT05',
      is_live: true,
      is_primary: true,
    },
    {
      channel: 'C1.MT14..BHZ',
      city_id: 'santiago',
      network: 'C1',
      station: 'MT14',
      is_live: false,
      is_primary: false,
    },
  ];

  /** Filas del catálogo del armador que mencionan una estación. "MT05"
   * aparece dos veces por fila (label y SCNL), así que se cuentan filas. */
  const catalogRowsWith = (station: RegExp) =>
    Array.from(
      screen.getByTestId('wall-catalog').querySelectorAll('li')
    ).filter((li) => station.test(li.textContent ?? ''));

  it('el catálogo ofrece las subestaciones, no solo una por ciudad', async () => {
    arrange([], SANTIAGO_CATALOG);
    renderManager();
    await waitFor(() => expect(apiMock.getStationCatalog).toHaveBeenCalled());

    await waitFor(() => expect(catalogRowsWith(/MT05/)).toHaveLength(1));
    expect(catalogRowsWith(/MT14/)).toHaveLength(1);
  });

  it('el buscador filtra por código de estación, no solo por ciudad', async () => {
    arrange([], SANTIAGO_CATALOG);
    renderManager();
    await waitFor(() => expect(catalogRowsWith(/MT05/)).toHaveLength(1));

    fireEvent.change(screen.getByPlaceholderText(/buscar/i), {
      target: { value: 'MT14' },
    });

    expect(catalogRowsWith(/MT05/)).toHaveLength(0);
    expect(catalogRowsWith(/MT14/)).toHaveLength(1);
  });

  it('un muro guardado conserva SU label, no el del catálogo nuevo', async () => {
    // Anti-regresión: el catálogo ahora etiqueta "Tokyo · MAJO", pero un muro
    // ya persistido guarda "Tokyo" a secas. Cargarlo NO debe reescribir el
    // label guardado — el usuario nombró sus tiras y el catálogo no manda.
    arrange([{ id: 'w1', name: 'Andes', layout: LAYOUT, created_at: '', updated_at: '' }]);
    renderManager();
    await waitFor(() => expect(screen.getByText('Andes')).toBeTruthy());
    fireEvent.click(screen.getByText('Andes'));

    await waitFor(() =>
      expect((screen.getByPlaceholderText('Mi muro') as HTMLInputElement).value).toBe('Andes')
    );
    const rows = screen.getAllByTestId('builder-channel-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Tokyo');
    expect(rows[0].textContent).not.toContain('MAJO');
  });
});
