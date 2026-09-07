/**
 * Forma del panel de uptime (analytics-professional-panels, 4.3).
 *
 * Lógica PURA sobre `StationUptimeResponse`. La regla que este módulo
 * PROTEGE es `null ≠ 0` ([R12], Decisión 3 de la spec dashboard-ui):
 *
 * - `ratio: 0`    ⇒ se miró la hora y el canal no mandó nada ("0 %", barra
 *                   de altura cero).
 * - `ratio: null` ⇒ nadie miró esa hora (el pipeline estaba caído): sin
 *                   barra, etiqueta "sin observación".
 *
 * Ninguna función de acá convierte uno en otro. Los tests lo afirman con
 * `toBeNull()`, no con `toBeFalsy()`.
 */

import type { StationUptimeResponse } from './analytics';

export interface RankedStation {
  channel: string;
  /** `overall[channel]` tal cual. */
  ratio: number | null;
  /** `unobserved` ⇒ el componente escribe "sin observaciones", nunca "0 %". */
  kind: 'observed' | 'unobserved';
}

/**
 * Ranking peor primero, ESTABLE, con los `null` al final en su orden de
 * entrada. `{A:0.9, B:0.3, C:null, D:0.6}` ⇒ `B, D, A, C`.
 *
 * `Array.prototype.sort` es estable desde ES2019; el comparador devuelve 0
 * para empates y para dos `null`, así que el orden de `Object.entries` se
 * conserva ahí.
 */
export function rankStations(overall: Record<string, number | null>): RankedStation[] {
  const ranked: RankedStation[] = Object.entries(overall).map(([channel, ratio]) => ({
    channel,
    ratio,
    kind: ratio === null ? 'unobserved' : 'observed',
  }));
  return ranked.sort((a, b) => {
    if (a.ratio === null && b.ratio === null) return 0;
    if (a.ratio === null) return 1;
    if (b.ratio === null) return -1;
    return a.ratio - b.ratio;
  });
}

export interface TimelineRow {
  /** `bucket_start` en ms epoch (eje X numérico de Recharts). */
  t: number;
  ratio: number | null;
  inProgress: boolean;
  observedHours: number;
  expected: number;
  columnsCount: number;
}

/**
 * Filas del timeline de UN canal, ordenadas por `t`. Canal ausente ⇒ `[]`
 * (el componente decide qué mostrar; acá no se inventan buckets). Un
 * `bucket_start` imparseable se descarta: una fila con `t: NaN` rompe el eje
 * entero sin lanzar nada.
 */
export function stationTimeline(response: StationUptimeResponse, channel: string): TimelineRow[] {
  const buckets = response.stations[channel];
  if (!buckets) return [];
  return buckets
    .map((bucket) => ({
      t: Date.parse(bucket.bucket_start),
      ratio: bucket.ratio,
      inProgress: bucket.in_progress,
      observedHours: bucket.observed_hours,
      expected: bucket.expected,
      columnsCount: bucket.columns_count,
    }))
    .filter((row) => Number.isFinite(row.t))
    .sort((a, b) => a.t - b.t);
}

/** `"0 %"` para `0`, `"100 %"` para `1`; `null` para `null` o no finito (el
 * componente elige la etiqueta i18n "sin observación" — nunca "NaN %"). */
export function percentLabel(ratio: number | null): string | null {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  return `${Math.round(ratio * 100)} %`;
}
