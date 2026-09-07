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

/**
 * Dominio del eje de profundidad, en la MISMA convención que el dato:
 * positivo hacia abajo. Presentación pura, no toca el signo de nada.
 *
 * Se calcula a mano en vez de dejárselo a Recharts porque su dominio
 * automático "redondeaba" el eje hacia el lado equivocado y terminaba
 * dibujando ticks negativos hacia arriba con datos positivos.
 *
 * El piso es 0 (la superficie es la referencia del corte), salvo que haya un
 * hipocentro SOBRE el nivel del mar: ahí el eje se abre hasta ese negativo
 * para que el punto entre, y queda dibujado por encima de la línea de 0.
 */
export function depthAxisDomain(depths: number[]): [number, number] {
  if (depths.length === 0) return [0, 1];

  const min = Math.min(0, ...depths);
  const max = Math.max(...depths);

  // min === max dejaría el eje sin alto y el punto no se vería.
  return min === max ? [min, min + 1] : [min, max];
}

/**
 * Tick del eje de profundidad. Los positivos son profundidad bajo la
 * superficie; un negativo es un evento SOBRE el nivel del mar y conserva el
 * signo, porque mostrarlo como positivo mentiría sobre dónde ocurrió.
 */
export function formatDepthTick(value: number): string {
  return `${Math.round(value * 10) / 10}`;
}
