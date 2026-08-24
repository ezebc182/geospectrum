/**
 * El jsdom no rasteriza: acá no se verifica cómo QUEDA el dibujo, sino el
 * contrato observable — qué URL se pide, que el canvas se monte, que el error
 * se muestre y que ninguna coordenada enviada al contexto sea NaN.
 *
 * Ese último punto es el que importa: un NaN en una coordenada no tira
 * excepción, el canvas simplemente no dibuja. Una fila entera del helicorder
 * puede desaparecer sin que nada falle.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('nunca pide más puntos que el máximo del endpoint (le=50000)', async () => {
    // Bug de QA: con franjas de 15 min son 96 filas × 800 pares = 76.800, y el
    // endpoint valida le=50000 ANTES de entrar al handler → 422 y helicorder en
    // blanco. El clamp no pierde resolución: 50.000/96 ≈ 520 pares por fila
    // contra ~848 px de ancho útil, así que sigue habiendo más de un par por
    // píxel.
    render(
      <HelicorderCanvas channel="IU.MAJO..BHZ" timeChunkMinutes={15} width={900} height={620} />,
    );

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const url = (fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    const points = Number(new URL(url, 'http://x').searchParams.get('points'));
    expect(points).toBeLessThanOrEqual(50000);
    expect(points).toBeGreaterThan(0);
  });

  it('con franjas grandes pide lo que necesita, sin clampear de más', async () => {
    // 24 filas × 800 = 19.200: por debajo del tope, tiene que viajar entero.
    render(
      <HelicorderCanvas channel="IU.MAJO..BHZ" timeChunkMinutes={60} width={900} height={620} />,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const url = (fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(new URL(url, 'http://x').searchParams.get('points')).toBe('19200');
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

describe('HelicorderCanvas — selección de ventana por clic', () => {
  /**
   * En jsdom `getBoundingClientRect` devuelve todo en cero, así que sin esto el
   * handler sale por la guarda de `rect.width === 0` y el test pasaría por la
   * razón equivocada: verde sin haber ejercitado el mapeo.
   */
  function stubRect(canvas: HTMLElement, width: number, height: number) {
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 }) as DOMRect;
  }

  it('no cablea el handler ni el cursor sin onSelectWindow', async () => {
    render(
      <HelicorderCanvas channel="IU.MAJO..BHZ" timeChunkMinutes={60} width={1112} height={480} />,
    );

    const canvas = await screen.findByTestId('helicorder-canvas');
    expect(canvas.className).not.toContain('cursor-pointer');
  });

  it('con onSelectWindow muestra cursor de mano', async () => {
    render(
      <HelicorderCanvas
        channel="IU.MAJO..BHZ"
        timeChunkMinutes={60}
        width={1112}
        height={480}
        onSelectWindow={() => {}}
      />,
    );

    const canvas = await screen.findByTestId('helicorder-canvas');
    expect(canvas.className).toContain('cursor-pointer');
  });

  it('el clic entrega la ventana centrada en el instante señalado', async () => {
    const onSelectWindow = vi.fn();
    render(
      <HelicorderCanvas
        channel="IU.MAJO..BHZ"
        timeChunkMinutes={60}
        width={1112}
        height={480}
        onSelectWindow={onSelectWindow}
      />,
    );

    const canvas = await screen.findByTestId('helicorder-canvas');
    stubRect(canvas, 1112, 480);
    // Fila 3, mitad del plot: T0 + 3 h + 30 min (mismo caso que el test de la
    // lib pura, pero acá pasando por el componente).
    fireEvent.click(canvas, { clientX: 556, clientY: 70 });

    const T0 = Date.parse('2026-08-20T00:00:00Z');
    const esperado = T0 + 3 * 3_600_000 + 30 * 60_000;
    expect(onSelectWindow).toHaveBeenCalledWith({
      startMs: esperado - 60_000,
      endMs: esperado + 60_000,
    });
  });

  it('el clic en el margen no dispara nada', async () => {
    const onSelectWindow = vi.fn();
    render(
      <HelicorderCanvas
        channel="IU.MAJO..BHZ"
        timeChunkMinutes={60}
        width={1112}
        height={480}
        onSelectWindow={onSelectWindow}
      />,
    );

    const canvas = await screen.findByTestId('helicorder-canvas');
    stubRect(canvas, 1112, 480);
    fireEvent.click(canvas, { clientX: 20, clientY: 70 });

    expect(onSelectWindow).not.toHaveBeenCalled();
  });

  it('respeta selectionWindowSeconds', async () => {
    const onSelectWindow = vi.fn();
    render(
      <HelicorderCanvas
        channel="IU.MAJO..BHZ"
        timeChunkMinutes={60}
        width={1112}
        height={480}
        onSelectWindow={onSelectWindow}
        selectionWindowSeconds={600}
      />,
    );

    const canvas = await screen.findByTestId('helicorder-canvas');
    stubRect(canvas, 1112, 480);
    fireEvent.click(canvas, { clientX: 556, clientY: 70 });

    const { startMs, endMs } = onSelectWindow.mock.calls[0][0];
    expect(endMs - startMs).toBe(600_000);
  });

  it('escala las coordenadas cuando el canvas está redimensionado por CSS', async () => {
    // El canvas se dibuja a 1112x480 pero CSS lo muestra a la mitad. Sin la
    // conversión, un clic en el centro visual caería en el cuarto del dibujo.
    const onSelectWindow = vi.fn();
    render(
      <HelicorderCanvas
        channel="IU.MAJO..BHZ"
        timeChunkMinutes={60}
        width={1112}
        height={480}
        onSelectWindow={onSelectWindow}
      />,
    );

    const canvas = await screen.findByTestId('helicorder-canvas');
    stubRect(canvas, 556, 240); // mitad de tamaño
    fireEvent.click(canvas, { clientX: 278, clientY: 35 });

    const T0 = Date.parse('2026-08-20T00:00:00Z');
    const esperado = T0 + 3 * 3_600_000 + 30 * 60_000;
    expect(onSelectWindow).toHaveBeenCalledWith({
      startMs: esperado - 60_000,
      endMs: esperado + 60_000,
    });
  });
});
