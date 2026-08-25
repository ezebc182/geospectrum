/**
 * Geometría temporal de la vista de onda: instante ↔ píxel, zoom y arrastre.
 *
 * Lógica pura a propósito. El canvas sólo dibuja y el hook sólo pide datos;
 * toda la aritmética de la ventana vive acá, testeable con valores calculados
 * a mano y sin montar un DOM.
 *
 * Este módulo es el DUEÑO de `TimeWindow`: `helicorder-hit.ts` lo re-exporta
 * para no partir el concepto en dos definiciones que se irían separando con el
 * tiempo.
 */

/** Ventana temporal absoluta. Los dos extremos en ms epoch UTC. */
export interface TimeWindow {
  startMs: number;
  endMs: number;
}

/**
 * Ventana mínima. NO es un número de gusto: `timeToX` divide por
 * (endMs - startMs). Con 0 el resultado es Infinity/NaN y el canvas no dibuja
 * NADA sin lanzar ninguna excepción — el mismo modo de falla silenciosa que
 * `effectiveClip` evita en helicorder-settings.ts.
 */
export const MIN_WINDOW_MS = 1_000;

/** Techo del backend (24 h). Pedir más da 422; clampear acá evita el viaje. */
export const MAX_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * Arrastre por debajo de este ancho se considera un clic, no una selección.
 * Sin el umbral, un clic con un temblor de un píxel dispararía un fetch de una
 * ventana ridículamente angosta.
 */
export const MIN_DRAG_PX = 4;

/** Instante → píxel. Inversa exacta de `xToTime`. */
export function timeToX(tMs: number, w: TimeWindow, plotWidth: number): number {
  const duration = w.endMs - w.startMs;
  if (duration <= 0 || plotWidth <= 0) return 0;
  return ((tMs - w.startMs) / duration) * plotWidth;
}

/** Píxel → instante. `timeToX(xToTime(x)) === x` salvo redondeo de float. */
export function xToTime(x: number, w: TimeWindow, plotWidth: number): number {
  const duration = w.endMs - w.startMs;
  if (duration <= 0 || plotWidth <= 0) return w.startMs;
  return w.startMs + (x / plotWidth) * duration;
}

/**
 * Ventana válida: extremos ordenados, duración en [MIN, MAX].
 *
 * Al corregir la duración expande o recorta SIMÉTRICO alrededor del centro.
 * Mover sólo un extremo desplazaría lo que el usuario quiso mirar: si hizo
 * clic sobre un evento y la ventana resultante era degenerada, crecer sólo
 * hacia la derecha dejaría el evento pegado al borde izquierdo.
 */
export function clampWindow(w: TimeWindow): TimeWindow {
  // Extremos invertidos son un gesto legítimo del usuario (arrastrar hacia
  // atrás), no un error: se ordenan en vez de rechazarlos.
  const lo = Math.min(w.startMs, w.endMs);
  const hi = Math.max(w.startMs, w.endMs);

  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { startMs: 0, endMs: MIN_WINDOW_MS };
  }

  const duration = hi - lo;
  const target = Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, duration));
  if (target === duration) return { startMs: lo, endMs: hi };

  const center = (lo + hi) / 2;
  const half = target / 2;
  return { startMs: center - half, endMs: center + half };
}

/**
 * Zoom anclado al cursor: el instante bajo el cursor queda en el MISMO píxel
 * después del zoom. Sin el anclaje, hacer zoom sobre un evento lo saca de
 * pantalla y el usuario tiene que buscarlo de nuevo.
 *
 * `factor` < 1 acerca, > 1 aleja. Devuelve una ventana YA clampeada.
 */
export function zoomWindow(
  w: TimeWindow,
  anchorX: number,
  plotWidth: number,
  factor: number,
): TimeWindow {
  const duration = w.endMs - w.startMs;
  if (duration <= 0 || plotWidth <= 0 || !Number.isFinite(factor) || factor <= 0) {
    return clampWindow(w);
  }

  // Fracción del ancho donde está el cursor, y el instante que hay ahí ahora.
  const fraction = anchorX / plotWidth;
  const anchorMs = w.startMs + fraction * duration;

  // La ventana nueva se construye para que ESE instante caiga en ESA misma
  // fracción: por eso `fraction` multiplica la duración nueva, no la vieja.
  const newDuration = duration * factor;
  return clampWindow({
    startMs: anchorMs - fraction * newDuration,
    endMs: anchorMs + (1 - fraction) * newDuration,
  });
}

/**
 * Arrastre → ventana. Normaliza: arrastrar de derecha a izquierda es un gesto
 * legítimo y debe dar la misma ventana que el inverso.
 *
 * Devuelve `null` si el arrastre fue en realidad un clic (|x2-x1| por debajo
 * de `MIN_DRAG_PX`): un clic accidental no debe disparar un fetch.
 */
export function dragSelection(
  x1: number,
  x2: number,
  plotWidth: number,
  w: TimeWindow,
): TimeWindow | null {
  if (plotWidth <= 0) return null;
  if (!Number.isFinite(x1) || !Number.isFinite(x2)) return null;
  if (Math.abs(x2 - x1) < MIN_DRAG_PX) return null;

  const lo = Math.min(x1, x2);
  const hi = Math.max(x1, x2);

  return clampWindow({
    startMs: xToTime(lo, w, plotWidth),
    endMs: xToTime(hi, w, plotWidth),
  });
}

/** Duración de la ventana en ms. Azúcar para no repetir la resta. */
export function windowDurationMs(w: TimeWindow): number {
  return w.endMs - w.startMs;
}

/**
 * Ventana → parámetros del endpoint. El backend espera ISO-8601 en `start`/`end`
 * (`src/main.py:2597-2598`), y armarlo en un solo lugar evita que cada llamador
 * invente su propio formato.
 */
export function windowToQuery(w: TimeWindow): { start: string; end: string } {
  return {
    start: new Date(w.startMs).toISOString(),
    end: new Date(w.endMs).toISOString(),
  };
}
