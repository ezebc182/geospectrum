/**
 * Revalida los datos de una página cuando cambia el área de interés activa, y
 * expone si esa revalidación sigue en curso.
 *
 * El selector vive en el header del layout, así que el aviso no puede llegar
 * por props ni por un callback: llega por un evento de window (ver
 * lib/area-events.ts).
 *
 * Uso típico — hay que refrescar TODO lo que dependa del área, no sólo el
 * reporte. En /live son dos cosas: el reporte (que el backend recorta) y el
 * área en sí (para redibujar el polígono del mapa). Devolver la promesa de
 * `Promise.all` es lo que hace que `isRefreshingArea` cubra a las DOS: si se
 * devuelve una sola, el indicador se apaga mientras la otra sigue viajando.
 *
 *   const { data, mutate } = useSWR('/report', reportFetcher);
 *   const { mutate: mutateArea } = useSWR('/areas/active', getActiveArea);
 *   const isRefreshingArea = useAreaRefresh(() =>
 *     Promise.all([mutate(), mutateArea()])
 *   );
 *
 * Un handler que no devuelve nada también es válido: en ese caso el hook no
 * tiene nada que esperar y `isRefreshingArea` queda en false.
 */

'use client';

import { useEffect, useRef, useState } from 'react';

import { onAreaChanged } from '@/lib/area-events';

export function useAreaRefresh(handler: () => void | Promise<unknown>): boolean {
  // El callback se guarda en un ref para que la suscripción se haga UNA vez y
  // no en cada render: los llamadores pasan arrow functions inline, que cambian
  // de identidad siempre, y con `handler` en las deps estaríamos des/re-
  // suscribiendo el listener en cada pintada.
  const handlerRef = useRef(handler);

  // Se actualiza en cada render, así el listener siempre invoca la versión
  // fresca del callback y nunca una clausura vieja.
  handlerRef.current = handler;

  const [isRefreshing, setIsRefreshing] = useState(false);

  // Contador de revalidaciones para descartar las que quedaron obsoletas. Si el
  // usuario cambia de área dos veces seguidas, la promesa de la PRIMERA puede
  // resolver después de que arrancó la segunda: sin este chequeo apagaría el
  // indicador con la segunda todavía en vuelo. Es un ref y no estado porque se
  // lee dentro de la promesa, donde el estado estaría congelado.
  const runIdRef = useRef(0);

  // Evita un setState sobre un componente ya desmontado: la revalidación puede
  // resolver después de que el usuario navegó a otra página.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // Se lee `handlerRef.current` DENTRO del listener, no afuera: leerlo al
    // suscribirse congelaría el callback del primer render.
    return onAreaChanged(() => {
      const runId = ++runIdRef.current;
      const result = handlerRef.current();

      // Un handler síncrono no tiene nada que esperar: no se enciende el
      // indicador para no producir un parpadeo de un frame.
      if (!isPromiseLike(result)) return;

      setIsRefreshing(true);
      // Se traga el error en vez de encadenar `.finally`: si la revalidación
      // falla, el indicador TIENE que apagarse igual, y una cadena con
      // `.finally` volvería a propagar el rechazo como unhandled rejection.
      // Reportar el error no es tarea de este hook — SWR ya expone `error` a
      // quien llama; acá sólo se apaga la señal, porque dejar la barra girando
      // para siempre sería peor que el bug original.
      const stop = () => {
        if (!mountedRef.current) return;
        if (runId !== runIdRef.current) return;
        setIsRefreshing(false);
      };
      Promise.resolve(result).then(stop, stop);
    });
  }, []);

  return isRefreshing;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}
