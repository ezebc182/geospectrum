/**
 * El área de interés activa, con la revalidación ya incluida.
 *
 * POR QUÉ EXISTE: la propagación del cambio de área es un CustomEvent de
 * window (ver `area-events.ts`), y suscribirse es opt-in. Leer el área con
 * `useSWR('/areas/active')` y suscribirse con `useAreaRefresh` eran DOS pasos,
 * y el segundo es olvidable — olvidarlo no da error ni warning: el componente
 * simplemente queda mudo y el usuario ve un control que no hace nada.
 *
 * Ya pasó tres veces en este repo: /explore (ver el comentario en
 * `explore/page.tsx`), el encuadre del globo (arreglado en 50632ee) y el
 * detalle de estación. No es un descuido repetido: es el diseño el que lo
 * produce.
 *
 * Acá los dos pasos son uno solo. No hay nada que olvidarse de llamar.
 *
 * La key de SWR se mantiene igual a la que ya usa el resto de la app, así que
 * todos los consumidores siguen deduplicando contra la misma entrada de cache.
 */

'use client';

import useSWR from 'swr';

import { getActiveArea } from '@/lib/areas';
import { useAreaRefresh } from '@/lib/use-area-refresh';

/** La misma key que ya usan `/live`, `/analytics` y el overlay del globo. */
export const ACTIVE_AREA_KEY = '/areas/active';

export function useActiveArea() {
  const { data, mutate } = useSWR(ACTIVE_AREA_KEY, getActiveArea);

  // Devolver la promesa es lo que hace que `isRefreshing` cubra la
  // revalidación entera; sin el return se apagaría antes de que llegue.
  const isRefreshing = useAreaRefresh(() => mutate());

  return { area: data, isRefreshing };
}
