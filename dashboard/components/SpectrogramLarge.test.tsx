/**
 * El jsdom no rasteriza: acá se verifica el contrato observable —qué se pide,
 * qué se muestra según el estado— y que ninguna coordenada enviada al canvas
 * sea NaN. Un NaN no tira excepción: el canvas simplemente no dibuja, así que
 * el espectrograma podría salir negro sin que nada falle.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import { SpectrogramLarge } from './SpectrogramLarge';

/** Grilla lineal como la arma el backend. */
function grid(nbins: number, fMin: number, fMax: number): number[] {
  const paso = (fMax - fMin) / (nbins - 1);
  return Array.from({ length: nbins }, (_, i) => fMin + i * paso);
}

function makeColumn(offsetMin: number, freqs = grid(40, 0.25, 10)) {
  return {
    channel: 'CN.BOIB..HHZ',
    endtime: new Date(Date.parse('2026-08-21T04:00:00Z') + offsetMin * 60_000).toISOString(),
    freqs,
    power_db: freqs.map((_, i) => 20 + (i / freqs.length) * 100),
  };
}

function stubFetch(columns: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ channel: 'x', columns }) })),
  );
}

/** WebSocket inerte: el componente lo abre siempre y jsdom no lo trae. */
class FakeWS {
  onmessage: ((e: { data: string }) => void) | null = null;
  close() {}
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
  stubFetch([makeColumn(0), makeColumn(5), makeColumn(10)]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSpec(channel = 'CN.BOIB..HHZ') {
  return render(
    <NextIntlClientProvider locale="es-AR" messages={es} timeZone="UTC">
      <SpectrogramLarge channel={channel} />
    </NextIntlClientProvider>,
  );
}

describe('SpectrogramLarge', () => {
  it('pide el historial del canal y monta el canvas', async () => {
    renderSpec();
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/spectrograms/CN.BOIB..HHZ/history'),
      );
    });
    expect(screen.getByTestId('spectrogram-large-canvas')).toBeTruthy();
  });

  it('escapa el canal en la URL — un SCNL lleva puntos y puede llevar espacios', async () => {
    renderSpec('C1.VA 01..BHZ');
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const url = (fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('C1.VA%2001..BHZ');
  });

  it('avisa cuando el canal no tiene columnas guardadas en vez de mostrar un rectángulo negro', async () => {
    stubFetch([]);
    renderSpec();
    await waitFor(() => expect(screen.getByTestId('spectrogram-large-empty')).toBeTruthy());
  });

  it('muestra el error si el historial falla', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    renderSpec();
    await waitFor(() => expect(screen.getByTestId('spectrogram-large-error')).toBeTruthy());
  });

  it('avisa cuando las columnas mezclan grillas de frecuencia distintas', async () => {
    // Caso real de AK.FIRE: columnas de 65 bins (0..25) junto a 80 (0.25..20).
    stubFetch([makeColumn(0, grid(65, 0, 25)), makeColumn(5, grid(80, 0.25, 20))]);
    renderSpec();
    await waitFor(() => expect(screen.getByTestId('spectrogram-mixed-grid')).toBeTruthy());
  });

  it('no avisa de grilla mixta cuando todas las columnas comparten grilla', async () => {
    renderSpec();
    await waitFor(() => expect(screen.getByTestId('spectrogram-large-canvas')).toBeTruthy());
    expect(screen.queryByTestId('spectrogram-mixed-grid')).toBeNull();
  });

  it('nunca manda NaN al canvas, ni con columnas corruptas', async () => {
    // Timestamps y frecuencias rotas son el camino corto a un canvas en blanco
    // sin ninguna excepción de por medio.
    stubFetch([
      makeColumn(0),
      { channel: 'x', endtime: 'no-es-fecha', freqs: [1, 2], power_db: [50, 60] },
      { channel: 'x', endtime: makeColumn(5).endtime, freqs: [NaN, 5], power_db: [50, 60] },
    ]);

    const coords: number[] = [];
    const ctx = {
      fillRect: vi.fn((x: number, y: number, w: number, h: number) => coords.push(x, y, w, h)),
      fillText: vi.fn(),
      beginPath: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      moveTo: vi.fn((x: number, y: number) => coords.push(x, y)),
      lineTo: vi.fn((x: number, y: number) => coords.push(x, y)),
      fillStyle: '',
      strokeStyle: '',
      font: '',
      textAlign: '',
      textBaseline: '',
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );

    renderSpec();

    await waitFor(() => expect(ctx.fillRect).toHaveBeenCalled());
    const malos = coords.filter((c) => !Number.isFinite(c));
    expect(malos, `${malos.length} coordenadas no finitas`).toHaveLength(0);
  });
});
