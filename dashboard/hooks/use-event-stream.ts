'use client';

/**
 * Stream de eventos sísmicos en vivo por WebSocket (PR-W4, T11).
 *
 * Reemplaza el polling encadenado que hacía que un sismo tardara 1-2 minutos
 * en verse: frontend cada 30 s → caché 30 s → USGS cada 60 s. Ahora el worker
 * escucha el push de EMSC y lo empuja hasta acá en segundos.
 *
 * Diferencias deliberadas con el WS de espectrogramas (LiveSpectrogramCanvas):
 *
 * - Backoff EXPONENCIAL con jitter, no los 3000 ms fijos de aquel. El spec lo
 *   pide (spectronet-wall-design.md:112) y la razón es distinta: si el backend
 *   se cae, todas las pestañas abiertas reconectarían cada 3 s para siempre.
 * - Cuatro estados en vez de tres: 'reconnecting' se distingue de 'offline'
 *   porque el indicador los pinta distinto (amarillo vs rojo) y el usuario
 *   necesita saber si esperar o recargar.
 *
 * Lo que NO hace: guardar los eventos. Los escribe en el caché de SWR bajo la
 * key que ya usa la cartelera, así toda la cadena de useMemo del globo sigue
 * funcionando sin tocar una línea. El estado global de esta app ES el caché de
 * SWR (ver NotificationBell.tsx:37).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';

import type { SeismicEvent } from '@/lib/types';
import { wsUrl } from '@/lib/ws-base';

/**
 * - connecting: primer intento, todavía sin respuesta
 * - live: conectado y recibiendo
 * - reconnecting: se cayó y está reintentando (el fallback de polling se activa)
 * - offline: se agotaron los reintentos o el navegador no soporta WebSocket
 */
export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** Key de SWR de la cartelera del globo. Debe coincidir con GlobeBroadcastOverlay. */
export const BROADCAST_EVENTS_KEY = 'broadcast-events';

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_FACTOR = 2;
const BACKOFF_JITTER = 0.2;

/**
 * Tras estos intentos fallidos seguidos se pasa a 'offline'. No se deja de
 * reintentar —el backoff ya está en el tope— pero la UI deja de prometer que
 * está por volver.
 */
const ATTEMPTS_BEFORE_OFFLINE = 4;

type StreamMessage =
  | { type: 'snapshot'; events: SeismicEvent[] }
  | { type: 'event'; event: SeismicEvent };

/** Espera del intento `attempt` (0-based), con jitter para dispersar reconexiones. */
export function backoffDelay(attempt: number): number {
  const base = Math.min(INITIAL_BACKOFF_MS * BACKOFF_FACTOR ** attempt, MAX_BACKOFF_MS);
  const jitter = base * BACKOFF_JITTER;
  return Math.max(0, base + (Math.random() * 2 - 1) * jitter);
}

/**
 * Inserta o actualiza un evento en la lista, manteniendo el orden por hora
 * (más nuevo primero).
 *
 * Actualiza y no sólo inserta porque el worker republica el evento fusionado
 * cuando EMSC manda una revisión: sin el reemplazo por id, un M4.5 corregido a
 * M5.2 aparecería dos veces en la lista.
 */
export function mergeEvent(events: SeismicEvent[], incoming: SeismicEvent): SeismicEvent[] {
  const sinDuplicado = events.filter((e) => e.id !== incoming.id);
  return [incoming, ...sinDuplicado].sort(
    (a, b) => new Date(b.hora_utc).getTime() - new Date(a.hora_utc).getTime(),
  );
}

export type EventStream = {
  status: StreamStatus;
  /** true mientras el WS entrega: el polling de respaldo se apaga con esto. */
  isLive: boolean;
  /** Cuántos eventos llegaron por push desde que se montó (para depurar). */
  receivedCount: number;
};

export function useEventStream(enabled = true): EventStream {
  const { mutate } = useSWRConfig();
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [receivedCount, setReceivedCount] = useState(0);

  // `mutate` es estable en SWR, pero tenerlo por ref evita que un cambio de
  // identidad reinicie la conexión: la trampa del proyecto es al revés (un
  // efecto que lee un ref sin tenerlo en deps corre una vez y nunca más), y acá
  // el ref es correcto justamente porque NO queremos re-ejecutar el efecto.
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;

  const applySnapshot = useCallback((events: SeismicEvent[]) => {
    // `revalidate: false`: los datos vienen del servidor recién, pedirlos otra
    // vez por REST sería exactamente el polling que este hook viene a sacar.
    mutateRef.current(BROADCAST_EVENTS_KEY, events, { revalidate: false });
  }, []);

  const applyEvent = useCallback((incoming: SeismicEvent) => {
    mutateRef.current(
      BROADCAST_EVENTS_KEY,
      (actuales: SeismicEvent[] | undefined) => mergeEvent(actuales ?? [], incoming),
      { revalidate: false },
    );
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus('offline');
      return;
    }
    if (typeof WebSocket === 'undefined') {
      setStatus('offline');
      return;
    }

    // Cleanup con UN flag (`cancelled`) leído en tres puntos: la entrada de
    // `connect()`, el handler `onclose`, y el `clearTimeout` del return.
    //
    // Las tres son redundantes entre sí — medido por mutación: desactivar
    // cualquiera por separado no cambia nada observable, y hay que romper las
    // tres juntas para que los tests de cleanup fallen. Se dejan igual porque
    // lo que fuga acá es una conexión al backend por cada navegación entre
    // páginas, y cada capa tapa un orden distinto de eventos según el
    // navegador (close síncrono, close asíncrono, timer ya encolado).
    //
    // LiveSpectrogramCanvas (:144-149) usa dos flags para esto; acá alcanza
    // con uno porque `cancelled` cubre los dos roles.
    let ws: WebSocket | undefined;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const connect = () => {
      if (cancelled) return;

      ws = new WebSocket(wsUrl('/ws/events'));

      ws.onopen = () => {
        if (cancelled) return;
        attempt = 0; // conexión exitosa: el backoff vuelve a cero
        setStatus('live');
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        let message: StreamMessage;
        try {
          message = JSON.parse(event.data);
        } catch {
          // Mensaje malformado: se ignora, no corta la conexión. Perder un
          // mensaje es barato; perder el stream no.
          return;
        }

        if (message.type === 'snapshot') {
          applySnapshot(message.events ?? []);
          setStatus('live');
        } else if (message.type === 'event' && message.event) {
          applyEvent(message.event);
          setReceivedCount((n) => n + 1);
          setStatus('live');
        }
      };

      ws.onerror = () => {
        // No se cambia el estado acá: onclose viene siempre después y es el
        // que sabe si hay que reintentar. Pisarlo acá haría parpadear el
        // indicador entre rojo y amarillo.
      };

      ws.onclose = () => {
        if (cancelled) return;

        const delay = backoffDelay(attempt);
        attempt += 1;
        setStatus(attempt > ATTEMPTS_BEFORE_OFFLINE ? 'offline' : 'reconnecting');
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      // El orden importa: `cancelled` PRIMERO, porque ws.close() dispara
      // onclose de forma síncrona en algunos navegadores y ese handler tiene
      // que ver la bandera ya levantada.
      cancelled = true;
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [enabled, applySnapshot, applyEvent]);

  return { status, isLive: status === 'live', receivedCount };
}
