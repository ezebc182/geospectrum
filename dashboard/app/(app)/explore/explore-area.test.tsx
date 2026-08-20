/**
 * El Explorador debe reaccionar al selector de área global del header.
 *
 * El bug (2026-08-20): cambiar la región no actualizaba NADA — ninguna línea
 * del Explorador escuchaba el evento de área. El Dashboard sí (useAreaRefresh),
 * y el usuario espera coherencia: cambiar de región re-busca recortado al
 * bbox del área nueva y refleja ese bbox en los filtros.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import { emitAreaChanged } from '@/lib/area-events';

const { searchMock, getActiveAreaMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
  getActiveAreaMock: vi.fn(),
}));

vi.mock('@/components/AdvancedSeismicMap', () => ({
  AdvancedSeismicMap: () => <div data-testid="mapa" />,
}));

vi.mock('@/lib/api', () => ({
  seismicAPI: { searchEvents: searchMock },
}));

vi.mock('@/lib/areas', () => ({
  getActiveArea: getActiveAreaMock,
}));

import ExplorePage from './page';

const AREA_CHILE = {
  area: {
    id: 'a1',
    slug: 'chile',
    name: 'Chile',
    is_system: true,
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [-72, -35],
          [-68, -35],
          [-68, -30],
          [-72, -30],
          [-72, -35],
        ] as [number, number][],
      ],
    },
    bbox: { minlat: -35, maxlat: -30, minlon: -72, maxlon: -68 },
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  },
  is_default: false,
};

function renderExplore() {
  return render(
    <NextIntlClientProvider locale="es" messages={es}>
      <ExplorePage />
    </NextIntlClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Explorador y área activa', () => {
  it('al cambiar el área re-busca recortado al bbox del área nueva', async () => {
    searchMock.mockResolvedValue([]);
    getActiveAreaMock.mockResolvedValue(AREA_CHILE);
    renderExplore();

    act(() => {
      emitAreaChanged();
    });

    await waitFor(() =>
      expect(searchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          minLat: -35,
          maxLat: -30,
          minLon: -72,
          maxLon: -68,
        })
      )
    );
  });

  it('volver al área por defecto re-busca sin recorte geográfico', async () => {
    searchMock.mockResolvedValue([]);
    // is_default=true: el usuario NO eligió área — el Explorador vuelve a ser
    // global, no queda clavado en el bbox del área anterior.
    getActiveAreaMock.mockResolvedValue({ ...AREA_CHILE, is_default: true });
    renderExplore();

    act(() => {
      emitAreaChanged();
    });

    await waitFor(() => expect(searchMock).toHaveBeenCalled());
    const params = searchMock.mock.calls[0][0];
    expect(params.minLat).toBeUndefined();
    expect(params.maxLat).toBeUndefined();
    expect(params.minLon).toBeUndefined();
    expect(params.maxLon).toBeUndefined();
  });
});
