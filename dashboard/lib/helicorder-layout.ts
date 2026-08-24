/**
 * Geometría del helicorder con paridad SWARM (HelicorderRenderer.java, CC0):
 * filas de timeChunk segundos, eje X = wrap modular del tiempo, 4 azules
 * cíclicos por fila y clipping clampado. Lib pura para testear sin canvas.
 */

export const HELICORDER_BLUES = [
  'rgb(0,0,255)',
  'rgb(0,0,205)',
  'rgb(0,0,155)',
  'rgb(0,0,105)',
] as const;

/** Rojo de clipping de SWARM: la muestra que se pasa del clip se pinta así. */
export const HELICORDER_CLIP_COLOR = 'rgb(255,0,0)';

export function rowCount(totalMinutes: number, timeChunkMinutes: number): number {
  return Math.ceil(totalMinutes / timeChunkMinutes);
}

/**
 * Filas que corresponden a la ventana REALMENTE devuelta, no a las 24 h que se
 * pidieron.
 *
 * FDSN entrega lo que tiene: pedir 24 h de un canal cuyas últimas horas todavía
 * no llegaron devuelve, por ejemplo, 18,75 h. Repartir esos pares sobre 96 filas
 * "porque el día tiene 96 franjas de 15 min" estira la señal y **desplaza el eje
 * de tiempo**: las filas del final quedan rotuladas con horas que no son las de
 * su dato.
 *
 * Es el mismo pecado que ya cometimos con el eje de frecuencia del
 * espectrograma: derivar el eje de una constante en vez del dato. La constante
 * es lo que se PIDE; el rótulo tiene que salir de lo que se RECIBE.
 */
export function rowsForWindow(
  startMs: number,
  endMs: number,
  timeChunkMinutes: number,
): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  if (timeChunkMinutes <= 0) return 0;

  const spanMinutes = (endMs - startMs) / 60_000;
  if (spanMinutes <= 0) return 0;

  // `ceil`: una ventana de 18,75 h en franjas de 15 min da 75 exactas, pero una
  // de 18,80 h necesita 76 filas — la última parcial. Truncar la escondería.
  return Math.ceil(spanMinutes / timeChunkMinutes);
}

export function rowForOffset(offsetSec: number, timeChunkSec: number): number {
  return Math.floor(offsetSec / timeChunkSec);
}

export function xFractionForOffset(offsetSec: number, timeChunkSec: number): number {
  return (offsetSec % timeChunkSec) / timeChunkSec;
}

export function rowColor(rowIndex: number): string {
  return HELICORDER_BLUES[rowIndex % HELICORDER_BLUES.length];
}

/** Heurística de densidad de ticks de SWARM (StandardDecorator). */
export function majorTickMinutes(timeChunkMinutes: number): number {
  if (timeChunkMinutes <= 30) return 1;
  if (timeChunkMinutes < 180) return 5;
  if (timeChunkMinutes < 360) return 10;
  return 20;
}

export function clampToClip(value: number, clipValue: number): { v: number; clipped: boolean } {
  if (value > clipValue) return { v: clipValue, clipped: true };
  if (value < -clipValue) return { v: -clipValue, clipped: true };
  return { v: value, clipped: false };
}

/**
 * Alto de la marca roja de saturación, como fracción del clip. Suficiente para
 * verse, chico para no volver a tapar el cuerpo de la onda.
 */
const CLIP_MARK_FRACTION = 0.08;

export interface TraceSegment {
  lo: number;
  hi: number;
  clipped: boolean;
}

/**
 * Parte el trazo vertical de una columna en tramos por dentro y por fuera del
 * clip.
 *
 * Antes se pintaba la columna ENTERA de rojo si cualquiera de los dos extremos
 * tocaba el clip. En la parte fuerte de un sismo eso se repite columna tras
 * columna y el resultado es un bloque rojo sólido que tapa la forma de onda —
 * justo lo que uno abre el helicorder para mirar.
 *
 * SWARM pinta de rojo sólo el pedazo que se desborda del alto de la fila; el
 * cuerpo de la onda queda azul y sigue siendo legible. El rojo pasa de "hubo
 * saturación en esta columna" a "hasta acá llegaba", que es la información
 * útil.
 */
export function splitClippedSegment(lo: number, hi: number, clipValue: number): TraceSegment[] {
  const dentroLo = Math.max(lo, -clipValue);
  const dentroHi = Math.min(hi, clipValue);
  const segmentos: TraceSegment[] = [];

  // El cuerpo va primero para que las puntas rojas se dibujen encima y no
  // queden tapadas por el azul.
  if (dentroHi >= dentroLo) {
    segmentos.push({ lo: dentroLo, hi: dentroHi, clipped: false });
  }
  // Las puntas se dibujan con un grosor mínimo: un segmento de altura 0 sería
  // invisible en el canvas y la saturación dejaría de señalizarse.
  const marca = clipValue * CLIP_MARK_FRACTION;
  if (lo < -clipValue) {
    segmentos.push({ lo: -clipValue, hi: -clipValue + marca, clipped: true });
  }
  if (hi > clipValue) {
    segmentos.push({ lo: clipValue - marca, hi: clipValue, clipped: true });
  }
  return segmentos;
}

/**
 * Clip automático: percentil alto de |amplitud| del día.
 *
 * Un máximo absoluto no sirve como escala — un solo transitorio grande
 * aplasta el resto del día contra la línea de base y el helicorder queda
 * plano. El percentil deja que ese transitorio sature (que es justamente lo
 * que el rojo de clipping comunica) y conserva la escala del ruido de fondo.
 */
export function autoClipValue(
  mins: readonly number[],
  maxs: readonly number[],
  percentile = 0.995,
): number {
  const amplitudes: number[] = [];
  for (let i = 0; i < mins.length; i++) {
    amplitudes.push(Math.max(Math.abs(mins[i]), Math.abs(maxs[i])));
  }
  if (amplitudes.length === 0) return 1;

  amplitudes.sort((a, b) => a - b);
  const idx = Math.min(amplitudes.length - 1, Math.floor(amplitudes.length * percentile));
  // Una señal constante daría clip 0 y una división por cero al escalar.
  return amplitudes[idx] || 1;
}

/**
 * Bias (línea de base) de una fila: SWARM lo recalcula POR FILA y no una vez
 * para todo el día. Una deriva lenta del instrumento haría que las filas de la
 * tarde se dibujen despegadas de su eje si el bias fuera global.
 */
export function rowBias(
  mins: readonly number[],
  maxs: readonly number[],
  from: number,
  to: number,
): number {
  let suma = 0;
  let n = 0;
  for (let i = from; i < to && i < mins.length; i++) {
    suma += (mins[i] + maxs[i]) / 2;
    n++;
  }
  return n === 0 ? 0 : suma / n;
}
