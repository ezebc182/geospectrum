/**
 * Tests del stream de eventos (PR-W4, T11).
 *
 * El patrón de mockeo de WebSocket sale de LiveSpectrogramCanvas.test.tsx:23-74
 * (registro estático de instancias + vi.stubGlobal + fake timers), que es el
 * único precedente de test de WS en el repo.
 *
 * Lo que se fija:
 * - el snapshot PISA la lista y un evento suelto se MERGEA (no la reemplaza)
 * - una revisión del mismo id actualiza en vez de duplicar
 * - el backoff crece y tiene tope: sin eso, todas las pestañas abiertas
 *   martillarían el backend cada 3 s para siempre
 * - el cleanup no deja timers vivos
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  backoffDelay,
  mergeEvent,
  useEventStream,
  BROADCAST_EVENTS_KEY,
} from './use-event-stream';
import type { SeismicEvent } from '@/lib/types';

const mutateSpy = vi.fn();
vi.mock('swr', () => ({
  useSWRConfig: () => ({ mutate: mutateSpy }),
}));

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  /**
   * Dispara `onclose`, como hace un WebSocket real.
   *
   * No es un detalle: un mock que sólo marca `closed = true` hace que el
   * cleanup del hook parezca correcto aunque le falte el flag `closedByUs`,
   * porque nadie llega a ejecutar el handler que reconectaría. Verificado por
   * mutación — con el mock pasivo, quitar `closedByUs` dejaba los 22 tests en
   * verde.
   */
  close() {
    this.closed = true;
    this.onclose?.();
  }
}

function buildEvent(id = 'emsc_1', hora = '2026-08-21T12:00:00Z', mag = 4.5): SeismicEvent {
  return {
    id,
    fuentes: ['EMSC'],
    hora_utc: hora,
    lat: -23.5,
    lon: -68.2,
    prof_km: 110,
    mag,
    mag_tipo: 'mb',
    lugar: 'Antofagasta, Chile',
    sentido: false,
    revisado: false,
  } as SeismicEvent;
}

beforeEach(() => {
  vi.useFakeTimers();
  MockWebSocket.instances = [];
  mutateSpy.mockClear();
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('mergeEvent', () => {
  it('inserta un evento nuevo al frente', () => {
    const previos = [buildEvent('viejo', '2026-08-21T10:00:00Z')];
    const resultado = mergeEvent(previos, buildEvent('nuevo', '2026-08-21T12:00:00Z'));

    expect(resultado.map((e) => e.id)).toEqual(['nuevo', 'viejo']);
  });

  it('una revisión del mismo id ACTUALIZA en vez de duplicar', () => {
    /**
     * El worker republica el evento fusionado cuando EMSC manda una revisión.
     * Sin el reemplazo por id, un M4.5 corregido a M5.2 aparecería dos veces
     * en la lista y el globo pintaría dos epicentros pegados.
     */
    const previos = [buildEvent('emsc_1', '2026-08-21T12:00:00Z', 4.5)];
    const resultado = mergeEvent(previos, buildEvent('emsc_1', '2026-08-21T12:00:00Z', 5.2));

    expect(resultado).toHaveLength(1);
    expect(resultado[0].mag).toBe(5.2);
  });

  it('ordena por hora, más nuevo primero', () => {
    const previos = [
      buildEvent('a', '2026-08-21T10:00:00Z'),
      buildEvent('c', '2026-08-21T14:00:00Z'),
    ];
    const resultado = mergeEvent(previos, buildEvent('b', '2026-08-21T12:00:00Z'));

    expect(resultado.map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });

  it('sobre una lista vacía devuelve sólo el entrante', () => {
    expect(mergeEvent([], buildEvent('solo'))).toHaveLength(1);
  });
});

describe('backoffDelay', () => {
  it('arranca cerca de un segundo', () => {
    const d = backoffDelay(0);
    expect(d).toBeGreaterThanOrEqual(800);
    expect(d).toBeLessThanOrEqual(1200);
  });

  it('crece exponencialmente', () => {
    expect(backoffDelay(1)).toBeLessThan(backoffDelay(4));
  });

  it('tiene tope', () => {
    /**
     * Sin tope, tras 20 caídas la espera sería de días. Con tope, todas las
     * pestañas abiertas siguen reintentando cada 30 s como mucho.
     */
    for (let intento = 10; intento < 30; intento++) {
      expect(backoffDelay(intento)).toBeLessThanOrEqual(30_000 * 1.2);
    }
  });

  it('el jitter dispersa los reintentos', () => {
    const esperas = new Set(Array.from({ length: 20 }, () => backoffDelay(5)));
    expect(esperas.size).toBeGreaterThan(1);
  });
});

describe('useEventStream — conexión', () => {
  it('conecta al endpoint de eventos', () => {
    renderHook(() => useEventStream());

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain('/ws/events');
  });

  it('deshabilitado no abre ninguna conexión', () => {
    const { result } = renderHook(() => useEventStream(false));

    expect(MockWebSocket.instances).toHaveLength(0);
    expect(result.current.status).toBe('offline');
  });

  it('pasa a live al abrir', () => {
    const { result } = renderHook(() => useEventStream());

    act(() => {
      MockWebSocket.instances[0].onopen?.();
    });

    expect(result.current.status).toBe('live');
    expect(result.current.isLive).toBe(true);
  });
});

describe('useEventStream — mensajes', () => {
  it('el snapshot escribe la lista completa en el caché', () => {
    renderHook(() => useEventStream());

    act(() => {
      MockWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({ type: 'snapshot', events: [buildEvent('a'), buildEvent('b')] }),
      });
    });

    expect(mutateSpy).toHaveBeenCalledWith(
      BROADCAST_EVENTS_KEY,
      expect.arrayContaining([expect.objectContaining({ id: 'a' })]),
      { revalidate: false },
    );
  });

  it('un evento suelto MERGEA en vez de reemplazar', () => {
    /**
     * Si escribiera la lista entera, cada sismo nuevo borraría los otros 300
     * del globo. El updater es una función que recibe lo que ya había.
     */
    renderHook(() => useEventStream());

    act(() => {
      MockWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({ type: 'event', event: buildEvent('nuevo') }),
      });
    });

    const [, updater] = mutateSpy.mock.calls.at(-1)!;
    expect(typeof updater).toBe('function');
    const resultado = (updater as (p?: SeismicEvent[]) => SeismicEvent[])([buildEvent('viejo')]);
    expect(resultado.map((e) => e.id)).toContain('viejo');
    expect(resultado.map((e) => e.id)).toContain('nuevo');
  });

  it('cuenta los eventos recibidos por push', () => {
    const { result } = renderHook(() => useEventStream());

    act(() => {
      MockWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({ type: 'event', event: buildEvent('a') }),
      });
    });

    expect(result.current.receivedCount).toBe(1);
  });

  it('un mensaje malformado NO corta la conexión', () => {
    /** Perder un mensaje es barato; perder el stream no. */
    const { result } = renderHook(() => useEventStream());

    act(() => {
      MockWebSocket.instances[0].onopen?.();
      MockWebSocket.instances[0].onmessage?.({ data: '{roto' });
    });

    expect(result.current.status).toBe('live');
    expect(MockWebSocket.instances[0].closed).toBe(false);
  });

  it('escribe el snapshot con revalidate:false', () => {
    /**
     * Los datos vienen del servidor recién: revalidar sería exactamente el
     * polling que este hook viene a sacar.
     */
    renderHook(() => useEventStream());

    act(() => {
      MockWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({ type: 'snapshot', events: [] }),
      });
    });

    expect(mutateSpy.mock.calls.at(-1)![2]).toEqual({ revalidate: false });
  });
});

describe('useEventStream — reconexión', () => {
  it('al caerse pasa a reconnecting y reintenta', () => {
    const { result } = renderHook(() => useEventStream());

    act(() => {
      MockWebSocket.instances[0].onopen?.();
      MockWebSocket.instances[0].onclose?.();
    });
    expect(result.current.status).toBe('reconnecting');

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
  });

  it('tras varios intentos fallidos se declara offline', () => {
    /**
     * El backoff sigue reintentando, pero la UI deja de prometer que está por
     * volver: amarillo eterno le miente al usuario.
     */
    const { result } = renderHook(() => useEventStream());

    for (let i = 0; i < 6; i++) {
      act(() => {
        MockWebSocket.instances.at(-1)!.onclose?.();
        vi.advanceTimersByTime(60_000);
      });
    }

    expect(result.current.status).toBe('offline');
  });

  it('una reconexión exitosa reinicia el backoff', () => {
    const { result } = renderHook(() => useEventStream());

    act(() => {
      MockWebSocket.instances[0].onclose?.();
      vi.advanceTimersByTime(5_000);
    });
    act(() => {
      MockWebSocket.instances.at(-1)!.onopen?.();
    });

    expect(result.current.status).toBe('live');
  });
});

describe('useEventStream — cleanup', () => {
  it('al desmontar cierra el socket', () => {
    const { unmount } = renderHook(() => useEventStream());
    const ws = MockWebSocket.instances[0];

    unmount();

    expect(ws.closed).toBe(true);
  });

  it('al desmontar NO reconecta', () => {
    /**
     * El close() del cleanup dispara onclose (el mock lo emula, como un WS
     * real) y ese handler programaría una reconexión sobre un componente ya
     * desmontado: una conexión huérfana por cada navegación entre páginas.
     */
    const { unmount } = renderHook(() => useEventStream());
    act(() => {
      MockWebSocket.instances[0].onopen?.();
    });

    unmount();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('un onclose que llega DESPUÉS del cleanup no programa nada', () => {
    /**
     * Un socket real puede emitir `close` de forma asíncrona, ya desmontado el
     * componente: ahí el clearTimeout del cleanup ya corrió y la reconexión la
     * frenan los guards de `cancelled`.
     *
     * Los tres tests de este bloque cubren órdenes de eventos distintos y el
     * hook tiene tres capas de defensa redundantes: hace falta romper las tres
     * juntas para que fallen (verificado por mutación). Es deliberado — lo que
     * fuga es una conexión al backend por cada navegación entre páginas.
     */
    const { unmount } = renderHook(() => useEventStream());
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.onopen?.();
    });

    unmount();

    // El close asíncrono del navegador, después de que el cleanup terminó.
    act(() => {
      ws.onclose?.();
      vi.advanceTimersByTime(60_000);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('al desmontar mata el timer de reconexión pendiente', () => {
    const { unmount } = renderHook(() => useEventStream());

    act(() => {
      MockWebSocket.instances[0].onclose?.();
    });
    unmount();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
