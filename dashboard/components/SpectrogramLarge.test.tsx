/**
 * El jsdom no rasteriza: acá se verifica el contrato observable —qué se pide,
 * qué se muestra según el estado— y que ninguna coordenada enviada al canvas
 * sea NaN. Un NaN no tira excepción: el canvas simplemente no dibuja, así que
 * el espectrograma podría salir negro sin que nada falle.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

/** Columnas por defecto para los tests de zoom/pan: no les importa el contenido, sólo que haya varias. */
function sampleColumns() {
  return [makeColumn(0), makeColumn(5), makeColumn(10), makeColumn(15), makeColumn(20)];
}

function stubFetch(columns: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ channel: 'x', columns }) })),
  );
}

/** Igual que `stubFetch`, con nombre acorde al brief para los tests de zoom/pan. */
function mockHistory({ columns }: { columns: unknown[] }) {
  stubFetch(columns);
}

/** WebSocket inerte: el componente lo abre siempre y jsdom no lo trae. */
class FakeWS {
  static instances: FakeWS[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor() {
    FakeWS.instances.push(this);
  }
  close() {}
}

/** Simula la llegada de una columna nueva por WS a la última conexión abierta. */
function emitWsColumn(col: { endtime: string; freqs: number[]; power_db: number[] }) {
  const ws = FakeWS.instances.at(-1);
  ws?.onmessage?.({ data: JSON.stringify({ channel: 'x', ...col }) });
}

/** Contexto de canvas mockeado más reciente, con `clip` espiable. */
let mockCtx: ReturnType<typeof buildMockContext> | null = null;

function buildMockContext() {
  return {
    fillRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    stroke: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
  };
}

function getMockContext() {
  if (!mockCtx) throw new Error('getMockContext: todavía no se montó ningún canvas mockeado');
  return mockCtx;
}

beforeEach(() => {
  FakeWS.instances = [];
  vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
  stubFetch([makeColumn(0), makeColumn(5), makeColumn(10)]);
  mockCtx = buildMockContext();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    mockCtx as unknown as CanvasRenderingContext2D,
  );
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
      rect: vi.fn(),
      clip: vi.fn(),
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

  it('arranca sin zoom y no muestra el boton de reset', async () => {
    mockHistory({ columns: sampleColumns() });
    renderSpec('AR.TEST..HHZ');
    await screen.findByTestId('spectrogram-large-canvas');
    expect(screen.queryByTestId('spectrogram-reset-zoom')).toBeNull();
  });

  it('la rueda del mouse acerca en tiempo y muestra el boton de reset', async () => {
    mockHistory({ columns: sampleColumns() });
    renderSpec('AR.TEST..HHZ');
    const canvas = await screen.findByTestId('spectrogram-large-canvas');

    fireEvent.wheel(canvas, { deltaY: -100, clientX: 300, clientY: 200 });

    expect(await screen.findByTestId('spectrogram-reset-zoom')).toBeTruthy();
  });

  it('el boton de reset vuelve a la vista completa', async () => {
    mockHistory({ columns: sampleColumns() });
    renderSpec('AR.TEST..HHZ');
    const canvas = await screen.findByTestId('spectrogram-large-canvas');

    fireEvent.wheel(canvas, { deltaY: -100, clientX: 300, clientY: 200 });
    fireEvent.click(await screen.findByTestId('spectrogram-reset-zoom'));

    await waitFor(() => expect(screen.queryByTestId('spectrogram-reset-zoom')).toBeNull());
  });

  it('el doble clic sobre el canvas resetea el zoom', async () => {
    mockHistory({ columns: sampleColumns() });
    renderSpec('AR.TEST..HHZ');
    const canvas = await screen.findByTestId('spectrogram-large-canvas');

    fireEvent.wheel(canvas, { deltaY: -100, clientX: 300, clientY: 200 });
    await screen.findByTestId('spectrogram-reset-zoom');
    fireEvent.doubleClick(canvas);

    await waitFor(() => expect(screen.queryByTestId('spectrogram-reset-zoom')).toBeNull());
  });

  it('la tecla Escape resetea el zoom', async () => {
    mockHistory({ columns: sampleColumns() });
    renderSpec('AR.TEST..HHZ');
    const canvas = await screen.findByTestId('spectrogram-large-canvas');

    fireEvent.wheel(canvas, { deltaY: -100, clientX: 300, clientY: 200 });
    await screen.findByTestId('spectrogram-reset-zoom');
    fireEvent.keyDown(canvas, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByTestId('spectrogram-reset-zoom')).toBeNull());
  });

  it('con zoom activo, una columna nueva del WS NO mueve la vista', async () => {
    // El bug que este test previene: el useEffect de dibujo depende de las
    // columnas, y si el viewport se derivara de ellas cada mensaje del WS le
    // correría el encuadre al usuario debajo del mouse.
    mockHistory({ columns: sampleColumns() });
    renderSpec('AR.TEST..HHZ');
    const canvas = await screen.findByTestId('spectrogram-large-canvas');

    fireEvent.wheel(canvas, { deltaY: -100, clientX: 300, clientY: 200 });
    await screen.findByTestId('spectrogram-reset-zoom');

    // Rótulos del eje de tiempo ANTES del mensaje del WS: son la huella de
    // qué ventana temporal se está dibujando ahora mismo.
    const ctx = getMockContext();
    const ticksAntes = ctx.fillText.mock.calls.map((c) => c[0]).join('|');

    emitWsColumn({
      // Muy lejos en el futuro a propósito: si la vista se re-encuadrara con
      // el dato completo, el eje de tiempo pasaría a cubrir hasta acá y los
      // rótulos cambiarían. Si la vista queda quieta, no cambian.
      endtime: new Date(Date.now() + 3_600_000).toISOString(),
      freqs: [1, 2],
      power_db: [50, 60],
    });

    // Sigue habiendo zoom: la vista no se re-encuadró sola.
    await waitFor(() => expect(screen.getByTestId('spectrogram-reset-zoom')).toBeTruthy());

    const ticksDespues = ctx.fillText.mock.calls.map((c) => c[0]).join('|');
    expect(ticksDespues).toBe(ticksAntes);
  });

  it('recorta el dibujo al area de plot para no pisar los rotulos', async () => {
    mockHistory({ columns: sampleColumns() });
    renderSpec('AR.TEST..HHZ');
    await screen.findByTestId('spectrogram-large-canvas');

    const ctx = getMockContext();
    expect(ctx.clip).toHaveBeenCalled();
  });
});
