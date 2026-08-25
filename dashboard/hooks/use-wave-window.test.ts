import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWaveWindow, type WaveformResponse } from './use-wave-window';

const T0 = Date.UTC(2026, 7, 24, 12, 0, 0);
const W0 = { startMs: T0, endMs: T0 + 600_000 };
const W1 = { startMs: T0 + 100_000, endMs: T0 + 200_000 };
const W2 = { startMs: T0 + 120_000, endMs: T0 + 140_000 };

function response(over: Partial<WaveformResponse> = {}): WaveformResponse {
  return {
    channel: 'AK.FIRE..BHZ',
    sampling_rate: 40,
    starttime: new Date(T0).toISOString(),
    endtime: new Date(T0 + 600_000).toISOString(),
    mins: [-1, -2],
    maxs: [1, 2],
    ...over,
  };
}

/** Promesa que se resuelve a mano, para controlar el orden de las respuestas. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useWaveWindow', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => response() }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('siembra por efecto (invariante 1)', () => {
    it('sin ventana inicial arranca en null y no pide nada', () => {
      const { result } = renderHook(() => useWaveWindow('AK.FIRE..BHZ'));
      expect(result.current.window).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('una ventana inicial que llega DESPUÉS del primer render se aplica igual', async () => {
      // Éste es el test de la invariante 1. Con `useState(initial ?? ...)` el
      // estado quedaría clavado en null y este aserto sería rojo: la `initial`
      // viene del fetch del helicorder, o sea siempre llega tarde.
      const { result, rerender } = renderHook(
        ({ w }: { w?: typeof W0 }) => useWaveWindow('AK.FIRE..BHZ', w),
        { initialProps: { w: undefined as typeof W0 | undefined } },
      );
      expect(result.current.window).toBeNull();

      rerender({ w: W0 });
      await waitFor(() => expect(result.current.window).toEqual(W0));
    });

    it('pide el dato de la ventana con start/end absolutos', async () => {
      const { result } = renderHook(() => useWaveWindow('AK.FIRE..BHZ', W0));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toContain(encodeURIComponent(new Date(W0.startMs).toISOString()));
      expect(url).toContain(encodeURIComponent(new Date(W0.endMs).toISOString()));
      expect(result.current.data).not.toBeNull();
    });

    it('el filtro viaja al backend y cambiarlo vuelve a pedir', async () => {
      const { result, rerender } = renderHook(
        ({ f }: { f: 'none' | 'bp' }) => useWaveWindow('AK.FIRE..BHZ', W0, f),
        { initialProps: { f: 'none' as 'none' | 'bp' } },
      );
      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(String(fetchMock.mock.calls[0][0])).toContain('filter=none');

      const before = fetchMock.mock.calls.length;
      rerender({ f: 'bp' });
      // El filtro cambia el DATO: tiene que salir una petición nueva, no un
      // repintado con lo que ya estaba en memoria.
      await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
      expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('filter=bp');
    });
  });

  describe('carreras de red', () => {
    it('dos zooms seguidos abortan el request en vuelo (defensa ①)', async () => {
      const { result } = renderHook(() => useWaveWindow('AK.FIRE..BHZ', W0));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      const signals: AbortSignal[] = [];
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        signals.push(init.signal as AbortSignal);
        return { ok: true, json: async () => response() };
      });

      act(() => result.current.setWindow(W1));
      await waitFor(() => expect(signals.length).toBe(1));
      act(() => result.current.setWindow(W2));
      await waitFor(() => expect(signals.length).toBe(2));

      expect(signals[0].aborted).toBe(true);
      expect(signals[1].aborted).toBe(false);
    });

    it('una respuesta tardía de una ventana vieja NO pisa el estado (defensa ⑤)', async () => {
      // El test que prueba la guarda de ventana tardía. Sin ella, el usuario
      // hace zoom dos veces rápido y termina mirando el dato del zoom anterior
      // con el eje del actual: el gráfico miente sin fallar.
      const slow = deferred<WaveformResponse>();
      const fast = deferred<WaveformResponse>();

      const { result } = renderHook(() => useWaveWindow('AK.FIRE..BHZ', W0));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      let call = 0;
      fetchMock.mockImplementation(async () => {
        call += 1;
        // El signal se ignora a propósito: se está probando la guarda ⑤, no el
        // abort. Si `fetch` rechazara por el abort, la ⑤ nunca se ejercitaría.
        const body = call === 1 ? await slow.promise : await fast.promise;
        return { ok: true, json: async () => body };
      });

      const stale = response({ starttime: 'STALE' });
      const fresh = response({ starttime: 'FRESH' });

      act(() => result.current.setWindow(W1)); // request lento
      await waitFor(() => expect(call).toBe(1));
      act(() => result.current.setWindow(W2)); // request rápido
      await waitFor(() => expect(call).toBe(2));

      // La respuesta de la ventana ACTUAL llega primero...
      await act(async () => {
        fast.resolve(fresh);
      });
      await waitFor(() => expect(result.current.data?.starttime).toBe('FRESH'));

      // ...y después llega la de la ventana vieja. No debe pisar nada.
      await act(async () => {
        slow.resolve(stale);
      });
      expect(result.current.data?.starttime).toBe('FRESH');
      expect(result.current.window).toEqual(W2);
    });

    it('un error de red deja status error, y un abort NO', async () => {
      const { result } = renderHook(() => useWaveWindow('AK.FIRE..BHZ', W0));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      fetchMock.mockImplementation(async () => ({ ok: false, status: 503 }));
      act(() => result.current.setWindow(W1));
      await waitFor(() => expect(result.current.status).toBe('error'));
    });
  });

  describe('pila de zoom (invariante 2)', () => {
    it('canGoBack es false con la pila vacía y true con elementos', async () => {
      const { result } = renderHook(() => useWaveWindow('AK.FIRE..BHZ', W0));
      await waitFor(() => expect(result.current.window).toEqual(W0));
      expect(result.current.canGoBack).toBe(false);

      act(() => result.current.setWindow(W1));
      await waitFor(() => expect(result.current.canGoBack).toBe(true));
    });

    /**
     * NOTA SOBRE LA INVARIANTE 2 (pila en `useState`, no en `useRef`).
     *
     * No hay un test que la pruebe, y no es un olvido: con la API actual del
     * hook la invariante NO ES OBSERVABLE desde afuera.
     *
     * Medido, no supuesto: se movió la pila a un `useRef` y los 12 tests de
     * este archivo quedaron VERDES. Una sonda que contaba renders mostró que
     * `canGoBack` igual llegaba a `true`. La causa es que las tres operaciones
     * públicas —`setWindow`, `goBack`, `reset`— llaman TODAS a
     * `setWindowState` con un objeto nuevo; ese cambio de estado dispara el
     * re-render, y ese render arrastrado hace visible el valor del ref. No
     * existe hoy ninguna operación que toque la pila sin mover la ventana.
     *
     * La pila se queda igual en `useState`, y la razón no es un test: el día
     * que alguien agregue una operación que sólo toque la pila (un
     * `clearHistory`, por ejemplo), el ref dejaría `canGoBack` congelado sin
     * fallar ni avisar. Ese día ESTE es el lugar donde escribir el test.
     *
     * Se descartó agregar `clearHistory()` sólo para hacerla observable:
     * ampliar la API pública para que un test pueda fallar es la cola meneando
     * al perro.
     */

    it('vuelve W2 → W1 → W0 y una cuarta vez sigue en W0 sin desbordar a null', async () => {
      const { result } = renderHook(() => useWaveWindow('AK.FIRE..BHZ', W0));
      await waitFor(() => expect(result.current.window).toEqual(W0));

      act(() => result.current.setWindow(W1));
      await waitFor(() => expect(result.current.window).toEqual(W1));
      act(() => result.current.setWindow(W2));
      await waitFor(() => expect(result.current.window).toEqual(W2));

      act(() => result.current.goBack());
      await waitFor(() => expect(result.current.window).toEqual(W1));
      act(() => result.current.goBack());
      await waitFor(() => expect(result.current.window).toEqual(W0));
      expect(result.current.canGoBack).toBe(false);

      // La tercera y la cuarta no deben dejar la ventana en null: eso apagaría
      // el gráfico entero por apretar un botón de más.
      act(() => result.current.goBack());
      act(() => result.current.goBack());
      expect(result.current.window).toEqual(W0);
      expect(result.current.canGoBack).toBe(false);
    });

    it('pedir la MISMA ventana no apila un nivel repetido', async () => {
      const { result } = renderHook(() => useWaveWindow('AK.FIRE..BHZ', W0));
      await waitFor(() => expect(result.current.window).toEqual(W0));

      act(() => result.current.setWindow(W0));
      expect(result.current.canGoBack).toBe(false);
    });

    it('reset vacía la pila y vuelve a la ventana inicial', async () => {
      const { result } = renderHook(() => useWaveWindow('AK.FIRE..BHZ', W0));
      await waitFor(() => expect(result.current.window).toEqual(W0));

      act(() => result.current.setWindow(W1));
      await waitFor(() => expect(result.current.canGoBack).toBe(true));

      act(() => result.current.reset());
      await waitFor(() => expect(result.current.window).toEqual(W0));
      expect(result.current.canGoBack).toBe(false);
    });
  });

  describe('cambio de canal', () => {
    it('limpia el dato de la estación anterior en vez de mostrarlo con el eje nuevo', async () => {
      const { result, rerender } = renderHook(
        ({ ch }: { ch: string }) => useWaveWindow(ch, W0),
        { initialProps: { ch: 'AK.FIRE..BHZ' } },
      );
      await waitFor(() => expect(result.current.data).not.toBeNull());

      rerender({ ch: 'IU.MAJO.00.BHZ' });
      // El canal nuevo vuelve a sembrar y a pedir; lo que no puede pasar es que
      // se siga viendo la onda de la estación anterior.
      await waitFor(() =>
        expect(String(fetchMock.mock.calls.at(-1)![0])).toContain(
          encodeURIComponent('IU.MAJO.00.BHZ'),
        ),
      );
    });
  });
});
