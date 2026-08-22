/**
 * El jsdom no rasteriza: acá no se verifica cómo QUEDA el dibujo, sino el
 * contrato observable — qué URL se pide, que el canvas se monte, que el error
 * se muestre y que ninguna coordenada enviada al contexto sea NaN.
 *
 * Ese último punto es el que importa: un NaN en una coordenada no tira
 * excepción, el canvas simplemente no dibuja. Una fila entera del helicorder
 * puede desaparecer sin que nada falle.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HelicorderCanvas } from './HelicorderCanvas';

function makeWaveform(pairs = 1000) {
  return {
    channel: 'IU.MAJO..BHZ',
    sampling_rate: 100,
    starttime: '2026-08-20T00:00:00Z',
    endtime: '2026-08-21T00:00:00Z',
    mins: Array.from({ length: pairs }, (_, i) => -Math.abs(Math.sin(i / 50)) * 100),
    maxs: Array.from({ length: pairs }, (_, i) => Math.abs(Math.sin(i / 50)) * 100),
  };
}

function stubFetchOk(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => body })),
  );
}

beforeEach(() => {
  stubFetchOk(makeWaveform());
});

describe('HelicorderCanvas', () => {
  it('pide el waveform de 24h del canal y renderiza el canvas', async () => {
    render(
      <HelicorderCanvas channel="IU.MAJO..BHZ" timeChunkMinutes={30} width={900} height={620} />,
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/stations/IU.MAJO..BHZ/waveform?minutes=1440'),
      );
    });
    expect(screen.getByTestId('helicorder-canvas')).toBeTruthy();
  });

  it('muestra el estado de error si el fetch falla', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    render(
      <HelicorderCanvas channel="IU.MAJO..BHZ" timeChunkMinutes={30} width={900} height={620} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('helicorder-error')).toBeTruthy();
    });
  });

  it('escapa el canal en la URL — un SCNL lleva puntos y puede llevar espacios', async () => {
    render(
      <HelicorderCanvas channel="C1.VA 01..BHZ" timeChunkMinutes={30} width={900} height={620} />,
    );

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const url = (fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    // Sin encodeURIComponent el espacio viaja crudo y rompe la request.
    expect(url).toContain('C1.VA%2001..BHZ');
    expect(url).not.toContain('VA 01');
  });

  it('nunca manda NaN al canvas, ni con menos pares que filas', async () => {
    // 100 pares para 48 filas: las filas finales quedan cortas o vacías, que
    // es donde un bias mal calculado produce NaN y borra la fila en silencio.
    stubFetchOk(makeWaveform(100));

    const coords: number[] = [];
    const ctx = {
      fillRect: vi.fn(),
      fillText: vi.fn(),
      beginPath: vi.fn(),
      stroke: vi.fn(),
      moveTo: vi.fn((x: number, y: number) => coords.push(x, y)),
      lineTo: vi.fn((x: number, y: number) => coords.push(x, y)),
      fillStyle: '',
      strokeStyle: '',
      font: '',
      textBaseline: '',
      textAlign: '',
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );

    render(
      <HelicorderCanvas channel="IU.MAJO..BHZ" timeChunkMinutes={30} width={900} height={620} />,
    );

    await waitFor(() => expect(ctx.moveTo).toHaveBeenCalled());
    const malos = coords.filter((c) => !Number.isFinite(c));
    expect(malos, `${malos.length} coordenadas no finitas`).toHaveLength(0);
  });
});
