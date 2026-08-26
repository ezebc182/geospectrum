/**
 * Fórmulas sismológicas de picking: S-P → distancia y coda → magnitud.
 *
 * Copia DELIBERADA de `src/services/signal_picks.py`, con la misma fuente
 * única de constantes (`seismic-constants.json`). El cliente calcula para el
 * FEEDBACK INMEDIATO (mostrar "82 km" mientras se marca); el backend calcula
 * para el ARTEFACTO (el CSV). Este módulo NO declara ninguno de los cuatro
 * valores: si la fórmula o el JSON cambian de un solo lado, los tests
 * espejados de ambos lados no pueden quedar verdes a la vez.
 */

import constants from '@/lib/seismic-constants.json';

/** Fases marcables sobre la señal. Espejo del CHECK de la tabla signal_picks. */
export type PickPhase = 'P' | 'S' | 'coda';

/** Un pick tal como lo devuelve el backend. */
export interface SignalPick {
  id: string;
  channel: string;
  phase: PickPhase;
  /** Instante absoluto UTC (ISO-8601). Nunca un x de píxel ni un offset. */
  pickTime: string;
  note: string | null;
}

export const P_VELOCITY_KM_S: number = constants.pVelocityKmS;
export const VP_VS_RATIO: number = constants.vpVsRatio;
export const CODA_A: number = constants.codaA;
export const CODA_B: number = constants.codaB;

// Derivada, no declarada: una quinta constante suelta podría divergir del JSON.
export const S_VELOCITY_KM_S: number = P_VELOCITY_KM_S / VP_VS_RATIO;

/**
 * Distancia epicentral estimada a partir del intervalo S-P.
 *
 * d = (tS - tP) · (vp·vs)/(vp - vs). Una sola estación da DISTANCIA, no
 * ubicación: el epicentro está en algún punto del círculo de radio d.
 *
 * Devuelve null para S-P no positivo o no finito — nunca 0, NaN ni Infinity
 * silenciosos, y nunca una distancia negativa.
 */
export function spDistanceKm(spSeconds: number): number | null {
  if (!Number.isFinite(spSeconds) || spSeconds <= 0) return null;

  const factor =
    (P_VELOCITY_KM_S * S_VELOCITY_KM_S) / (P_VELOCITY_KM_S - S_VELOCITY_KM_S);
  return spSeconds * factor;
}

/**
 * Magnitud de coda: Mc = CODA_A · log10(t) + CODA_B (valores del JSON compartido).
 *
 * Devuelve null para duración no positiva o no finita: sin la guarda, t=0
 * propaga -Infinity y t<0 propaga NaN hasta la UI.
 *
 * No se recorta a cero: Mc(1 s) = CODA_B es negativo y es correcto.
 */
export function codaMagnitude(codaSeconds: number): number | null {
  if (!Number.isFinite(codaSeconds) || codaSeconds <= 0) return null;

  return CODA_A * Math.log10(codaSeconds) + CODA_B;
}

/** Derivadas de los picks visibles. Espejo de compute_measurements de Python. */
export interface PickMeasurements {
  /** tS - tP. Puede ser <= 0: así la UI distingue "falta una fase" (null) de
   * "S marcada antes que P" y puede indicar orden inválido sin mostrar NaN. */
  spSeconds: number | null;
  distanceKm: number | null;
  codaSeconds: number | null;
  codaMagnitude: number | null;
}

/**
 * Mediciones derivadas para el FEEDBACK INMEDIATO en pantalla.
 *
 * La referencia es la PRIMERA fase de cada tipo en orden temporal, igual que
 * el backend. La distancia y la magnitud pasan por las guardas de las
 * fórmulas: un S-P no positivo produce null, nunca un número negativo.
 */
export function computeMeasurements(picks: SignalPick[]): PickMeasurements {
  // Orden por epoch y no por string: el formato ISO del backend puede variar
  // (sufijo Z u offset +00:00) y el orden lexicográfico mentiría.
  const byTime = picks
    .map((pick) => ({ phase: pick.phase, ms: new Date(pick.pickTime).getTime() }))
    .filter((entry) => Number.isFinite(entry.ms))
    .sort((a, b) => a.ms - b.ms);

  const first: Partial<Record<PickPhase, number>> = {};
  for (const entry of byTime) {
    first[entry.phase] ??= entry.ms;
  }

  const p = first.P;
  const s = first.S;
  const coda = first.coda;

  const spSeconds = p !== undefined && s !== undefined ? (s - p) / 1000 : null;
  const codaSeconds = p !== undefined && coda !== undefined ? (coda - p) / 1000 : null;

  return {
    spSeconds,
    distanceKm: spSeconds === null ? null : spDistanceKm(spSeconds),
    codaSeconds,
    codaMagnitude: codaSeconds === null ? null : codaMagnitude(codaSeconds),
  };
}
