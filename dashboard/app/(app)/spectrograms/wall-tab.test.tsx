/**
 * Pestaña "Muro" de /spectrograms (PR-W2): la vista de tarjetas es el
 * default y la pestaña Muro monta WallManager solo cuando ?tab=wall.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import es from '@/messages/es.json';
import SpectrogramsLivePage from './page';

const { searchParamsMock, routerMock, pathnameMock } = vi.hoisted(() => ({
  // Referencias ESTABLES (trampa documentada del repo: un mock de router con
  // identidad inestable en deps cuelga vitest — ver globe/broadcast-default.test.tsx).
  searchParamsMock: { current: new URLSearchParams() },
  routerMock: { replace: vi.fn() },
  pathnameMock: { current: '/spectrograms' },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParamsMock.current,
  useRouter: () => routerMock,
  usePathname: () => pathnameMock.current,
}));

vi.mock('@/lib/api', () => ({
  seismicAPI: {
    getLiveChannels: vi.fn().mockResolvedValue([]),
    // Con ?tab=cards por defecto se montan las 12 tarjetas iniciales
    // (SortableSpectrogramCard → SpectrogramViewReal); se mockea para no
    // ensuciar la salida del test con fetches reales sin resolver.
    getSpectrogram: vi.fn().mockResolvedValue({ success: false, image: null, metadata: null }),
  },
}));

vi.mock('@/components/WallManager', () => ({
  WallManager: () => <div data-testid="wall-manager" />,
}));

function renderPage() {
  render(
    <NextIntlClientProvider locale="es-AR" messages={es}>
      <SpectrogramsLivePage />
    </NextIntlClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  searchParamsMock.current = new URLSearchParams();
});

describe('SpectrogramsLivePage — pestaña Muro', () => {
  it('sin query muestra la vista de tarjetas (sin WallManager)', async () => {
    renderPage();
    // getLiveChannels() resuelve async — se espera el asentamiento para que
    // el setState post-render quede envuelto en act() (evita el warning).
    await waitFor(() => expect(screen.queryByTestId('wall-manager')).toBeNull());
  });

  it('con ?tab=wall monta el WallManager', async () => {
    searchParamsMock.current = new URLSearchParams('tab=wall');
    renderPage();
    await waitFor(() => expect(screen.getByTestId('wall-manager')).toBeTruthy());
  });
});
