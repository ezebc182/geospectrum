/**
 * Utilidades puras para el cálculo de "eventos en área visible" del mapa.
 * Extraído de AdvancedSeismicMap para ser testeable sin necesidad de una
 * instancia real de Leaflet (Decisión 4 de design.md, tarea 3.7 de tasks.md).
 */

import type { SeismicEvent } from './types';

/** Subconjunto mínimo de L.LatLngBounds que esta utilidad necesita. */
export interface BoundsLike {
  contains(latLng: [number, number]): boolean;
}

export interface EventsInBoundsCount {
  visible: number;
  total: number;
}

/**
 * Cuenta cuántos `eventos` caen dentro de `bounds` (bounding box visible del mapa).
 * `total` es siempre `eventos.length`, sin división por cero cuando está vacío.
 */
export function countEventsInBounds(eventos: SeismicEvent[], bounds: BoundsLike): EventsInBoundsCount {
  const total = eventos.length;
  if (total === 0) {
    return { visible: 0, total: 0 };
  }
  const visible = eventos.filter((e) => bounds.contains([e.lat, e.lon])).length;
  return { visible, total };
}
