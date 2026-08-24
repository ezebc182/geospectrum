/**
 * Test del cleanup de reconexión del WebSocket (review PR-W1, fix Important).
 *
 * El bug: `setTimeout(connect, 3000)` en `ws.onclose` nunca se limpiaba en el
 * cleanup del useEffect, y `connect()` no chequeaba `cancelled`. Si el
 * componente se desmontaba con una reconexión pendiente, 3s después se abría
 * un WebSocket huérfano que nadie cerraba (fuga de conexión + memory leak).
 */

import * as React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
// Los formats REALES de producción (no una copia): así el test verifica la
// config que corre en la app, incluido el timeZone: 'UTC' del format 'time'.
import { formats } from '@/i18n/request';
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

/**
 * PR-W3 Task 11: el estándar del dominio sísmico es UTC y toda fuente
 * (USGS, EMSC, ObsPy endtime) ya llega en UTC. Una hora sin rótulo obliga
 * al operador a adivinar la zona — y si adivina mal, correlaciona mal.
 */
describe('LiveSpectrogramCanvas — hora en UTC', () => {
  it('la hora de última actualización se muestra en UTC con su rótulo', async () => {
    render(
      <NextIntlClientProvider locale="es" messages={es} formats={formats}>
        <LiveSpectrogramCanvas channel="IU.MAJO.00.BHZ" label="Tokyo" />
      </NextIntlClientProvider>
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      MockWebSocket.instances[0]!.onmessage?.({
        data: JSON.stringify({
          channel: 'IU.MAJO.00.BHZ',
          endtime: '2026-08-21T13:06:40.000000Z',
          freqs: [1, 2],
          power_db: [40, 50],
        }),
      });
    });

    // 13:06:40 UTC, no la hora local del runner (el script corre con
    // TZ hostil: en Buenos Aires serían las 10:06, en Tokyo las 22:06).
    expect(screen.getByText(/13:06:40/)).toBeTruthy();
    expect(screen.getByText(/UTC/)).toBeTruthy();
  });
});

/**
 * La UI no debe afirmar "en vivo" sobre un dato que ya no lo es.
 *
 * Caso real (2026-08-23): once tarjetas de producción rotuladas "1:57 AM UTC"
 * con la misma cara que un dato de hace 5 segundos. El backend tenía columnas
 * de hace UN segundo — lo congelado era la pestaña, no el servidor. Ese
 * cartel llevó a diagnosticar un backend caído que estaba sano.
 */
describe('LiveSpectrogramCanvas — frescura del dato', () => {
  const AHORA = new Date('2026-08-23T22:59:00Z');

  /** Monta el canvas y le entrega una columna con el endtime pedido. */
  async function montarConColumna(endtime: string) {
    render(
      <NextIntlClientProvider locale="es" messages={es} formats={formats}>
        <LiveSpectrogramCanvas channel="IU.MAJO.00.BHZ" label="Tokyo" />
      </NextIntlClientProvider>
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      MockWebSocket.instances[0]!.onmessage?.({
        data: JSON.stringify({
          channel: 'IU.MAJO.00.BHZ',
          endtime,
          freqs: [1, 2],
          power_db: [40, 50],
        }),
      });
    });
  }

  const cartelViejo = () => screen.queryByText(es.common.live.staleLabel);

  beforeEach(() => {
    vi.setSystemTime(AHORA);
  });

  it('no muestra el cartel de viejo con una columna recién llegada', async () => {
    await montarConColumna('2026-08-23T22:58:48.000000Z'); // 12s de antigüedad
    expect(cartelViejo()).toBeNull();
  });

  it('muestra el cartel de viejo cuando el dato pasó los 5 minutos', async () => {
    await montarConColumna('2026-08-23T22:50:00.000000Z'); // 9 min
    expect(cartelViejo()).toBeTruthy();
  });

  it('avisa cuando el canal enmudece, sin recibir ninguna columna nueva', async () => {
    // El caso más traicionero: nada dispara un render, así que sin el tick
    // interno la tarjeta se quedaría rotulada "en vivo" para siempre.
    await montarConColumna('2026-08-23T22:58:48.000000Z');
    expect(cartelViejo()).toBeNull();

    act(() => {
      vi.advanceTimersByTime(6 * 60 * 1000); // 6 min de silencio
    });

    expect(cartelViejo()).toBeTruthy();
  });

  it('avisa si se corta el socket, por reciente que sea el último dato', async () => {
    // El bug de la pestaña congelada: lastUpdate queda clavado en el último
    // mensaje y la etiqueta lo muestra como si siguiera valiendo.
    await montarConColumna('2026-08-23T22:58:55.000000Z'); // 5s: fresquísimo
    expect(cartelViejo()).toBeNull();

    act(() => {
      MockWebSocket.instances[0]!.onclose?.();
    });

    expect(cartelViejo()).toBeTruthy();
  });
});
