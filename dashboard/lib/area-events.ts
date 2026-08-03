/**
 * Señal de "cambió el área de interés activa".
 *
 * Vive en lib/ y no en el componente del header porque quien la escucha son
 * las páginas (dashboard, /live), y hacerlas importar de `@/components/AreaHeader`
 * las acoplaba a un detalle de presentación: el día que el selector se mueva a
 * otro lado, se rompen todos los consumidores.
 *
 * Es un evento de `window` y no un contexto de React porque el emisor (el
 * header, en el layout) y los consumidores (las páginas, dentro de `children`)
 * son hermanos en el árbol. Un contexto exigiría envolver el layout entero en
 * un provider cliente sólo para pasar una señal sin payload.
 */

/** Nombre del evento. Namespaceado para no chocar con eventos de terceros. */
export const AREA_CHANGED_EVENT = 'geospectrum:area-changed';

/** Avisa a las páginas montadas que el área activa cambió. */
export function emitAreaChanged(): void {
  window.dispatchEvent(new CustomEvent(AREA_CHANGED_EVENT));
}

/**
 * Suscribe un callback al cambio de área y devuelve la función para
 * desuscribirse. Pensado para usarse desde `useAreaRefresh`.
 */
export function onAreaChanged(handler: () => void): () => void {
  window.addEventListener(AREA_CHANGED_EVENT, handler);
  return () => window.removeEventListener(AREA_CHANGED_EVENT, handler);
}
