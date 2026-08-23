/**
 * Decide si lo que muestra un espectrograma sigue valiendo como "ahora".
 *
 * Existe porque la UI mentía en silencio: al cortarse el WebSocket, el
 * `lastUpdate` de LiveSpectrogramCanvas quedaba clavado en el último mensaje
 * recibido y la etiqueta lo seguía mostrando igual que un dato de hace 5
 * segundos. Con eso, once tarjetas de producción rotuladas "1:57 AM UTC"
 * hicieron diagnosticar un backend caído que en realidad tenía columnas de
 * hace UN segundo.
 *
 * Igual que ChannelWatchdog en el backend (src/services/channel_watchdog.py),
 * acá vive SOLO la decisión: sin canvas, sin WebSocket, sin reloj propio. El
 * `now` entra por parámetro para poder testear con timestamps fijos.
 */

/**
 * Un dato con más de esta antigüedad ya no es "en vivo".
 *
 * Es el mismo STALE_AFTER_SECONDS de src/services/seedlink_ingestor.py, donde
 * un canal mudo por 5 min dispara reconexión. Reusar el número —en vez de
 * elegir uno propio— evita que el backend dé por muerto un canal que la UI
 * sigue pintando como sano.
 */
export const STALE_AFTER_SECONDS = 300;

/** Estado del WebSocket, tal como lo maneja LiveSpectrogramCanvas. */
export type ConnectionStatus = 'connecting' | 'live' | 'error';

/**
 * - `connecting`: todavía no llegó ninguna columna; no hay nada que juzgar.
 * - `live`: hay dato y es reciente.
 * - `stale`: el dato pasó el umbral, o se perdió la conexión que lo mantenía
 *   fresco. Los dos casos se muestran igual porque significan lo mismo para
 *   quien mira: esto no es el ahora.
 */
export type Freshness = 'connecting' | 'live' | 'stale';

/**
 * @param endtime  timestamp de la última columna pintada (ISO), o null si aún
 *                 no llegó ninguna.
 * @param now      momento de referencia (inyectado para poder testearlo).
 * @param status   estado del WebSocket que alimenta el canvas.
 */
export function freshnessOf(
  endtime: string | null,
  now: Date,
  status: ConnectionStatus
): Freshness {
  // Sin dato no hay antigüedad que medir: un canvas llenándose no es viejo.
  if (endtime === null) return 'connecting';

  // Un socket caído congela `endtime`: por reciente que sea el último valor,
  // ya no se puede afirmar que siga vigente.
  if (status !== 'live') return 'stale';

  const parsed = Date.parse(endtime);
  // Ante un timestamp ilegible se degrada: mostrar de más un cartel de "viejo"
  // no lastima a nadie, afirmar "en vivo" sin saberlo es el fallo caro.
  if (Number.isNaN(parsed)) return 'stale';

  const ageSeconds = (now.getTime() - parsed) / 1000;
  // El desfasaje de reloj navegador/servidor da edades levemente negativas y
  // eso es normal: sólo el exceso positivo cuenta como dato viejo.
  return ageSeconds > STALE_AFTER_SECONDS ? 'stale' : 'live';
}
