/**
 * /globe es siempre modo transmisión: no queda un "globo pelado" al que
 * volver. El overlay es el único estado de la página, con o sin ?event=.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import es from '@/messages/es.json';
import { EVENT_PARAM } from '@/lib/share-event';
import GlobePage from './page';

const { searchParamsMock } = vi.hoisted(() => ({
  // Referencia ESTABLE (trampa documentada del repo: un mock de router con
  // identidad inestable en deps cuelga vitest).
  searchParamsMock: { current: new URLSearchParams() },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParamsMock.current,
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
  it('el overlay es el unico estado de la pagina', () => {
    renderPage();
    expect(screen.getByTestId('broadcast-overlay')).toBeTruthy();
  });

  it('tambien con ?event= en la URL', () => {
    searchParamsMock.current = new URLSearchParams(`${EVENT_PARAM}=algun-evento`);
    renderPage();
    expect(screen.getByTestId('broadcast-overlay')).toBeTruthy();
  });

  it('ya no hay boton de entrar a transmision', () => {
    renderPage();
    expect(screen.queryByRole('button', { name: /transmisi/i })).toBeNull();
  });
});
