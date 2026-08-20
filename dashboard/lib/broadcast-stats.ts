/**
 * Contadores del modo transmisión (referencia visual: streams tipo
 * "Earthquakes Live"): total de las últimas 24 h, y cuántos ≥M5 / ≥M6
 * lleva el día UTC en curso. Lógica pura, separada del componente para
 * poder testearla sin jsdom ni WebSocket (el patrón de lib/globe-data.ts).
 */

import type { SeismicEvent } from './types';

export interface BroadcastStats {
  last24h: number;
  todayM5: number;
  todayM6: number;
}

/**
 * `now` se inyecta (ISO UTC) en vez de leerse adentro: los tests fijan el
 * instante y el componente pasa el timestamp del último refresco, así los
 * números y el "actualizado a las..." del HUD siempre son coherentes.
 */
export function computeBroadcastStats(eventos: SeismicEvent[], now: Date): BroadcastStats {
  const cutoff24h = now.getTime() - 24 * 60 * 60 * 1000;
  // "Hoy" es el día UTC, como en los streams de referencia (todas las horas
  // del feed sísmico son UTC; usar el día local del espectador partiría el
  // conteo en un lugar distinto para cada huso horario).
  const todayUtc = now.toISOString().slice(0, 10);

  let last24h = 0;
  let todayM5 = 0;
  let todayM6 = 0;

  for (const evento of eventos) {
    const t = new Date(evento.hora_utc);
    if (t.getTime() >= cutoff24h && t.getTime() <= now.getTime()) {
      last24h++;
    }
    if (evento.hora_utc.slice(0, 10) === todayUtc) {
      if (evento.mag >= 5) todayM5++;
      if (evento.mag >= 6) todayM6++;
    }
  }

  return { last24h, todayM5, todayM6 };
}
