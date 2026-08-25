/**
 * Ventana de onda: qué tramo se está mirando, su dato, y la pila para volver.
 *
 * El componente dibuja y captura gestos; este hook decide la ventana y pide el
 * dato. Esa separación es la que permite testear el zoom sin canvas y las
 * carreras de red sin pintar un píxel.
 *
 * Las tres invariantes de abajo NO son estilo: cada una corresponde a un bug
 * que este repo ya tuvo más de una vez.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type TimeWindow,
  clampWindow,
  windowToQuery,
} from '@/lib/waveform-scale';
import type { HelicorderFilter } from '@/lib/helicorder-settings';

/** Misma forma que devuelve `/stations/{channel}/waveform`. */
export interface WaveformResponse {
  channel: string;
  sampling_rate: number;
  starttime: string;
  endtime: string;
  mins: number[];
  maxs: number[];
}

export type WaveStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UseWaveWindowResult {
  window: TimeWindow | null;
  data: WaveformResponse | null;
  status: WaveStatus;
  canGoBack: boolean;
  /** Cambia la ventana y pushea la actual a la pila. */
  setWindow(w: TimeWindow): void;
  /** Vuelve a la ventana anterior. Sin pila, no hace nada. */
  goBack(): void;
  /** Vacía la pila y vuelve a la ventana inicial. */
  reset(): void;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

/** Pares min/max a pedir: ~1 por píxel útil de un canvas ancho. */
const POINTS = 2_000;

/** Tope de la pila: mirar hacia atrás 50 niveles ya es más de lo que nadie usa. */
const MAX_STACK = 50;

/**
 * Dos ventanas son la misma si sus dos extremos coinciden. Se compara por
 * valor y no por identidad porque cada zoom construye un objeto nuevo.
 */
function sameWindow(a: TimeWindow | null, b: TimeWindow | null): boolean {
  if (!a || !b) return a === b;
  return a.startMs === b.startMs && a.endMs === b.endMs;
}

export function useWaveWindow(
  channel: string,
  initial?: TimeWindow,
  filter: HelicorderFilter = 'none',
): UseWaveWindowResult {
  /**
   * INVARIANTE 1 — el estado arranca en `null` y se siembra por efecto.
   *
   * Prohibido `useState(initial ?? derivarDeAlgoAsync())`: con una prop que
   * llega después (y `initial` llega de un fetch del helicorder), el estado
   * queda clavado en el valor del primer render y NUNCA se recalcula. Este
   * repo tiene CUATRO variantes del mismo pecado.
   */
  const [window, setWindowState] = useState<TimeWindow | null>(null);

  /**
   * INVARIANTE 2 — la pila va en `useState`, NO en `useRef`.
   *
   * `canGoBack` se deriva de la pila y tiene que llegar al render. Con un ref
   * el botón "volver" quedaría deshabilitado aunque la pila tuviera diez
   * elementos, porque un ref no dispara re-render.
   *
   * Honestidad sobre la cobertura: HOY esto no es observable desde los tests
   * —se verificó por mutación y los 13 quedaron verdes con la pila en un ref—
   * porque las tres operaciones públicas mueven también la ventana, y ese
   * cambio de estado arrastra el render que hace visible el ref. Se queda en
   * `useState` igual: la primera operación que toque la pila SIN mover la
   * ventana rompería la versión con ref en silencio. El detalle está en
   * `use-wave-window.test.ts`.
   */
  const [stack, setStack] = useState<TimeWindow[]>([]);

  const [data, setData] = useState<WaveformResponse | null>(null);
  const [status, setStatus] = useState<WaveStatus>('idle');

  /**
   * INVARIANTE 3 — el `AbortController` vive en un ref, pero se USA dentro del
   * mismo efecto que lo crea. Ningún efecto lee un ref que no está en sus
   * deps: eso corre una vez y nunca más (pisado TRES veces en este repo).
   */
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Siembra y re-siembra, en UN SOLO efecto.
   *
   * La limpieza al cambiar de canal NO puede vivir en un efecto aparte con la
   * misma dep `channel`: React los corre en orden de declaración, el segundo
   * pisaría al primero y la ventana quedaría en `null` para siempre. Los dos
   * pasos son el mismo hecho ("empezar de nuevo en este canal") y por eso van
   * juntos.
   */
  const initialStartMs = initial?.startMs;
  const initialEndMs = initial?.endMs;
  useEffect(() => {
    setStack([]);

    if (initialStartMs === undefined || initialEndMs === undefined) {
      // Todavía no hay ventana que mirar (el helicorder no cargó, o se cambió
      // de canal): se limpia el dato viejo en vez de mostrar la onda de otra
      // estación bajo el nombre de ésta.
      setWindowState(null);
      setData(null);
      setStatus('idle');
      return;
    }

    // El dato viejo se descarta también acá: cambiar de estación conservando
    // la misma ventana dejaría la onda anterior en pantalla con el rótulo del
    // canal nuevo, que es peor que no mostrar nada.
    setData(null);
    setStatus('idle');
    setWindowState(clampWindow({ startMs: initialStartMs, endMs: initialEndMs }));
    // Las deps son los NÚMEROS, no el objeto `initial`: un objeto literal nuevo
    // en cada render del padre re-dispararía este efecto en bucle.
  }, [channel, initialStartMs, initialEndMs]);

  // El fetch. Depende de la ventana y del filtro, que son las dos cosas que
  // cambian el DATO (a diferencia de los multiplicadores, que sólo repintan).
  useEffect(() => {
    if (!window) return;

    // ① Abortar el request en vuelo antes de iniciar el siguiente: dos zooms
    //    rápidos no deben dejar dos respuestas compitiendo.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let cancelled = false;
    const requested = window;

    const load = async () => {
      setStatus('loading');
      try {
        const { start, end } = windowToQuery(requested);
        const res = await fetch(
          `${API_BASE}/stations/${encodeURIComponent(channel)}/waveform` +
            `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}` +
            `&points=${POINTS}&filter=${filter}`,
          { signal: controller.signal },
        );
        if (!res.ok) throw new Error(String(res.status));
        const wf: WaveformResponse = await res.json();

        // ④ La respuesta llegó, pero el request ya fue abortado: se descarta.
        //    `fetch` no siempre rechaza a tiempo, así que el chequeo es explícito.
        if (cancelled || controller.signal.aborted) return;

        // ⑤ Guarda de ventana tardía: si la ventana cambió mientras esta
        //    respuesta viajaba, aplicarla pintaría un tramo que el usuario ya
        //    no está mirando. Se compara contra lo PEDIDO, no contra el ref.
        setWindowState((current) => {
          if (sameWindow(current, requested)) {
            setData(wf);
            setStatus('ready');
          }
          return current;
        });
      } catch (err) {
        // Un abort no es un error del usuario: es el flujo normal de un zoom
        // rápido. Pintar "error" ahí sería un falso rojo en pantalla.
        if (cancelled || controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setStatus('error');
      }
    };

    load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [channel, window, filter]);

  const setWindow = useCallback((next: TimeWindow) => {
    const clamped = clampWindow(next);
    setWindowState((current) => {
      // Pedir la misma ventana no apila nada: si no, "volver atrás" repetiría
      // el mismo nivel varias veces.
      if (sameWindow(current, clamped)) return current;
      if (current) setStack((s) => [...s, current].slice(-MAX_STACK));
      return clamped;
    });
  }, []);

  const goBack = useCallback(() => {
    setStack((s) => {
      if (s.length === 0) return s;
      const previous = s[s.length - 1];
      setWindowState(previous);
      return s.slice(0, -1);
    });
  }, []);

  const reset = useCallback(() => {
    setStack([]);
    if (initialStartMs !== undefined && initialEndMs !== undefined) {
      setWindowState(clampWindow({ startMs: initialStartMs, endMs: initialEndMs }));
    }
  }, [initialStartMs, initialEndMs]);

  return {
    window,
    data,
    status,
    canGoBack: stack.length > 0,
    setWindow,
    goBack,
    reset,
  };
}
