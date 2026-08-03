import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import { emitAreaChanged } from './area-events';
import { useAreaRefresh } from './use-area-refresh';

afterEach(() => {
  cleanup();
});

/** Promesa que resuelve/rechaza cuando el test lo decide, no cuando quiere. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Probe({ handler }: { handler: () => void | Promise<unknown> }) {
  const isRefreshing = useAreaRefresh(handler);
  return <span data-testid="status">{isRefreshing ? 'refrescando' : 'quieto'}</span>;
}

function status() {
  return screen.getByTestId('status').textContent;
}

/** Deja correr los microtasks pendientes de las promesas ya resueltas. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useAreaRefresh — señal de revalidación en curso', () => {
  it('arranca en false y no se enciende sin evento de área', () => {
    render(<Probe handler={() => Promise.resolve()} />);

    expect(status()).toBe('quieto');
  });

  it('se enciende al cambiar de área y se apaga cuando la revalidación termina', async () => {
    const refresh = deferred();
    render(<Probe handler={() => refresh.promise} />);

    act(() => emitAreaChanged());
    expect(status()).toBe('refrescando');

    await act(async () => {
      refresh.resolve();
      await refresh.promise;
    });
    expect(status()).toBe('quieto');
  });

  it('espera a TODAS las promesas, no sólo a la primera que resuelve', async () => {
    // El caso real: /report suele volver antes que /areas/active, y apagar el
    // indicador con el primero deja el mapa redibujándose sin ninguna señal.
    const report = deferred();
    const area = deferred();
    render(<Probe handler={() => Promise.all([report.promise, area.promise])} />);

    act(() => emitAreaChanged());
    expect(status()).toBe('refrescando');

    await act(async () => {
      report.resolve();
      await report.promise;
    });
    expect(status()).toBe('refrescando');

    await act(async () => {
      area.resolve();
      await area.promise;
    });
    expect(status()).toBe('quieto');
  });

  it('ignora la revalidación vieja si el usuario cambia de área dos veces seguidas', async () => {
    const stale = deferred();
    const latest = deferred();
    const handler = vi
      .fn(() => Promise.resolve() as Promise<unknown>)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(latest.promise);

    render(<Probe handler={handler} />);

    act(() => emitAreaChanged());
    act(() => emitAreaChanged());
    expect(status()).toBe('refrescando');

    // Resuelve la PRIMERA, que ya quedó obsoleta: el indicador no debe apagarse
    // porque la segunda sigue en vuelo.
    await act(async () => {
      stale.resolve();
      await stale.promise;
    });
    expect(status()).toBe('refrescando');

    await act(async () => {
      latest.resolve();
      await latest.promise;
    });
    expect(status()).toBe('quieto');
  });

  it('se apaga aunque la revalidación falle', async () => {
    const refresh = deferred();
    // Al hook se le da la promesa RECHAZADA de verdad —es lo que se quiere
    // probar— y el test se engancha aparte con su propio catch para esperarla
    // sin dejar un unhandled rejection, que en Vitest ensucia toda la corrida.
    const settled = refresh.promise.catch(() => undefined);
    render(<Probe handler={() => refresh.promise} />);

    act(() => emitAreaChanged());
    expect(status()).toBe('refrescando');

    // Sin el manejo del rechazo en el hook, la barra quedaría girando para
    // siempre ante un error de red, que es peor que el bug original.
    await act(async () => {
      refresh.reject(new Error('USGS caído'));
      await settled;
    });
    expect(status()).toBe('quieto');
  });

  it('no se enciende si el handler es síncrono', async () => {
    // Un handler que no devuelve promesa no tiene nada que esperar: encender el
    // indicador produciría un parpadeo de un frame.
    render(<Probe handler={() => undefined} />);

    act(() => emitAreaChanged());
    await flush();

    expect(status()).toBe('quieto');
  });

  it('deja de escuchar al desmontarse', () => {
    const handler = vi.fn(() => Promise.resolve());
    const { unmount } = render(<Probe handler={handler} />);

    unmount();
    act(() => emitAreaChanged());

    expect(handler).not.toHaveBeenCalled();
  });

  it('usa siempre la última versión del handler, no la del primer render', async () => {
    const initial = vi.fn(() => Promise.resolve());
    const updated = vi.fn(() => Promise.resolve());
    const { rerender } = render(<Probe handler={initial} />);

    rerender(<Probe handler={updated} />);
    act(() => emitAreaChanged());
    await flush();

    expect(initial).not.toHaveBeenCalled();
    expect(updated).toHaveBeenCalledTimes(1);
  });
});
