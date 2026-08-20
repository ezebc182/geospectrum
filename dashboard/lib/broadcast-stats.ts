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

/** Los `n` eventos más recientes, del más nuevo al más viejo (feed lateral). */
export function latestEvents(eventos: SeismicEvent[], n: number): SeismicEvent[] {
  return [...eventos].sort((a, b) => b.hora_utc.localeCompare(a.hora_utc)).slice(0, n);
}

/**
 * ¿El evento es lo bastante nuevo para resaltarlo como "recién llegado"?
 * Se mide contra la hora del sismo (no contra cuándo lo trajo el fetch):
 * simple y estable entre refrescos, que es lo que un HUD necesita.
 */
export function isFreshEvent(evento: SeismicEvent, now: Date, minutes: number = 15): boolean {
  const t = new Date(evento.hora_utc).getTime();
  return now.getTime() - t <= minutes * 60 * 1000 && t <= now.getTime();
}

/** "12:33:17 UTC" a partir del ISO del evento — el feed sísmico habla en UTC. */
export function formatUtcClock(horaUtc: string): string {
  const d = new Date(horaUtc);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss} UTC`;
}
