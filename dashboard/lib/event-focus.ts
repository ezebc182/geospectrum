/**
 * Elección del evento a enfocar por la cámara del globo (spec §4).
 * Lib pura: la animación de cámara queda en el componente; acá solo se
 * decide QUÉ mirar, inyectando el azar para poder testear.
 */

import type { SeismicEvent } from './types';

export type FocusMode = 'random' | 'latest';

export const FOCUS_POOL_SIZE = 20;
export const FOCUS_INTERVAL_MS = 20_000;

function newestFirst(eventos: SeismicEvent[]): SeismicEvent[] {
  return [...eventos].sort((a, b) => (a.hora_utc < b.hora_utc ? 1 : -1));
}

export function pickSpotlight(
  mode: FocusMode,
  eventos: SeismicEvent[],
  lastId: string | null,
  rand: () => number
): SeismicEvent | null {
  if (eventos.length === 0) return null;
  const withCoords = eventos.filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon));
  if (withCoords.length === 0) return null;
  const ordered = newestFirst(withCoords);

  if (mode === 'latest') {
    const newest = ordered[0];
    // null = "no mover la cámara": el enfocado ya es el último recibido
    return newest.id === lastId ? null : newest;
  }

  const pool = ordered.slice(0, FOCUS_POOL_SIZE);
  const candidates = pool.length > 1 ? pool.filter((e) => e.id !== lastId) : pool;
  const index = Math.min(Math.floor(rand() * candidates.length), candidates.length - 1);
  return candidates[index] ?? null;
}

/**
 * Modo por defecto: 'latest'.
 *
 * Era 'random' cuando el globo se pensaba como cartelera decorativa —un
 * paseo por los últimos 20 sismos—. Con el push de eventos (PR-W4) el sismo
 * llega en segundos, así que lo esperable es que la cámara mire lo que
 * ACABA de pasar. Mostrar uno al azar mientras entra un M6 en vivo es
 * exactamente lo contrario de lo que un monitor sísmico tiene que hacer.
 *
 * 'random' sigue disponible en el selector de foco para el modo cartelera.
 */
export const DEFAULT_FOCUS_MODE: FocusMode = 'latest';

export function readFocusMode(search: string, stored: string | null): FocusMode {
  const fromQuery = new URLSearchParams(search).get('focus');
  if (fromQuery === 'random' || fromQuery === 'latest') return fromQuery;
  if (stored === 'random' || stored === 'latest') return stored;
  return DEFAULT_FOCUS_MODE;
}
