/**
 * /globe es siempre modo transmisión: no queda un "globo pelado" al que
 * volver. El overlay es el único estado de la página, con o sin ?event=,
 * embebido por default (decisión 2026-09-04) o en pantalla completa tras
 * expandir — nunca desaparece del árbol para volver a un componente distinto.
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

// El mock recibe las props reales: un mock que ignora `fullscreen` no
// distinguiría el default embebido del default fullscreen (lo que pasó acá
// hasta el cambio de 2026-09-04 — los tres tests de abajo pasaban igual con
// cualquiera de los dos).
vi.mock('@/components/GlobeBroadcastOverlay', () => ({
  GlobeBroadcastOverlay: ({ fullscreen }: { fullscreen: boolean }) => (
    <div data-testid="broadcast-overlay" data-fullscreen={fullscreen} />
  ),
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
  it('el overlay es el unico estado de la pagina', async () => {
    renderPage();
    expect(await screen.findByTestId('broadcast-overlay')).toBeTruthy();
  });

  it('arranca embebido (fullscreen=false), no en pantalla completa', async () => {
    renderPage();
    const overlay = await screen.findByTestId('broadcast-overlay');
    expect(overlay).toHaveAttribute('data-fullscreen', 'false');
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
