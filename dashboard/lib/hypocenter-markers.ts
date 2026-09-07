/**
 * Estilo de los marcadores del mapa de hipocentros
 * (analytics-professional-panels, 4.5; design Decision 5).
 *
 * Lógica PURA, sin Leaflet: devuelve las opciones que `HypocenterMap`
 * pasa a `L.circleMarker`. Color por profundidad con `getDepthColor` — los
 * MISMOS cortes que `DepthDistributionChart` — y radio por magnitud.
 *
 * [R26] / M14: un evento con `prof_km === null` NO pasa por `getDepthColor`.
 * `getDepthColor(0)` daría el rojo de "< 70 km", una mentira: no sabemos la
 * profundidad. Recibe un estilo "sin profundidad" distinguible (relleno
 * transparente, borde gris punteado) y el popup dice "sin profundidad".
 *
 * Profundidad NEGATIVA (observado en prod: `-35.0`, fuentes EMSC/USGS,
 * hipocentro sobre el nivel del mar) SÍ es un dato: es superficial y se
 * pinta como `< 70 km`. Solo `null`/no finito es "sin profundidad".
 */

import type { SeismicEvent } from './types';
import { getDepthColor } from './utils';

/** Radio mínimo en px: un M1 tiene que verse. */
export const MIN_MARKER_RADIUS = 3;

/** Radio en px, monótono con la magnitud (M4 ≈ 9, M7 ≈ 15). Magnitud no
 * finita o negativa ⇒ el mínimo. */
export function markerRadius(mag: number): number {
  if (!Number.isFinite(mag) || mag < 0) return MIN_MARKER_RADIUS;
  return MIN_MARKER_RADIUS + mag * 1.75;
}

/** Subconjunto de `L.CircleMarkerOptions` que el mapa usa; `kind` es para los
 * tests y para el popup, Leaflet lo ignora. */
export interface MarkerStyle {
  kind: 'depth' | 'no-depth';
  radius: number;
  fillColor: string;
  fillOpacity: number;
  color: string;
  weight: number;
  opacity: number;
  dashArray?: string;
}

const NO_DEPTH_STROKE = '#9ca3af';

export function markerStyle(ev: SeismicEvent): MarkerStyle {
  const radius = markerRadius(ev.mag);
  if (ev.prof_km === null || !Number.isFinite(ev.prof_km)) {
    return {
      kind: 'no-depth',
      radius,
      fillColor: 'transparent',
      fillOpacity: 0,
      color: NO_DEPTH_STROKE,
      weight: 1.5,
      opacity: 0.9,
      dashArray: '3 3',
    };
  }
  const color = getDepthColor(ev.prof_km);
  return {
    kind: 'depth',
    radius,
    fillColor: color,
    fillOpacity: 0.75,
    color,
    weight: 1,
    opacity: 0.9,
  };
}

export interface TruncationNotice {
  total: number;
  shown: number;
}

/** Args del aviso "Mostrando {shown} de {total}"; `null` si no se recortó
 * (incluida una respuesta incoherente con `total < shown`). */
export function truncationNotice(total: number, shown: number): TruncationNotice | null {
  return total > shown ? { total, shown } : null;
}

export interface PopupArgs {
  id: string;
  mag: number;
  /** `null` ⇒ "sin profundidad". */
  depth: number | null;
  timeUtc: string;
  place: string | null;
  magType: string | null;
}

export function popupArgs(ev: SeismicEvent): PopupArgs {
  return {
    id: ev.id,
    mag: ev.mag,
    depth: ev.prof_km !== null && Number.isFinite(ev.prof_km) ? ev.prof_km : null,
    timeUtc: ev.hora_utc,
    place: ev.lugar,
    magType: ev.mag_tipo,
  };
}
