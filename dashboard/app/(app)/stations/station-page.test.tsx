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

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import en from '@/messages/en.json';

const { paramsMock } = vi.hoisted(() => ({
  paramsMock: { channel: 'IU.MAJO..BHZ' },
}));

vi.mock('next/navigation', () => ({
  useParams: () => paramsMock,
}));

vi.mock('@/components/HelicorderCanvas', () => ({
  HelicorderCanvas: ({
    channel,
    clipMult,
    barMult,
    timeChunkMinutes,
  }: {
    channel: string;
    clipMult?: number;
    barMult?: number;
    timeChunkMinutes: number;
  }) => (
    <div
      data-testid="helicorder-canvas"
      data-channel={channel}
      data-clip-mult={String(clipMult)}
      data-bar-mult={String(barMult)}
      data-chunk={String(timeChunkMinutes)}
    />
  ),
}));

vi.mock('@/components/SpectrogramLarge', () => ({
  SpectrogramLarge: ({ channel }: { channel: string }) => (
    <div data-testid="spectrogram-large" data-channel={channel} />
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
// Los settings se persisten por canal: sin limpiar, un test le deja la escala
// puesta al siguiente y el verde depende del orden de ejecución.
beforeEach(() => localStorage.clear());

describe('StationPage', () => {
  it('muestra el canal y la pestaña Helicorder activa', () => {
    renderPage();
    expect(screen.getByText('IU.MAJO..BHZ')).toBeTruthy();
    expect(screen.getByTestId('helicorder-canvas')).toBeTruthy();
  });

  it('las pestañas de los PRs C-D siguen deshabilitadas', () => {
    renderPage();
    expect(screen.getByRole('tab', { name: /onda/i })).toHaveProperty('disabled', true);
    expect(screen.getByRole('tab', { name: /rsam/i })).toHaveProperty('disabled', true);
    // Helicorder (PR A) y Espectrograma (PR B) están vivas.
    expect(screen.getByRole('tab', { name: /helicorder/i })).toHaveProperty('disabled', false);
    expect(screen.getByRole('tab', { name: /espectrograma/i })).toHaveProperty('disabled', false);
  });

  it('sólo la pestaña activa está aria-selected, no todas las habilitadas', () => {
    // El PR A ponía aria-selected={tab.enabled}: con dos pestañas vivas eso le
    // dice al lector de pantalla que hay dos seleccionadas a la vez.
    renderPage();
    const seleccionadas = screen
      .getAllByRole('tab')
      .filter((b) => b.getAttribute('aria-selected') === 'true');
    expect(seleccionadas).toHaveLength(1);
    expect(seleccionadas[0].textContent).toMatch(/helicorder/i);
  });

  it('cambiar a Espectrograma monta el espectrograma y desmonta el helicorder', () => {
    renderPage();
    expect(screen.queryByTestId('spectrogram-large')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /espectrograma/i }));

    expect(screen.getByTestId('spectrogram-large')).toBeTruthy();
    // Son vistas excluyentes: dejar los dos canvas montados duplicaría el
    // fetch de 24 h y el WS por gusto.
    expect(screen.queryByTestId('helicorder-canvas')).toBeNull();
  });

  it('los controles de escala son del helicorder y no aparecen en el espectrograma', () => {
    renderPage();
    expect(screen.getByLabelText(/umbral de saturación/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /espectrograma/i }));
    expect(screen.queryByLabelText(/umbral de saturación/i)).toBeNull();
  });

  it('el espectrograma recibe el canal decodificado', () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /espectrograma/i }));
    expect(screen.getByTestId('spectrogram-large').getAttribute('data-channel')).toBe(
      'IU.MAJO..BHZ',
    );
  });

  it('le pasa al canvas el canal decodificado de la URL', () => {
    renderPage();
    // El SCNL llega URL-encoded en el path y tiene que llegar limpio al canvas.
    expect(screen.getByTestId('helicorder-canvas').getAttribute('data-channel')).toBe(
      'IU.MAJO..BHZ',
    );
  });

  it('mover el clip llega al canvas: es el fix del sismo tapado de rojo', async () => {
    // El bug de QA era que el sismo salía clampado y rojo porque el clip
    // automático (percentil del día) lo recorta. Si el slider no llega al
    // canvas, el arreglo es decorativo.
    renderPage();
    const slider = screen.getByLabelText(/umbral de saturación/i);
    fireEvent.change(slider, { target: { value: '6' } });

    expect(screen.getByTestId('helicorder-canvas').getAttribute('data-clip-mult')).toBe('6');
  });

  it('los settings se persisten por canal en localStorage', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/amplitud/i), { target: { value: '3' } });

    const guardado = JSON.parse(localStorage.getItem('helicorder-settings:IU.MAJO..BHZ') ?? '{}');
    expect(guardado.barMult).toBe(3);
  });

  it('los settings guardados se aplican al montar', () => {
    localStorage.setItem(
      'helicorder-settings:IU.MAJO..BHZ',
      JSON.stringify({ clipMult: 5, barMult: 2, timeChunkMinutes: 15 }),
    );
    renderPage();

    const canvas = screen.getByTestId('helicorder-canvas');
    expect(canvas.getAttribute('data-clip-mult')).toBe('5');
    expect(canvas.getAttribute('data-bar-mult')).toBe('2');
    expect(canvas.getAttribute('data-chunk')).toBe('15');
  });

  it('restablecer vuelve a los defaults sin tocar el timeChunk elegido', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '15m' }));
    fireEvent.change(screen.getByLabelText(/umbral de saturación/i), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /restablecer/i }));

    const canvas = screen.getByTestId('helicorder-canvas');
    expect(canvas.getAttribute('data-clip-mult')).toBe('1');
    // El reset es de escala, no de franja: cambiarle el eje X al operador
    // sería una sorpresa.
    expect(canvas.getAttribute('data-chunk')).toBe('15');
  });

  it('renderiza en inglés sin claves faltantes', () => {
    // next-intl renderiza el path de la clave cuando falta la traducción:
    // si aparece "station." en la pantalla, en.json quedó incompleto.
    const { container } = renderPage('en-US');
    expect(container.textContent).not.toMatch(/station\./);
    expect(screen.getByRole('tab', { name: /rsam/i })).toHaveProperty('disabled', true);
    expect(screen.getByRole('tab', { name: /spectrogram/i })).toHaveProperty('disabled', false);
  });
});
