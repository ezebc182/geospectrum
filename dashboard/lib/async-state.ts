/**
 * Los cuatro estados en que puede estar un dato que se pide a la red.
 *
 * POR QUÉ EXISTE: la app resolvía la carga con `datos ?? []`, que colapsa
 * "todavía no llegó" y "no hay nada" en el mismo valor. El globo recibía una
 * lista vacía mientras cargaba y se dibujaba pelado — indistinguible de "no
 * hubo sismos en 24 h". El relevamiento encontró ~12 lugares con ese patrón.
 *
 * Es la misma clase de error que la UI que mostraba un espectrograma de hace
 * 21 h con la cara de uno en vivo: fingir un valor por defecto en vez de
 * modelar la ausencia (ver lib/spectrogram-freshness.ts).
 *
 * La decisión vive acá, separada del render, para poder testearla sin montar
 * ningún componente — mismo criterio que ChannelWatchdog en el backend.
 */

export type AsyncState = 'loading' | 'empty' | 'ready' | 'error';

/**
 * @param data  el `data` de useSWR (o cualquier fetch): `undefined` mientras
 *              no hay respuesta.
 * @param error el `error` de useSWR, si lo hay.
 */
export function asyncStateOf(data: unknown, error?: unknown): AsyncState {
  // El error manda: con SWR el dato viejo sobrevive al fallo del refetch, y
  // mostrarlo como si nada dejaría la pantalla con datos rancios sin aviso.
  if (error) return 'error';

  // `null` cuenta como ausencia: varios endpoints del proyecto devuelven null
  // en vez de omitir el campo (getActiveArea, por ejemplo).
  if (data === undefined || data === null) return 'loading';

  // "Vacío" sólo tiene sentido para colecciones; un objeto presente ya es
  // una respuesta completa.
  if (Array.isArray(data)) return data.length === 0 ? 'empty' : 'ready';

  return 'ready';
}
