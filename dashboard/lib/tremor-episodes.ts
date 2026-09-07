/**
 * Forma del panel de tremor (analytics-professional-panels, 4.4).
 *
 * Lógica PURA sobre `TremorResponse`: sombreados por episodio, línea de
 * umbral, filas del gráfico RSAM y claves i18n de banda / signo de FI.
 *
 * Dos reglas de la spec dashboard-ui que este módulo hace cumplir:
 *
 * 1. Los intervalos sombreados son EXACTAMENTE `episodes[i].start/end` de la
 *    respuesta (`episodesToReferenceAreas`).
 * 2. La línea de umbral se dibuja en `threshold_rsam` de la respuesta, NUNCA
 *    en un `baseline × factor` recalculado acá. `TREMOR_BASELINE_FACTOR` se
 *    exporta para la LEYENDA ("umbral = 2× la mediana"), no para calcular.
 *
 * Tiempos: los `t` de `samples` vienen con 6 decimales (`str(UTCDateTime)`,
 * igual que `/rsam`) y los `start/end` de los episodios son ISO de Pydantic;
 * ambos van a ms epoch con `Date.parse` para que compartan el eje X numérico.
 */

import type { TremorBand, TremorEpisode, TremorFiSign, TremorResponse, TremorSample } from './analytics';
import constants from '@/lib/seismic-constants.json';

/** Solo para la leyenda: el umbral aplicado viene calculado en `threshold_rsam`. */
export const TREMOR_BASELINE_FACTOR: number = constants.tremorBaselineFactor;

export interface ReferenceAreaBounds {
  x1: number;
  x2: number;
}

/** Un `{x1, x2}` (ms epoch) por episodio; un borde imparseable descarta el
 * episodio en vez de mandar un NaN a `ReferenceArea`. */
export function episodesToReferenceAreas(episodes: TremorEpisode[]): ReferenceAreaBounds[] {
  return episodes
    .map((ep) => ({ x1: Date.parse(ep.start), x2: Date.parse(ep.end) }))
    .filter((area) => Number.isFinite(area.x1) && Number.isFinite(area.x2));
}

/** Clave i18n relativa al namespace `analytics` (`t('tremor.band.low')`). */
export function bandLabelKey(band: TremorBand): string {
  return `tremor.band.${band}`;
}

export function fiSignLabelKey(fiSign: TremorFiSign): string {
  return `tremor.fiSign.${fiSign}`;
}

/** `threshold_rsam` TAL CUAL (`null` sin datos). No se recalcula. */
export function thresholdLine(response: TremorResponse): number | null {
  return response.threshold_rsam;
}

export interface TremorRow {
  /** Centro de la ventana en ms epoch. */
  t: number;
  rsam: number;
  dominantHz: number | null;
  fi: number | null;
}

export function samplesToRows(samples: TremorSample[]): TremorRow[] {
  return samples
    .map((sample) => ({
      t: Date.parse(sample.t),
      rsam: sample.rsam,
      dominantHz: sample.dominant_hz,
      fi: sample.fi,
    }))
    .filter((row) => Number.isFinite(row.t));
}
