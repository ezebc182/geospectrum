/**
 * Viewport del espectrograma grande: QUÉ porción del dato se está mirando.
 *
 * Es un concepto distinto del EJE. El eje (`frequencyAxis`, `timeAxis`) es el
 * dominio de lo que hay en memoria; el viewport es el dominio de lo que se ve.
 * Antes del zoom coincidían siempre, y por eso vivían fusionados en un solo
 * objeto. Con zoom hay que separarlos: el dato sigue llegando por WS y el eje
 * crece, pero la vista TIENE que quedarse donde el usuario la dejó.
 *
 * Todo acá es función pura sobre números. Los bugs de zoom son casi siempre de
 * clamp (acercarse infinito, salirse del dominio, perder el punto bajo el
 * cursor) y aislados se testean sin montar un canvas.
 */

import type { FrequencyAxis } from './spectrogram-frequency-axis';
import type { TimeAxis } from './spectrogram-time-axis';

export interface Viewport {
  fMin: number;
  fMax: number;
  startMs: number;
  endMs: number;
}

/** Span temporal mínimo: por debajo de un segundo no hay más resolución que ver. */
const MIN_TIME_SPAN_MS = 1000;

/** Span de frecuencia mínimo, en Hz. */
const MIN_FREQ_SPAN_HZ = 0.5;

export function fullViewport(f: FrequencyAxis, t: TimeAxis): Viewport {
  return { fMin: f.fMin, fMax: f.fMax, startMs: t.startMs, endMs: t.endMs };
}

/**
 * Zoom sobre un rango 1D manteniendo fijo el punto que está bajo el cursor.
 *
 * `anchorFraction` es dónde cae el cursor dentro del rango visible (0 = borde
 * inicial, 1 = borde final). Sin ancla, todo zoom se haría desde el centro y
 * apuntar a un evento sería imposible: se escaparía de la pantalla al acercar.
 */
function zoomRange(
  min: number,
  max: number,
  factor: number,
  anchorFraction: number,
  limitMin: number,
  limitMax: number,
  minSpan: number,
): [number, number] {
  const span = max - min;
  if (!(span > 0)) return [limitMin, limitMax];

  const anchor = min + span * Math.min(1, Math.max(0, anchorFraction));
  const limitSpan = limitMax - limitMin;

  // El span nunca baja del piso ni sube del dominio completo: sin los dos topes
  // la rueda del mouse lleva a NaN o a un rango invertido.
  const nextSpan = Math.min(limitSpan, Math.max(minSpan, span * factor));

  let nextMin = anchor - (anchor - min) * (nextSpan / span);
  let nextMax = nextMin + nextSpan;

  // Corrimiento (no recorte) al chocar un borde: recortar cambiaría el span y
  // el zoom se sentiría trabado contra los extremos.
  if (nextMin < limitMin) {
    nextMin = limitMin;
    nextMax = limitMin + nextSpan;
  }
  if (nextMax > limitMax) {
    nextMax = limitMax;
    nextMin = limitMax - nextSpan;
  }
  return [nextMin, nextMax];
}

export function zoomTime(
  v: Viewport,
  factor: number,
  anchorFraction: number,
  limits: Viewport,
): Viewport {
  const [startMs, endMs] = zoomRange(
    v.startMs, v.endMs, factor, anchorFraction,
    limits.startMs, limits.endMs, MIN_TIME_SPAN_MS,
  );
  return { ...v, startMs, endMs };
}

export function zoomFreq(
  v: Viewport,
  factor: number,
  anchorFraction: number,
  limits: Viewport,
): Viewport {
  // El eje de frecuencia se dibuja con el máximo ARRIBA, así que una fracción
  // de 0 en pantalla es el tope del rango. Se invierte acá y no en el llamador
  // para que quien maneje el mouse no tenga que saberlo.
  const [fMin, fMax] = zoomRange(
    v.fMin, v.fMax, factor, 1 - anchorFraction,
    limits.fMin, limits.fMax, MIN_FREQ_SPAN_HZ,
  );
  return { ...v, fMin, fMax };
}

/**
 * Corre la ventana. Las fracciones son del span VISIBLE, no del total: así un
 * arrastre de N píxeles mueve siempre los mismos N píxeles de contenido, con
 * zoom o sin él.
 */
export function panViewport(
  v: Viewport,
  dxFraction: number,
  dyFraction: number,
  limits: Viewport,
): Viewport {
  const timeSpan = v.endMs - v.startMs;
  const freqSpan = v.fMax - v.fMin;

  const dt = timeSpan * dxFraction;
  const df = freqSpan * dyFraction;

  const [startMs, endMs] = shiftRange(
    v.startMs + dt, v.endMs + dt, limits.startMs, limits.endMs,
  );
  const [fMin, fMax] = shiftRange(
    v.fMin + df, v.fMax + df, limits.fMin, limits.fMax,
  );
  return { fMin, fMax, startMs, endMs };
}

/** Empuja un rango dentro de los límites preservando su ancho. */
function shiftRange(
  min: number, max: number, limitMin: number, limitMax: number,
): [number, number] {
  const span = max - min;
  if (span >= limitMax - limitMin) return [limitMin, limitMax];
  if (min < limitMin) return [limitMin, limitMin + span];
  if (max > limitMax) return [limitMax - span, limitMax];
  return [min, max];
}

/**
 * ¿Está mostrando todo? Con tolerancia relativa: acercar y alejar deja residuo
 * de coma flotante, y comparar por igualdad exacta dejaría el botón "reset"
 * encendido para siempre después del primer zoom.
 */
export function isFullView(v: Viewport, limits: Viewport): boolean {
  const timeSpan = limits.endMs - limits.startMs;
  const freqSpan = limits.fMax - limits.fMin;
  const cerca = (a: number, b: number, escala: number) =>
    Math.abs(a - b) <= Math.max(1e-5, escala * 1e-5);

  return (
    cerca(v.startMs, limits.startMs, timeSpan) &&
    cerca(v.endMs, limits.endMs, timeSpan) &&
    cerca(v.fMin, limits.fMin, freqSpan) &&
    cerca(v.fMax, limits.fMax, freqSpan)
  );
}

/**
 * Rango `[lo, hi)` de columnas que tocan la ventana visible.
 *
 * Búsqueda binaria porque el ingestor las inserta en orden y `/history` las
 * devuelve ordenadas por `endtime`. Con zoom el bucle de dibujo corre en cada
 * tick de la rueda; recorrer 4000 columnas para pintar 40 colgaría la pantalla.
 *
 * Se agrega una columna de margen a cada lado: la del borde se dibuja con
 * ancho hacia adentro, y sin el margen quedaría una franja sin pintar contra
 * el filo del recuadro.
 */
export function visibleColumnRange<T extends { endtime: string }>(
  cols: readonly T[],
  v: Viewport,
): [number, number] {
  if (cols.length === 0) return [0, 0];

  const lo = lowerBound(cols, v.startMs);
  const hi = lowerBound(cols, v.endMs);

  return [Math.max(0, lo - 1), Math.min(cols.length, hi + 2)];
}

/** Primer índice cuyo `endtime` es >= `ms`. */
function lowerBound<T extends { endtime: string }>(cols: readonly T[], ms: number): number {
  let lo = 0;
  let hi = cols.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const t = Date.parse(cols[mid].endtime);
    // Un timestamp roto no debe abortar la búsqueda: se lo trata como pasado
    // remoto, que es lo que hace el resto del pipeline con las columnas malas.
    if (!Number.isFinite(t) || t < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
