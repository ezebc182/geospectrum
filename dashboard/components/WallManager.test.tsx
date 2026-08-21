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

function arrange(walls: unknown[] | null = []) {
  wallsMock.listWalls.mockResolvedValue(walls);
  apiMock.getGlobalWall.mockResolvedValue({ id: 'global', name: 'Global', layout: LAYOUT });
  apiMock.getLiveChannels.mockResolvedValue([{ city_id: 'tokyo', channel: 'IU.MAJO.00.BHZ' }]);
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
});
