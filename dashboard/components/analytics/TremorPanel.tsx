/**
 * Panel de tremor volcánico de /analytics (analytics-professional-panels,
 * 5.6; spec dashboard-ui "Panel de tremor volcánico", design Decision 4 y 8,
 * [R4]/[R25]).
 *
 * Carga sola (`useEffect` + flag de cancelación, molde `RsamTrendChart`): el
 * tremor NO depende del área, así que la página no lo revalida. Sin SWR — los
 * componentes de `components/analytics/` no importan `swr` (Decision 8).
 *
 * Reglas que este componente hace cumplir:
 * - Los sombreados son EXACTAMENTE `episodes[i].start/end` de la respuesta
 *   (`episodesToReferenceAreas`), nunca bordes recalculados.
 * - La línea de umbral se dibuja en `threshold_rsam` TAL CUAL
 *   (`thresholdLine`), nunca en un `baseline × factor` recalculado acá.
 * - `episodes: []` es un ESTADO explícito ("sin episodios sostenidos"), no un
 *   panel vacío.
 * - El 404 de `/tremor` es un ESTADO ("sin datos para este canal"), no un
 *   error: `getTremor` ya lo devuelve tipado como `{kind: 'no-data'}`.
 * - La etiqueta dice "episodio sostenido (candidato a tremor)", NUNCA "tremor
 *   detectado": la detección de tremor es una interpretación del sismólogo,
 *   no del umbral.
 */

'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { getTremor, type TremorBand, type TremorFiSign, type TremorResult } from '@/lib/analytics';
import { CHART_AXIS_STROKE, CHART_GRID_STROKE } from '@/lib/chart-theme';
import type { SignalWindow } from '@/lib/rsam-trend';
import {
  bandLabelKey,
  episodesToReferenceAreas,
  fiSignLabelKey,
  samplesToRows,
  thresholdLine,
} from '@/lib/tremor-episodes';

/** Claves de banda y de signo de FI, en la forma que espera `t()`. */
type TremorMessageKey =
  | `tremor.band.${TremorBand}`
  | `tremor.fiSign.${TremorFiSign}`;

interface TremorPanelProps {
  /** `null` ⇒ estado "elegí un canal"; no se pide nada. */
  channel: string | null;
  window: SignalWindow;
  className?: string;
}

const RSAM_COLOR = '#2563eb';
const THRESHOLD_COLOR = '#dc2626';
const EPISODE_FILL = '#f59e0b';

/** Estado interno: `undefined` mientras vuela la request. */
type PanelState = { kind: 'result'; result: TremorResult } | { kind: 'error' } | undefined;

export function TremorPanel({ channel, window: win, className }: TremorPanelProps) {
  const t = useTranslations('analytics');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const [state, setState] = useState<PanelState>(undefined);

  useEffect(() => {
    if (!channel) {
      setState(undefined);
      return;
    }
    let cancelled = false;
    setState(undefined);
    getTremor(channel, win)
      .then((result) => {
        if (!cancelled) setState({ kind: 'result', result });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
    // Deps por VALOR: la página recrea `window` en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, win.startMs, win.endMs]);

  const title = <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">{t('tremor.title')}</h3>;

  if (!channel) {
    return (
      <div className={className}>
        {title}
        <p data-testid="tremor-empty" className="text-sm text-muted-foreground">
          {t('picker.chooseChannel')}
        </p>
      </div>
    );
  }

  if (state === undefined) {
    return (
      <div className={className}>
        {title}
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <span
            aria-hidden
            className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-solid border-current border-r-transparent"
          />
          {t('tremor.loading')}
        </div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className={className}>
        {title}
        <div
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {t('tremor.error')}
        </div>
      </div>
    );
  }

  // 404: estado del panel, no error. Ningún gráfico: no hay muestras que dibujar.
  if (state.result.kind === 'no-data') {
    return (
      <div className={className}>
        {title}
        <p data-testid="tremor-no-data" className="text-sm text-muted-foreground">
          {t('tremor.noDataForChannel')}
        </p>
      </div>
    );
  }

  const data = state.result.data;
  const rows = samplesToRows(data.samples);
  const areas = episodesToReferenceAreas(data.episodes);
  const threshold = thresholdLine(data);
  const baseline = data.baseline_rsam;

  const utc = (iso: string) => format.dateTime(new Date(iso), { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={className} data-testid="tremor-panel">
      {title}

      <p className="mb-1 text-sm font-medium text-amber-800 dark:text-amber-300">{t('tremor.sustainedEpisode')}</p>
      <p className="text-sm text-gray-700 dark:text-gray-300">
        {t('tremor.fraction', { percent: `${(data.tremor_fraction * 100).toFixed(1)} %` })}
      </p>
      <p className="mb-4 text-xs text-muted-foreground">
        {t('tremor.parameters', {
          factor: String(data.parameters.baseline_factor),
          periods: String(data.parameters.min_duration_periods),
        })}
      </p>

      {rows.length > 0 && (
        <>
          <ul data-testid="tremor-legend" className="mb-2 flex flex-wrap gap-3 text-xs text-gray-700 dark:text-gray-300">
            <li className="flex items-center gap-1">
              <span aria-hidden className="inline-block h-0.5 w-3" style={{ backgroundColor: RSAM_COLOR }} />
              RSAM
            </li>
            <li className="flex items-center gap-1">
              <span aria-hidden className="inline-block h-0.5 w-3" style={{ backgroundColor: THRESHOLD_COLOR }} />
              {t('tremor.threshold')}
            </li>
          </ul>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={rows} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
              <XAxis
                type="number"
                dataKey="t"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(ts: number) => format.dateTime(new Date(ts), { hour: '2-digit', minute: '2-digit' })}
                stroke={CHART_AXIS_STROKE}
              />
              <YAxis type="number" domain={[0, 'dataMax']} stroke={CHART_AXIS_STROKE} />
              <Tooltip
                content={({ payload, label }) => {
                  if (!payload || payload.length === 0) return null;
                  return (
                    <div className="rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
                      <p className="text-sm">
                        {format.dateTime(new Date(Number(label)), 'medium')} {tCommon('utcSuffix')}
                      </p>
                      {payload.map((entry) => (
                        <p key={String(entry.dataKey)} className="font-mono text-xs">
                          {String(entry.dataKey)}:{' '}
                          {entry.value === null || entry.value === undefined ? '—' : Math.round(Number(entry.value))}
                        </p>
                      ))}
                    </div>
                  );
                }}
              />
              {/* Un sombreado por episodio, con los bordes EXACTOS de la respuesta. */}
              {areas.map((area) => (
                <ReferenceArea
                  key={`${area.x1}-${area.x2}`}
                  x1={area.x1}
                  x2={area.x2}
                  fill={EPISODE_FILL}
                  fillOpacity={0.25}
                  ifOverflow="extendDomain"
                />
              ))}
              {baseline !== null && (
                <ReferenceLine y={baseline} stroke={CHART_AXIS_STROKE} strokeDasharray="4 4" label={t('tremor.baseline')} />
              )}
              {threshold !== null && (
                <ReferenceLine y={threshold} stroke={THRESHOLD_COLOR} strokeDasharray="6 3" label={t('tremor.threshold')} />
              )}
              <Line type="monotone" dataKey="rsam" stroke={RSAM_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </>
      )}

      {data.episodes.length === 0 ? (
        <p data-testid="tremor-no-episodes" className="mt-4 text-sm text-muted-foreground">
          {t('tremor.noEpisodes')}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase text-muted-foreground">
                <th className="px-2 py-1">{t('tremor.columns.start')}</th>
                <th className="px-2 py-1">{t('tremor.columns.end')}</th>
                <th className="px-2 py-1">{t('tremor.columns.duration')}</th>
                <th className="px-2 py-1">{t('tremor.columns.meanRatio')}</th>
                <th className="px-2 py-1">{t('tremor.columns.band')}</th>
                <th className="px-2 py-1">{t('tremor.columns.fiSign')}</th>
                <th className="px-2 py-1">{t('tremor.columns.onsetRatio')}</th>
              </tr>
            </thead>
            <tbody>
              {data.episodes.map((ep) => (
                <tr
                  key={`${ep.start}-${ep.end}`}
                  data-testid="tremor-episode"
                  className="border-t border-border text-gray-700 dark:text-gray-300"
                >
                  <td className="px-2 py-1 font-mono">{utc(ep.start)}</td>
                  <td className="px-2 py-1 font-mono">{utc(ep.end)}</td>
                  <td className="px-2 py-1 font-mono">{Math.round(ep.duration_s / 60)} min</td>
                  <td className="px-2 py-1 font-mono">{ep.mean_ratio.toFixed(2)}</td>
                  {/* Las libs puras devuelven la clave como `string` (no
                      conocen el diccionario); el cast la reancla al literal
                      que `useTranslations` exige. Las claves existen: las fija
                      `messages/parity.test.ts` y el test de este panel. */}
                  <td className="px-2 py-1">{t(bandLabelKey(ep.band) as TremorMessageKey)}</td>
                  <td className="px-2 py-1">{t(fiSignLabelKey(ep.fi_sign) as TremorMessageKey)}</td>
                  <td className="px-2 py-1 font-mono">{ep.onset_ratio.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
