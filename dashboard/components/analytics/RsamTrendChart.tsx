/**
 * Tendencia RSAM multi-canal de /analytics (analytics-professional-panels,
 * 5.3; design Decision 3 y 8, spec dashboard-ui "Panel de tendencia RSAM").
 *
 * NO es `RsamChart.tsx` (canvas del detalle de estación, un canal, ventana
 * de 2 min): este es Recharts, multi-serie, con el patrón visual de
 * `MagnitudeTimeChart`. Mismo endpoint (`GET /stations/{channel}/rsam`), dos
 * consumidores.
 *
 * Reglas:
 * - Una request por canal, período fijo de SWARM (600 s ⇒ 144 puntos en 24 h),
 *   resueltas de forma independiente: un 404 de FDSN degrada SOLO su serie
 *   (`role="alert"` etiquetado con el canal), nunca el panel.
 * - Loader POR SERIE: la primera carga de un canal son segundos de FDSN (el
 *   warm-up precalienta `waveform:*`, no `rsam:*`) y el panel lo dice por canal.
 * - Hueco = `null` ([R27]): `mergeSeriesByTime` lo deja en la fila y
 *   `connectNulls={false}` corta la línea. Nunca un punto en 0.
 * - Ventana ≤ 24 h: `signalWindowFromHours` ya lanza por encima del tope.
 */

'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { seismicAPI, type RsamResponse } from '@/lib/api';
import { mergeSeriesByTime, type SettledSeries, type SignalWindow } from '@/lib/rsam-trend';

/** Período de SWARM (`RSAM_PERIOD_SECONDS` del backend). */
export const RSAM_TREND_PERIOD_SECONDS = 600;

/** Categórica de 4 (tope del `StationPicker`), en orden fijo por posición del
 * canal: validada (dataviz) para visión normal y CVD con la leyenda como
 * codificación secundaria. */
const SERIES_COLORS = ['#2563eb', '#d97706', '#059669', '#7c3aed'] as const;

interface RsamTrendChartProps {
  channels: string[];
  window: SignalWindow;
  className?: string;
}

type SeriesResults = Record<string, PromiseSettledResult<RsamResponse>>;

export function RsamTrendChart({ channels, window: win, className }: RsamTrendChartProps) {
  const t = useTranslations('analytics');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const [results, setResults] = useState<SeriesResults>({});

  const channelsKey = channels.join('|');

  useEffect(() => {
    let cancelled = false;
    setResults({});
    for (const channel of channels) {
      seismicAPI
        .getStationRsam(channel, win, RSAM_TREND_PERIOD_SECONDS)
        .then((value) => {
          if (!cancelled) setResults((prev) => ({ ...prev, [channel]: { status: 'fulfilled', value } }));
        })
        .catch((reason: unknown) => {
          if (!cancelled) setResults((prev) => ({ ...prev, [channel]: { status: 'rejected', reason } }));
        });
    }
    return () => {
      cancelled = true;
    };
    // Deps por VALOR: la página puede recrear `channels` y `window` en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelsKey, win.startMs, win.endMs]);

  if (channels.length === 0) {
    return (
      <div className={className}>
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">{t('rsam.title')}</h3>
        <p data-testid="rsam-trend-empty" className="text-sm text-muted-foreground">
          {t('picker.chooseChannel')}
        </p>
      </div>
    );
  }

  const settled: SettledSeries[] = channels
    .filter((channel) => channel in results)
    .map((channel) => ({ channel, result: results[channel] }));
  const pending = channels.filter((channel) => !(channel in results));
  const merged = mergeSeriesByTime(settled);
  const emptyChannels = settled
    .filter((s) => s.result.status === 'fulfilled' && s.result.value.samples.length === 0)
    .map((s) => s.channel);
  const colorOf = (channel: string) => SERIES_COLORS[channels.indexOf(channel) % SERIES_COLORS.length];

  return (
    <div className={className} data-testid="rsam-trend">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('rsam.title')}</h3>
        <span className="font-mono text-xs text-muted-foreground">
          {t('rsam.period', { seconds: RSAM_TREND_PERIOD_SECONDS })}
        </span>
      </div>

      {pending.map((channel) => (
        <div
          key={channel}
          role="status"
          className="mb-2 flex items-center gap-2 text-sm text-muted-foreground"
        >
          <span
            aria-hidden
            className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-solid border-current border-r-transparent"
          />
          {t('rsam.loading', { channel })}
        </div>
      ))}

      {Object.entries(merged.errors).map(([channel, reason]) => (
        <div
          key={channel}
          role="alert"
          className="mb-2 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {t('rsam.errorFor', { channel, reason })}
        </div>
      ))}

      {emptyChannels.map((channel) => (
        <p key={channel} className="mb-2 text-sm text-muted-foreground">
          {t('rsam.noData', { channel })}
        </p>
      ))}

      {merged.channels.length > 0 && (
        <ul data-testid="rsam-trend-legend" className="mb-2 flex flex-wrap gap-3 text-xs">
          {merged.channels.map((channel) => (
            <li key={channel} className="flex items-center gap-1 font-mono text-gray-700 dark:text-gray-300">
              <span aria-hidden className="inline-block h-2 w-3 rounded-sm" style={{ backgroundColor: colorOf(channel) }} />
              {channel}
            </li>
          ))}
        </ul>
      )}

      {merged.rows.length > 0 && (
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={merged.rows} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis
              type="number"
              dataKey="t"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(ts: number) =>
                format.dateTime(new Date(ts), { hour: '2-digit', minute: '2-digit' })
              }
              stroke="#9ca3af"
            />
            <YAxis type="number" name={t('rsam.axis')} domain={[0, 'dataMax']} stroke="#9ca3af" />
            <Tooltip
              content={({ payload, label }) => {
                if (!payload || payload.length === 0) return null;
                return (
                  <div className="rounded-lg border border-gray-700 bg-gray-900 p-3 text-white shadow-lg">
                    <p className="text-sm">
                      {format.dateTime(new Date(Number(label)), 'medium')} {tCommon('utcSuffix')}
                    </p>
                    {payload.map((entry) => (
                      <p key={String(entry.dataKey)} className="font-mono text-xs">
                        <span aria-hidden className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: entry.color }} />
                        {String(entry.dataKey)}: {entry.value === null || entry.value === undefined ? '—' : Math.round(Number(entry.value))}
                      </p>
                    ))}
                  </div>
                );
              }}
            />
            {merged.channels.map((channel) => (
              <Line
                key={channel}
                type="monotone"
                dataKey={channel}
                stroke={colorOf(channel)}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
