/**
 * Revalida los datos de una página cuando cambia el área de interés activa.
 *
 * El selector vive en el header del layout, así que el aviso no puede llegar
 * por props ni por un callback: llega por un evento de window (ver
 * lib/area-events.ts).
 *
 * Uso típico — hay que refrescar TODO lo que dependa del área, no sólo el
 * reporte. En /live son dos cosas: el reporte (que el backend recorta) y el
 * área en sí (para redibujar el polígono del mapa).
 *
 *   const { data, mutate } = useSWR('/report', reportFetcher);
 *   const { mutate: mutateArea } = useSWR('/areas/active', getActiveArea);
 *   useAreaRefresh(() => { mutate(); mutateArea(); });
 */

'use client';

import { useEffect, useRef } from 'react';

import { onAreaChanged } from '@/lib/area-events';

export function useAreaRefresh(handler: () => void): void {
  // El callback se guarda en un ref para que la suscripción se haga UNA vez y
  // no en cada render: los llamadores pasan arrow functions inline, que cambian
  // de identidad siempre, y con `handler` en las deps estaríamos des/re-
  // suscribiendo el listener en cada pintada.
  const handlerRef = useRef(handler);

  // Se actualiza en cada render, así el listener siempre invoca la versión
  // fresca del callback y nunca una clausura vieja.
  handlerRef.current = handler;

  useEffect(() => {
    // Se lee `handlerRef.current` DENTRO del listener, no afuera: leerlo al
    // suscribirse congelaría el callback del primer render.
    return onAreaChanged(() => handlerRef.current());
  }, []);
}
