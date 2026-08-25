/**
 * Traducción de un clic sobre el helicorder al instante que representa.
 *
 * El helicorder dibuja 24 h como `rows` franjas apiladas de `timeChunkMinutes`
 * cada una. Un clic tiene dos coordenadas y las dos importan: la fila (`y`) dice
 * qué franja, y la posición horizontal (`x`) dice el offset dentro de la franja.
 *
 * Lógica pura a propósito: el canvas sólo dibuja. Así el mapeo se puede testear
 * con valores calculados a mano, sin montar un canvas ni un DOM.
 */

// `TimeWindow` vive en `waveform-scale.ts`, que es la lib de geometría
// temporal. Se re-exporta desde acá porque este módulo ya era el punto de
// import de quienes lo usan (`HelicorderCanvas.tsx`), pero la definición es
// UNA SOLA: dos declaraciones del mismo concepto se separan con el tiempo.
export type { TimeWindow } from './waveform-scale';
import type { TimeWindow } from './waveform-scale';

export interface HelicorderHit {
  /** Coordenada del clic relativa al canvas, en píxeles CSS. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Márgenes donde van las etiquetas de hora: ahí no hay señal dibujada. */
  marginLeft: number;
  marginRight: number;
  /** Cantidad de franjas apiladas. */
  rows: number;
  /** Minutos que abarca cada franja. */
  timeChunkMinutes: number;
  /** Instante del extremo izquierdo de la primera franja. */
  startMs: number;
  /** Ancho de la ventana a abrir, centrada en el instante clickeado. */
  windowSeconds?: number;
}

/** Ancho por defecto de la ventana que abre un clic. */
export const DEFAULT_WINDOW_SECONDS = 120;

/**
 * Devuelve la ventana centrada en el instante clickeado, o `null` si el clic no
 * cae sobre señal dibujada.
 *
 * Devuelve `null` en los márgenes en vez del borde más cercano: ahí no hay
 * instante, y abrir la ventana del borde sería mostrarle al usuario algo que no
 * señaló.
 */
export function helicorderHitToWindow(hit: HelicorderHit): TimeWindow | null {
  const {
    x,
    y,
    width,
    height,
    marginLeft,
    marginRight,
    rows,
    timeChunkMinutes,
    startMs,
    windowSeconds = DEFAULT_WINDOW_SECONDS,
  } = hit;

  if (rows <= 0 || timeChunkMinutes <= 0 || windowSeconds <= 0) return null;

  const plotWidth = width - marginLeft - marginRight;
  if (plotWidth <= 0 || height <= 0) return null;

  // Márgenes y fuera del canvas: no hay instante que devolver.
  if (x < marginLeft || x > width - marginRight) return null;
  if (y < 0 || y > height) return null;

  const rowHeight = height / rows;
  // `Math.min` cubre el clic exactamente en el borde inferior (y === height),
  // que si no daría `rows` y se saldría del rango de franjas.
  const row = Math.min(rows - 1, Math.floor(y / rowHeight));

  const offsetInRow = (x - marginLeft) / plotWidth; // 0..1
  const chunkMs = timeChunkMinutes * 60_000;
  const clickedMs = startMs + row * chunkMs + offsetInRow * chunkMs;

  const halfWindowMs = (windowSeconds * 1000) / 2;
  const totalMs = rows * chunkMs;
  const rangeStart = startMs;
  const rangeEnd = startMs + totalMs;

  // Recorte al rango del helicorder: cerca de los extremos la ventana deja de
  // estar centrada, pero nunca pide datos que el helicorder no cubre.
  const windowStart = Math.max(rangeStart, clickedMs - halfWindowMs);
  const windowEnd = Math.min(rangeEnd, clickedMs + halfWindowMs);

  if (windowEnd <= windowStart) return null;

  return { startMs: windowStart, endMs: windowEnd };
}
