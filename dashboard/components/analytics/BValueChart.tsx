/**
 * Panel de b-value / Gutenberg-Richter de /analytics
 * (analytics-professional-panels, 5.5; design Decision 1 y 8, spec
 * dashboard-ui "Panel de b-value con estado de datos no estimables").
 *
 * PRESENTACIONAL: recibe `data`/`error`/`isLoading` del `useSWR` de la
 * página. Es la página quien revalida al cambiar el área
 * (`Promise.all` de las claves dependientes del área, Decision 8); este
 * componente no sabe de SWR, de fetch ni de áreas.
 *
 * La regla que manda (criterio de éxito literal del proposal): con
 * `status !== "ok"` NO se renderiza ningún número de b ni la recta de
 * ajuste. El narrow es por `status` — el tipo `BValueResponse` ni siquiera
 * tiene `b` fuera de `BValueOk` ([R8]) — y un `b` que viniera de contrabando
 * en un body malformado se ignora. El histograma (`bins`) sí se muestra en
 * los tres estados: es el dato honesto.
 *
 * Gráfico: distribución frecuencia-magnitud (FMD). Barras = N por bin (no
 * acumulado, eje derecho); puntos = log10 del N acumulado (eje izquierdo,
 * `null` para 0 — nunca `-Infinity`); recta `log10 N = a − b·M` SOLO con
 * `status === "ok"`, arrancando en Mc. Todo sale de las libs puras de 4.2.
 */

'use client';

import { useTranslations } from 'next-intl';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { BValueResponse } from '@/lib/analytics';
import { CHART_AXIS_STROKE, CHART_GRID_STROKE } from '@/lib/chart-theme';
import {
  fittedLinePoints,
  formatB,
  maxBinMagnitude,
  notEstimableMessageArgs,
  toFmdRows,
} from '@/lib/b-value-plot';

interface BValueChartProps {
  data?: BValueResponse;
  error?: unknown;
  isLoading: boolean;
  className?: string;
}

const BAR_COLOR = '#2563eb';
const CUMULATIVE_COLOR = '#d97706';
const FIT_COLOR = '#059669';

export function BValueChart({ data, error, isLoading, className }: BValueChartProps) {
  const t = useTranslations('analytics');

  const title = <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">{t('bValue.title')}</h3>;

  // Sin datos: error (SU tarjeta, nunca el `loadError` de página) o carga.
  // `isLoading` de SWR es false mientras no hay clave (p. ej. área sin
  // resolver): igual se muestra el loader, porque "nada" no es un estado.
  if (!data) {
    if (error) {
      return (
        <div className={className}>
          {title}
          <div
            role="alert"
            className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
          >
            {t('bValue.error')}
          </div>
        </div>
      );
    }
    return (
      <div className={className}>
        {title}
        <div role="status" aria-busy={isLoading} className="flex items-center gap-2 text-sm text-muted-foreground">
          <span
            aria-hidden
            className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-solid border-current border-r-transparent"
          />
          {t('bValue.loading')}
        </div>
      </div>
    );
  }

  const rows = toFmdRows(data.bins);
  const notEstimable = notEstimableMessageArgs(data);
  // El número y la recta existen ÚNICAMENTE dentro del narrow `status === "ok"`.
  const estimate = data.status === 'ok' ? formatB(data.b, data.sigma_b) : null;
  const maxM = maxBinMagnitude(data.bins);
  const fit =
    data.status === 'ok' && data.mc !== null && maxM !== null
      ? fittedLinePoints(data.a, data.b, data.mc, maxM)
      : [];
  const magTypes = Object.entries(data.mag_type_counts);

  return (
    <div className={className} data-testid="b-value">
      {title}

      {notEstimable ? (
        <div
          data-testid={`b-value-${notEstimable.kind}`}
          className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {t(`bValue.${notEstimable.kind}`, { n: notEstimable.n, min: notEstimable.min })}
        </div>
      ) : (
        estimate && (
          <div className="mb-4 flex flex-wrap items-baseline gap-3">
            <span className="text-sm text-muted-foreground">{t('bValue.bValueLabel')}</span>
            <span data-testid="b-value-number" className="font-mono text-3xl font-semibold text-gray-900 dark:text-white">
              {estimate.b} <span className="text-base text-muted-foreground">{t('bValue.sigma', { sigma: estimate.sigma })}</span>
            </span>
          </div>
        )
      )}

      <dl className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-700 dark:text-gray-300">
        <dd>{t('bValue.nAboveMc', { n: data.n_above_mc })}</dd>
        {data.mc !== null && <dd>{t('bValue.mc', { mc: data.mc.toFixed(1) })}</dd>}
        <dd className="font-mono text-xs text-muted-foreground">{t('bValue.method', { method: data.method })}</dd>
      </dl>

      {data.mc_at_catalog_floor && (
        <p className="mb-4 text-sm text-amber-700 dark:text-amber-300">{t('bValue.mcAtFloor')}</p>
      )}

      {rows.length > 0 && (
        <>
          <ul data-testid="b-value-legend" className="mb-2 flex flex-wrap gap-3 text-xs text-gray-700 dark:text-gray-300">
            <li className="flex items-center gap-1">
              <span aria-hidden className="inline-block h-2 w-3 rounded-sm" style={{ backgroundColor: BAR_COLOR }} />
              {t('bValue.nonCumulative')}
            </li>
            <li className="flex items-center gap-1">
              <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: CUMULATIVE_COLOR }} />
              {t('bValue.cumulative')}
            </li>
            {fit.length > 0 && (
              <li className="flex items-center gap-1">
                <span aria-hidden className="inline-block h-0.5 w-3" style={{ backgroundColor: FIT_COLOR }} />
                {t('bValue.fit')}
              </li>
            )}
          </ul>
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={rows} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
              <XAxis
                type="number"
                dataKey="m"
                name={t('bValue.magnitudeAxis')}
                domain={['dataMin', 'dataMax']}
                tickFormatter={(m: number) => m.toFixed(1)}
                stroke={CHART_AXIS_STROKE}
              />
              <YAxis yAxisId="log" type="number" name={`log10 ${t('bValue.countAxis')}`} stroke={CHART_AXIS_STROKE} />
              <YAxis yAxisId="count" orientation="right" type="number" name={t('bValue.countAxis')} stroke={CHART_AXIS_STROKE} />
              <Tooltip
                content={({ payload, label }) => {
                  if (!payload || payload.length === 0) return null;
                  return (
                    <div className="rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
                      <p className="text-sm">M {Number(label).toFixed(1)}</p>
                      {payload.map((entry) => (
                        <p key={String(entry.dataKey)} className="font-mono text-xs">
                          {entry.name}: {entry.value === null || entry.value === undefined ? '—' : Number(entry.value).toFixed(2)}
                        </p>
                      ))}
                    </div>
                  );
                }}
              />
              <Bar yAxisId="count" dataKey="count" name={t('bValue.nonCumulative')} fill={BAR_COLOR} fillOpacity={0.6} isAnimationActive={false} />
              <Scatter yAxisId="log" dataKey="log10Cumulative" name={t('bValue.cumulative')} fill={CUMULATIVE_COLOR} isAnimationActive={false} />
              {fit.length > 0 && (
                <Line
                  yAxisId="log"
                  data={fit}
                  dataKey="log10N"
                  name={t('bValue.fit')}
                  stroke={FIT_COLOR}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </>
      )}

      {magTypes.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">{t('bValue.magTypes')}</h4>
          <ul data-testid="b-value-mag-types" className="flex flex-wrap gap-3 font-mono text-xs text-muted-foreground">
            {magTypes.map(([magType, count]) => (
              <li key={magType}>
                {magType}: {count}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
