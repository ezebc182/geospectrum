/**
 * Corte de profundidad de /analytics (analytics-professional-panels, 5.9).
 *
 * Lógica PURA, sin Recharts: convierte los eventos de `/analytics/hypocenters`
 * en los puntos del scatter magnitud-vs-profundidad.
 *
 * Regla dura, la misma que `hypocenter-markers` (M14): un evento sin
 * profundidad NO se dibuja con un `?? 0`. Un punto en 0 km diría "superficial"
 * cuando lo que sabemos es "no sabemos". Se omite Y se cuenta, para que el
 * panel pueda decir cuántos quedaron afuera en vez de perderlos en silencio.
 *
 * Profundidad NEGATIVA sí es un dato (hipocentro sobre el nivel del mar,
 * observado en prod con fuentes EMSC/USGS) y entra al corte tal cual.
 */

import type { SeismicEvent } from './types';
import { getMagnitudeColor } from './utils';

export interface DepthSectionPoint {
  id: string;
  mag: number;
  depthKm: number;
  /** Color por magnitud, el MISMO que usa el resto de la app. */
  color: string;
  lugar: string | null;
}

export interface DepthSectionData {
  points: DepthSectionPoint[];
  /** Cuántos eventos quedaron afuera por no tener profundidad. */
  omitted: number;
}

export function toDepthSectionPoints(eventos: SeismicEvent[]): DepthSectionData {
  const points: DepthSectionPoint[] = [];
  let omitted = 0;

  for (const ev of eventos) {
    if (ev.prof_km === null || !Number.isFinite(ev.prof_km)) {
      omitted += 1;
      continue;
    }
    points.push({
      id: ev.id,
      mag: ev.mag,
      depthKm: ev.prof_km,
      color: getMagnitudeColor(ev.mag),
      lugar: ev.lugar,
    });
  }

  return { points, omitted };
}
