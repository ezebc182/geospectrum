/**
 * Share de un rango de señal: "imagen si se puede, link SIEMPRE"
 * (decisión del 2026-08-26). No existe en SWARM — es ventaja propia.
 *
 * Igual que share-event: lógica pura, sin next-intl (los textos llegan por
 * parámetro) y sin DOM. La mecánica de navigator.share/portapapeles se REUSA
 * de share-event (shareTextContent), no se reinventa.
 */

import type { TimeWindow } from './waveform-scale';

/** Techo del endpoint /waveform: una ventana no puede superar 24 h. */
const MAX_WINDOW_MS = 24 * 3_600_000;

/** Textos ya resueltos en el idioma activo. */
export interface RangeShareMessages {
  /** Título del share sheet nativo. */
  title: string;
  headline: (channel: string) => string;
}

/**
 * La ventana del deep link de entrada (?start=...&end=...), o null.
 *
 * null y no "lo que se pueda": una ventana inválida en la URL no debe abrir
 * el wave view con cualquier cosa — se ignora y la página queda como siempre.
 * Mismos límites que el endpoint (end > start, ≤ 24 h) para que un link
 * compartido jamás produzca un 422 al abrirse.
 */
export function parseWindowParams(
  start: string | null,
  end: string | null,
): TimeWindow | null {
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs <= startMs) return null;
  if (endMs - startMs > MAX_WINDOW_MS) return null;
  return { startMs, endMs };
}

/** Deep link de salida: la URL actual con la ventana en ISO UTC. */
export function rangeUrl(window: TimeWindow, base = globalThis.location?.href ?? ''): string {
  const url = new URL(base);
  url.searchParams.set('start', new Date(window.startMs).toISOString());
  url.searchParams.set('end', new Date(window.endMs).toISOString());
  return url.toString();
}

/**
 * Texto del mensaje: canal, rango UTC y duración. Resumido a propósito —
 * esto termina en un chat, no en un informe; el detalle está en el link.
 */
export function buildRangeShareText(
  channel: string,
  window: TimeWindow,
  messages: RangeShareMessages,
): string {
  const start = new Date(window.startMs).toISOString();
  const end = new Date(window.endMs).toISOString();
  const fecha = start.slice(0, 10);
  const desde = start.slice(11, 19);
  const hasta = end.slice(11, 19);
  const durationS = Math.round((window.endMs - window.startMs) / 1000);
  return [
    messages.headline(channel),
    `${fecha} ${desde}–${hasta} UTC · ${durationS} s`,
  ].join('\n');
}
