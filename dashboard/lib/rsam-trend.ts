/**
 * Fusión multi-canal de series RSAM para el panel de tendencia
 * (analytics-professional-panels, 4.6; spec signal-analysis "Fusión
 * multi-canal", design Decision 3).
 *
 * `RsamTrendChart` pide `GET /stations/{channel}/rsam` por canal con
 * `Promise.allSettled` y pasa acá los resultados etiquetados. Esta función
 * PURA alinea por instante y produce las filas de un `LineChart` multi-serie.
 *
 * Reglas (spec):
 * 1. Cada `t` presente en al menos un canal produce exactamente UNA fila.
 * 2. `value` es el que devolvió el endpoint, sin promediar ni recalcular.
 * 3. Un canal sin muestra en un `t` vale `null` — nunca `0` ni `undefined`
 *    ([R27]: Recharts lo corta con `connectNulls={false}`; `0` dibujaría un
 *    punto falso en el piso).
 * 4. Un canal rechazado no aporta claves a ninguna fila; su razón va en
 *    `errors[channel]` para el estado de error POR SERIE.
 *
 * `t` se lleva a ms epoch: el mismo instante puede llegar como `…Z` (6
 * decimales, `str(UTCDateTime)`) o `+00:00`, y como string no colapsaría.
 */

import type { RsamResponse } from './api';

export interface SettledSeries {
  channel: string;
  result: PromiseSettledResult<RsamResponse>;
}

/** `{t, [channel]: value | null}`; `t` en ms epoch. */
export type MergedRow = { t: number } & Record<string, number | null>;

export interface MergedSeries {
  rows: MergedRow[];
  /** Canales que resolvieron, en el orden de entrada (para los `<Line>`). */
  channels: string[];
  /** Canal rechazado ⇒ mensaje de la razón. */
  errors: Record<string, string>;
}

function reasonMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

export function mergeSeriesByTime(settled: SettledSeries[]): MergedSeries {
  const channels: string[] = [];
  const errors: Record<string, string> = {};
  // t (ms) → { channel → value }
  const byTime = new Map<number, Map<string, number | null>>();

  for (const { channel, result } of settled) {
    if (result.status === 'rejected') {
      errors[channel] = reasonMessage(result.reason);
      continue;
    }
    channels.push(channel);
    for (const sample of result.value.samples) {
      const t = Date.parse(sample.t);
      if (!Number.isFinite(t)) continue;
      let row = byTime.get(t);
      if (!row) {
        row = new Map();
        byTime.set(t, row);
      }
      row.set(channel, Number.isFinite(sample.value) ? sample.value : null);
    }
  }

  const rows: MergedRow[] = [...byTime.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, values]) => {
      const row: MergedRow = { t };
      for (const channel of channels) {
        row[channel] = values.has(channel) ? (values.get(channel) as number | null) : null;
      }
      return row;
    });

  return { rows, channels, errors };
}

/** Tope de FDSN que ya imponen `/waveform`, `/spectra`, `/rsam` y
 * `/analytics/tremor` (`MAX_WAVEFORM_WINDOW_HOURS` del backend). */
export const MAX_SIGNAL_WINDOW_HOURS = 24;

export interface SignalWindow {
  /** ISO UTC, para el `?start=` de los endpoints. */
  start: string;
  end: string;
  /** Lo mismo en ms epoch: la forma de `TimeWindow` que piden los fetchers. */
  startMs: number;
  endMs: number;
}

/** `[now − h, now]`. Lanza si `h` no está en `(0, 24]`: nunca se pide una
 * ventana que el backend va a rechazar con 422. */
export function signalWindowFromHours(hours: number, nowMs: number): SignalWindow {
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_SIGNAL_WINDOW_HOURS) {
    throw new RangeError(`signalWindowFromHours: hours debe estar en (0, ${MAX_SIGNAL_WINDOW_HOURS}], recibido ${hours}`);
  }
  const endMs = nowMs;
  const startMs = endMs - hours * 3600 * 1000;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    startMs,
    endMs,
  };
}
