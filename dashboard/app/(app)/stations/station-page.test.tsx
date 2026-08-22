/**
 * Página de detalle de estación (PR A: sólo la pestaña Helicorder viva).
 *
 * Usa `NextIntlClientProvider` con los mensajes REALES en vez de mockear
 * `useTranslations`: así el test falla si una clave i18n no existe. Con el
 * mock de identidad (`(k) => k`) cualquier clave inventada pasaría.
 *
 * El mock de `next/navigation` devuelve la MISMA referencia siempre — un
 * objeto nuevo por render cuelga vitest (lección del proyecto).
 */

import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import en from '@/messages/en.json';

const { paramsMock } = vi.hoisted(() => ({
  paramsMock: { channel: 'IU.MAJO..BHZ' },
}));

vi.mock('next/navigation', () => ({
  useParams: () => paramsMock,
}));

vi.mock('@/components/HelicorderCanvas', () => ({
  HelicorderCanvas: ({ channel }: { channel: string }) => (
    <div data-testid="helicorder-canvas" data-channel={channel} />
  ),
}));

import StationPage from './[channel]/page';

function renderPage(locale: 'es-AR' | 'en-US' = 'es-AR') {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === 'es-AR' ? es : en}
      timeZone="UTC"
    >
      <StationPage />
    </NextIntlClientProvider>,
  );
}

afterEach(cleanup);

describe('StationPage', () => {
  it('muestra el canal y la pestaña Helicorder activa', () => {
    renderPage();
    expect(screen.getByText('IU.MAJO..BHZ')).toBeTruthy();
    expect(screen.getByTestId('helicorder-canvas')).toBeTruthy();
  });

  it('las pestañas de los PRs B-D están deshabilitadas', () => {
    renderPage();
    expect(screen.getByRole('tab', { name: /espectrograma/i })).toHaveProperty('disabled', true);
    expect(screen.getByRole('tab', { name: /rsam/i })).toHaveProperty('disabled', true);
    // La única viva es Helicorder.
    expect(screen.getByRole('tab', { name: /helicorder/i })).toHaveProperty('disabled', false);
  });

  it('le pasa al canvas el canal decodificado de la URL', () => {
    renderPage();
    // El SCNL llega URL-encoded en el path y tiene que llegar limpio al canvas.
    expect(screen.getByTestId('helicorder-canvas').getAttribute('data-channel')).toBe(
      'IU.MAJO..BHZ',
    );
  });

  it('renderiza en inglés sin claves faltantes', () => {
    // next-intl renderiza el path de la clave cuando falta la traducción:
    // si aparece "station." en la pantalla, en.json quedó incompleto.
    const { container } = renderPage('en-US');
    expect(container.textContent).not.toMatch(/station\./);
    expect(screen.getByRole('tab', { name: /spectrogram/i })).toHaveProperty('disabled', true);
  });
});
