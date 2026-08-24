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
