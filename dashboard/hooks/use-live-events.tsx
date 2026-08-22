'use client';

/**
 * Provider del stream de eventos (PR-W4, T13).
 *
 * Por qué un provider y no llamar `useEventStream()` donde haga falta: cada
 * llamada abre SU PROPIO WebSocket. El sidebar y la cartelera del globo
 * necesitan el mismo estado de conexión, y dos conexiones al mismo endpoint
 * serían el doble de snapshots de 24 h por pestaña abierta.
 *
 * Dónde se monta: `app/(app)/layout.tsx`. Cubre a los dos consumidores aunque
 * GlobeBroadcastOverlay se renderice por portal a document.body — el portal
 * mueve el DOM, no el árbol de React, así que el contexto le llega igual.
 */

import { createContext, useContext, type ReactNode } from 'react';

import { useEventStream, type EventStream } from '@/hooks/use-event-stream';

const FALLBACK: EventStream = { status: 'offline', isLive: false, receivedCount: 0 };

const LiveEventsContext = createContext<EventStream>(FALLBACK);

export function LiveEventsProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const stream = useEventStream(enabled);
  return <LiveEventsContext.Provider value={stream}>{children}</LiveEventsContext.Provider>;
}

/**
 * Estado del stream compartido.
 *
 * Fuera del provider devuelve 'offline' en vez de romper: así un componente
 * que se renderiza en un test o en una página sin provider cae al polling de
 * respaldo, que es el comportamiento correcto, en lugar de tirar la pantalla.
 */
export function useLiveEvents(): EventStream {
  return useContext(LiveEventsContext);
}
