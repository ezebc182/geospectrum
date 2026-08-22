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
