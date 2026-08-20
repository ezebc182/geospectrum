/**
 * /globe arranca directamente en modo transmisión (pedido 2026-08-20: la
 * página-vestíbulo con un botón no tenía sentido). Excepción: un link
 * compartido con ?event= abre ESE evento, no la transmisión.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import es from '@/messages/es.json';
import GlobePage from './page';

const { searchParamsMock } = vi.hoisted(() => ({
  // Referencia ESTABLE (trampa documentada del repo: un mock de router con
  // identidad inestable en deps cuelga vitest).
  searchParamsMock: { current: new URLSearchParams() },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParamsMock.current,
}));

vi.mock('@/lib/api', () => ({
  reportFetcher: vi.fn().mockResolvedValue({ eventos: [] }),
  seismicAPI: { searchEvents: vi.fn().mockResolvedValue([]), getLiveChannels: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@/lib/areas', () => ({
  getActiveArea: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/use-area-refresh', () => ({
  useAreaRefresh: () => false,
}));

vi.mock('@/components/SeismicGlobe', () => ({ SeismicGlobe: () => null }));
vi.mock('@/components/GlobeEventPanel', () => ({ GlobeEventPanel: () => null }));
vi.mock('@/components/AreaRefreshIndicator', () => ({
  AreaRefreshIndicator: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/GlobeBroadcastOverlay', () => ({
  GlobeBroadcastOverlay: () => <div data-testid="broadcast-overlay" />,
}));

function renderPage() {
  render(
    <NextIntlClientProvider locale="es-AR" messages={es}>
      <GlobePage />
    </NextIntlClientProvider>
  );
}

afterEach(() => {
  cleanup();
  searchParamsMock.current = new URLSearchParams();
});

describe('GlobePage', () => {
  it('arranca directamente en modo transmisión', () => {
    renderPage();
    expect(screen.getByTestId('broadcast-overlay')).toBeTruthy();
  });

  it('con ?event= NO abre la transmisión: el link compartido manda', () => {
    searchParamsMock.current = new URLSearchParams('event=usgs-abc123');
    renderPage();
    expect(screen.queryByTestId('broadcast-overlay')).toBeNull();
  });
});
