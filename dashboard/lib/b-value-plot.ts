/**
 * Forma del panel de b-value (analytics-professional-panels, 4.2).
 *
 * Lógica PURA: filas para la distribución frecuencia-magnitud (FMD), la recta
 * de ajuste `log10 N = a − b·M` y el formateo del número. El componente
 * Recharts solo mapea; acá está lo verificable (design Decision 8: ningún
 * test del repo asserta SVG de Recharts).
 *
 * Lo que NO hace, a propósito: calcular `b`, `Mc` ni la guarda de N. Eso vive
 * en `src/services/gutenberg_richter.py` y llega en el body con `status`. El
 * cliente no re-estima nada (Decision 1: "el frontend no calcula nada de esto").
 */

import type { BValueResponse, MagnitudeBin } from './analytics';
import constants from '@/lib/seismic-constants.json';

/** Ancho de barra del histograma: el MISMO bin que usa el ajuste en Python. */
export const MAGNITUDE_BIN_WIDTH: number = constants.magnitudeBinWidth;

export interface FmdRow {
  m: number;
  count: number;
  cumulative: number;
  /** `log10(cumulative)`; `null` para `cumulative === 0` — un eje Y logarítmico
   * con `-Infinity` deja el gráfico en blanco sin lanzar nada. */
  log10Cumulative: number | null;
}

export function toFmdRows(bins: MagnitudeBin[]): FmdRow[] {
  return bins.map((bin) => ({
    m: bin.m,
    count: bin.count,
    cumulative: bin.cumulative,
    log10Cumulative: bin.cumulative > 0 ? Math.log10(bin.cumulative) : null,
  }));
}

export interface FittedLinePoint {
  m: number;
  log10N: number;
}

/**
 * Los dos extremos de la recta `log10 N = a − b·M`, de `mc` a `maxM`.
 *
 * El primer punto es EXACTAMENTE `(mc, a − b·mc)`: la recta arranca donde
 * arranca el ajuste (sobre Mc), no en el piso del catálogo. Si `maxM <= mc`
 * (un catálogo con un solo bin sobre Mc) el segundo punto se corre un bin a
 * la derecha para que la recta tenga longitud. Un parámetro no finito ⇒ `[]`:
 * nada que dibujar, y ningún NaN llega a Recharts.
 */
export function fittedLinePoints(a: number, b: number, mc: number, maxM: number): FittedLinePoint[] {
  if (![a, b, mc, maxM].every(Number.isFinite)) return [];
  const right = maxM > mc ? maxM : mc + MAGNITUDE_BIN_WIDTH;
  return [
    { m: mc, log10N: a - b * mc },
    { m: right, log10N: a - b * right },
  ];
}

/** `m` del último bin (vienen ordenados por magnitud); `null` sin bins. */
export function maxBinMagnitude(bins: MagnitudeBin[]): number | null {
  return bins.length > 0 ? bins[bins.length - 1].m : null;
}

export interface NotEstimableMessageArgs {
  kind: 'insufficient' | 'degenerate';
  /** `n_above_mc` */
  n: number;
  /** `min_events` (del JSON, vía backend — la UI no lo hardcodea) */
  min: number;
}

/** Args de la tarjeta "no estimable"; `null` con `status === "ok"`. El
 * `kind` elige el texto i18n: `degenerate` NO es "insuficiente" (R9). */
export function notEstimableMessageArgs(result: BValueResponse): NotEstimableMessageArgs | null {
  if (result.status === 'ok') return null;
  return { kind: result.status, n: result.n_above_mc, min: result.min_events };
}

/** `b ± σ` con dos decimales (spec dashboard-ui, Decisión 8: `0.9963 ⇒ "1.00"`).
 * `null` si algo no es finito: nunca un "NaN" en pantalla. */
export function formatB(b: number, sigma: number): { b: string; sigma: string } | null {
  if (!Number.isFinite(b) || !Number.isFinite(sigma)) return null;
  return { b: b.toFixed(2), sigma: sigma.toFixed(2) };
}
