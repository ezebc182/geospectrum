/**
 * Panel de uptime histórico por canal (analytics-professional-panels, 5.4;
 * design Decision 2 y 8, spec dashboard-ui "Panel de uptime histórico").
 *
 * Fuente: `GET /analytics/station-uptime?days=&bucket=hour` — el backend
 * fuerza `bucket=day` por encima de 14 días, así que la granularidad se lee
 * de la RESPUESTA. Dos vistas: ranking peor-primero (`rankStations`) y la
 * línea de tiempo del canal elegido (`stationTimeline`), por defecto el peor.
 *
 * La regla que este componente respeta a rajatabla es `null ≠ 0` ([R12],
 * Decisión 3 de la spec): `ratio: null` es "nadie miró" (sin barra, etiqueta
 * "sin observación"); `0` es "se miró y no mandó nada" (barra de altura cero,
 * "0 %"); `overall: null` es "sin observaciones", nunca `0 %` ni `NaN %`.
 * Recharts no dibuja un `null`, así que las filas van tal cual; la tira de
 * buckets debajo del gráfico lleva la etiqueta textual de cada uno (es lo que
 * se verifica: el SVG no se asserta).
 */

'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { getStationUptime, type StationUptimeResponse } from '@/lib/analytics';
import {
  CHART_AXIS_STROKE,
  CHART_GRID_STROKE,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
} from '@/lib/chart-theme';
import { percentLabel, rankStations, stationTimeline, type TimelineRow } from '@/lib/uptime-series';

interface StationUptimeChartProps {
  days: number;
  className?: string;
}

type PanelState =
  | { status: 'loading' }
  | { status: 'ready'; data: StationUptimeResponse }
  | { status: 'error' };

/** Sequential de UN tono (magnitud): emerald, claro → oscuro con el ratio. */
const RATIO_COLOR = '#059669';
const BAR_GAP = 2;

function ratioToPercent(ratio: number | null): number | null {
  return ratio === null ? null : Math.round(ratio * 100);
}

export function StationUptimeChart({ days, className }: StationUptimeChartProps) {
  const t = useTranslations('analytics');
  const format = useFormatter();
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    setPicked(null);
    getStationUptime(days, 'hour')
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const title = <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">{t('uptime.title')}</h3>;

  if (state.status === 'loading') {
    return (
      <div className={className}>
        {title}
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <span
            aria-hidden
            className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-solid border-current border-r-transparent"
          />
          {t('uptime.loading')}
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className={className}>
        {title}
        <div
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {t('uptime.error')}
        </div>
      </div>
    );
  }

  const { data } = state;
  const ranked = rankStations(data.overall);
  if (ranked.length === 0 || Object.keys(data.stations).length === 0) {
    return (
      <div className={className}>
        {title}
        <p className="text-sm text-muted-foreground">{t('uptime.noHistoryYet')}</p>
      </div>
    );
  }

  const selected = picked && picked in data.stations ? picked : ranked[0].channel;
  const rankingRows = ranked
    .filter((s) => s.kind === 'observed')
    .map((s) => ({ channel: s.channel, pct: ratioToPercent(s.ratio) as number }));
  const timeline: TimelineRow[] = stationTimeline(data, selected);
  const timelineRows = timeline.map((row) => ({ ...row, pct: ratioToPercent(row.ratio) }));

  const bucketTime = (ts: number) =>
    data.bucket === 'day'
      ? format.dateTime(new Date(ts), { day: '2-digit', month: '2-digit' })
      : format.dateTime(new Date(ts), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  const bucketLabel = (row: TimelineRow): string => {
    if (row.ratio === null) return t('uptime.noObservation');
    if (row.ratio === 0) return t('uptime.zeroPercent');
    return percentLabel(row.ratio) ?? t('uptime.noObservation');
  };

  return (
    <div className={className} data-testid="station-uptime">
      {title}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section>
          <h4 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">{t('uptime.ranking')}</h4>
          {rankingRows.length > 0 && (
            <ResponsiveContainer width="100%" height={Math.max(160, rankingRows.length * 22)}>
              <BarChart
                data={rankingRows}
                layout="vertical"
                margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
                barCategoryGap={BAR_GAP}
                data-chart="ranking"
              >
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} horizontal={false} />
                <XAxis type="number" domain={[0, 100]} unit=" %" stroke={CHART_AXIS_STROKE} />
                <YAxis type="category" dataKey="channel" width={120} stroke={CHART_AXIS_STROKE} tick={{ fontSize: 10 }} />
                <Tooltip
                  contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
                  labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                  formatter={(value) => [`${value} %`, t('uptime.title')]}
                />
                <Bar dataKey="pct" fill={RATIO_COLOR} radius={[0, 4, 4, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          )}
          <ol className="mt-2 max-h-56 space-y-1 overflow-y-auto text-xs">
            {ranked.map((s) => {
              const isSelected = s.channel === selected;
              return (
                <li
                  key={s.channel}
                  data-testid="uptime-rank-row"
                  data-channel={s.channel}
                  className="flex items-center justify-between gap-2"
                >
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={t('uptime.selectStation', { channel: s.channel })}
                    onClick={() => setPicked(s.channel)}
                    className={
                      'rounded px-1 font-mono transition-colors ' +
                      (isSelected
                        ? 'bg-seismic-600 text-white'
                        : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700')
                    }
                  >
                    {s.channel}
                  </button>
                  <span className="text-muted-foreground">
                    {s.kind === 'unobserved' ? t('uptime.noObservations') : percentLabel(s.ratio)}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>

        <section>
          <h4 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('uptime.timeline', { channel: selected })}
          </h4>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={timelineRows} margin={{ top: 4, right: 16, bottom: 4, left: 8 }} barCategoryGap={BAR_GAP} data-chart="timeline">
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} vertical={false} />
              <XAxis
                dataKey="t"
                tickFormatter={(ts: number) => bucketTime(ts)}
                stroke={CHART_AXIS_STROKE}
                tick={{ fontSize: 10 }}
                minTickGap={24}
              />
              <YAxis type="number" domain={[0, 100]} unit=" %" stroke={CHART_AXIS_STROKE} />
              <Tooltip
                content={({ payload }) => {
                  if (!payload || payload.length === 0) return null;
                  const row = payload[0].payload as TimelineRow;
                  return (
                    <div className="rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
                      <p className="text-sm">{bucketTime(row.t)}</p>
                      <p className="font-mono text-xs">{bucketLabel(row)}</p>
                      {row.inProgress && <p className="text-xs text-gray-400">{t('uptime.inProgress')}</p>}
                    </div>
                  );
                }}
              />
              <Bar dataKey="pct" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                {timelineRows.map((row) => (
                  <Cell key={row.t} fill={RATIO_COLOR} fillOpacity={row.inProgress ? 0.5 : 1} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {/* Tira textual de buckets: es la que distingue null de 0 en el DOM
              (el SVG no lo puede afirmar) y la que lee un lector de pantalla. */}
          <ol className="mt-2 flex flex-wrap gap-0.5" aria-label={t('uptime.timeline', { channel: selected })}>
            {timeline.map((row) => {
              const label = bucketLabel(row);
              const observedNote =
                data.bucket === 'day' && row.ratio !== null ? ` (${t('uptime.observedHours', { hours: row.observedHours })})` : '';
              const inProgress = row.inProgress ? ` — ${t('uptime.inProgress')}` : '';
              return (
                <li
                  key={row.t}
                  data-testid="uptime-bucket"
                  title={`${bucketTime(row.t)}: ${label}${observedNote}${inProgress}`}
                  className={
                    'h-3 w-3 rounded-sm ' +
                    (row.ratio === null
                      ? 'border border-dashed border-gray-400 bg-transparent'
                      : row.inProgress
                        ? 'ring-1 ring-amber-500'
                        : '')
                  }
                  style={row.ratio === null ? undefined : { backgroundColor: RATIO_COLOR, opacity: 0.25 + 0.75 * row.ratio }}
                >
                  <span className="sr-only">
                    {bucketTime(row.t)}: {label}
                    {observedNote}
                    {inProgress}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </div>
  );
}
