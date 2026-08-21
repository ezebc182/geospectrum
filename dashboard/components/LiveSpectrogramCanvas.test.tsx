/**
 * Test del cleanup de reconexión del WebSocket (review PR-W1, fix Important).
 *
 * El bug: `setTimeout(connect, 3000)` en `ws.onclose` nunca se limpiaba en el
 * cleanup del useEffect, y `connect()` no chequeaba `cancelled`. Si el
 * componente se desmontaba con una reconexión pendiente, 3s después se abría
 * un WebSocket huérfano que nadie cerraba (fuga de conexión + memory leak).
 */

import * as React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import { LiveSpectrogramCanvas } from './LiveSpectrogramCanvas';

/** Stub de WebSocket que registra cada instancia creada para poder
 * inspeccionarlas y disparar sus eventos manualmente desde el test. */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

  // jsdom no implementa canvas real: stubbeamos el 2D context lo mínimo que
  // usa drawColumn (getImageData/putImageData/fillRect).
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '',
    fillRect: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(0) })),
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D);

  // Historial: respuesta ok sin columnas, para que loadHistoryThenConnect
  // pase directo a connect() sin ruido.
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ columns: [] }),
      })
    ) as unknown as typeof fetch
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('LiveSpectrogramCanvas — cleanup de reconexión', () => {
  it('no abre un WebSocket huérfano si se desmonta con una reconexión pendiente', async () => {
    const { unmount } = render(
      <NextIntlClientProvider locale="es" messages={es}>
        <LiveSpectrogramCanvas channel="IU.MAJO.00.BHZ" label="Tokyo" />
      </NextIntlClientProvider>
    );

    // loadHistoryThenConnect es async: dejamos correr el fetch + connect().
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(MockWebSocket.instances).toHaveLength(1);

    // Cierre NO propio del WS -> dispara la reconexión con setTimeout(connect, 3000).
    act(() => {
      MockWebSocket.instances[0]!.onclose?.();
    });

    // Se desmonta con la reconexión todavía pendiente.
    unmount();

    // Avanzamos los 3000ms del backoff.
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    // Con el bug, acá se crea una segunda instancia (WebSocket huérfano que
    // nadie cierra). Con el fix, el timer se canceló en el cleanup.
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
