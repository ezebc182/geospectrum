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

/**
 * Dominio canónico del share: el link que viaja por WhatsApp es la cara
 * pública del producto y lleva la marca — nunca el host interno de Vercel
 * ni localhost (geospectrum.org sirve la misma app, verificado en el deploy).
 */
export const SHARE_CANONICAL_ORIGIN = 'https://geospectrum.org';

/** Deep link de salida: ruta actual + ventana en ISO UTC, dominio canónico. */
export function rangeUrl(window: TimeWindow, base = globalThis.location?.href ?? ''): string {
  const current = new URL(base);
  const url = new URL(current.pathname + current.search, SHARE_CANONICAL_ORIGIN);
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

/** La nota a compartir: el texto y su instante anclado (o null). */
export interface ShareableNote {
  body: string;
  anchorTimeMs: number | null;
}

/**
 * Texto del share de UN apunte: la nota entre comillas, su instante anclado
 * si lo tiene, y el rango de la ventana. La referencia viaja EN el texto —
 * quien lo recibe sabe qué mirar antes de abrir el link.
 */
export function buildNoteShareText(
  channel: string,
  window: TimeWindow,
  note: ShareableNote,
  messages: RangeShareMessages,
): string {
  const lines = [messages.headline(channel), `«${note.body}»`];
  if (note.anchorTimeMs !== null) {
    lines.push(`⚓ ${new Date(note.anchorTimeMs).toISOString().slice(11, 19)}Z`);
  }
  const start = new Date(window.startMs).toISOString();
  const end = new Date(window.endMs).toISOString();
  lines.push(`${start.slice(0, 10)} ${start.slice(11, 19)}–${end.slice(11, 19)} UTC`);
  return lines.join('\n');
}
