/**
 * Eje de tiempo y colorbar del espectrograma grande.
 *
 * Las columnas del backend traen `endtime` ISO y pueden venir con huecos (el
 * ingestor se cae, la estación deja de mandar). Posicionarlas por índice —como
 * hace la tira en vivo, donde alcanza— comprimiría los huecos y el eje mentiría
 * sobre CUÁNDO pasó cada cosa. Acá el eje se arma sobre el tiempo real.
 */

import { SWARM_MAX_POWER_DB, SWARM_MIN_POWER_DB, powerDbToT } from './spectrogram-scale';
import { jet2 } from './jet2-palette';

export interface TimeAxis {
  startMs: number;
  endMs: number;
}

/** Ancho mínimo del eje: evita dividir por cero al mapear a píxeles. */
const MIN_SPAN_MS = 60_000;

export function timeAxis(endtimes: readonly string[]): TimeAxis {
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;

  for (const iso of endtimes) {
    const ms = Date.parse(iso);
    // Una columna con timestamp roto no debe arrastrar el eje entero a NaN.
    if (!Number.isFinite(ms)) continue;
    if (ms < startMs) startMs = ms;
    if (ms > endMs) endMs = ms;
  }

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    const ahora = 0;
    return { startMs: ahora, endMs: ahora + MIN_SPAN_MS };
  }
  return {
    startMs,
    endMs: endMs - startMs < MIN_SPAN_MS ? startMs + MIN_SPAN_MS : endMs,
  };
}

export function timeToFraction(ms: number, axis: TimeAxis): number {
  const span = axis.endMs - axis.startMs;
  if (!(span > 0)) return 0;
  return Math.min(1, Math.max(0, (ms - axis.startMs) / span));
}

/**
 * Pasos de tiempo "redondos" en minutos. Un eje rotulado cada 7 minutos es
 * técnicamente correcto e ilegible: el ojo busca los múltiplos de 5, 15, 60.
 */
const TIME_STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440] as const;

export function niceTimeTicks(startMs: number, endMs: number, target = 6): number[] {
  const span = endMs - startMs;
  if (!(span > 0)) return [startMs];

  const crudoMin = span / 60_000 / Math.max(1, target);
  const pasoMin = TIME_STEPS_MIN.find((s) => s >= crudoMin) ?? TIME_STEPS_MIN.at(-1)!;
  const pasoMs = pasoMin * 60_000;

  const ticks: number[] = [];
  // Se alinea a múltiplos absolutos del paso desde la época, no al inicio del
  // eje: así las marcas caen en :00, :15, :30 y no en :07, :22, :37.
  for (let t = Math.ceil(startMs / pasoMs) * pasoMs; t <= endMs; t += pasoMs) {
    ticks.push(t);
  }
  return ticks.length > 0 ? ticks : [startMs, endMs];
}

export interface ColorbarStop {
  db: number;
  color: string;
}

/**
 * Paradas de la colorbar sobre la escala FIJA 20–120 dB de SWARM.
 *
 * La escala es fija a propósito (ver `spectrogram-scale.ts`): con una escala
 * adaptativa el mismo color significaba cosas distintas en cada estación y los
 * espectrogramas dejaban de ser comparables entre sí.
 */
export function colorbarStops(n = 6): ColorbarStop[] {
  const total = Math.max(2, n);
  return Array.from({ length: total }, (_, i) => {
    const db =
      SWARM_MIN_POWER_DB + ((SWARM_MAX_POWER_DB - SWARM_MIN_POWER_DB) * i) / (total - 1);
    return { db, color: jet2(powerDbToT(db)) };
  });
}
