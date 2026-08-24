/**
 * Título visible de /spectrograms (C1: la pantalla se renombró de
 * "spectrograms-live" a "spectrograms" y el título pasó a "Espectrogramas").
 * Nadie cubría el texto literal — una mutación de charts.spectrogramsPage.title
 * no hacía fallar ningún test existente (ver task-C1-report.md, fix round 1).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import es from '@/messages/es.json';
import en from '@/messages/en.json';
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
    getSpectrogram: vi.fn().mockResolvedValue({ success: false, image: null, metadata: null }),
  },
}));

function renderPage(locale: 'es-AR' | 'en', messages: typeof es | typeof en) {
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <SpectrogramsLivePage />
    </NextIntlClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  searchParamsMock.current = new URLSearchParams();
});

describe('SpectrogramsLivePage — título', () => {
  it('muestra "Espectrogramas" en es', async () => {
    renderPage('es-AR', es);
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Espectrogramas' })).toBeTruthy()
    );
  });

  it('muestra "Spectrograms" en en', async () => {
    renderPage('en', en);
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Spectrograms' })).toBeTruthy()
    );
  });
});
