/**
 * Gráfica de magnitud vs tiempo usando Recharts
 */

'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { CHART_AXIS_STROKE, CHART_GRID_STROKE } from '@/lib/chart-theme';
import { SeismicEvent } from '@/lib/types';
import { getMagnitudeColor } from '@/lib/utils';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from 'recharts';

/**
 * Umbrales de severidad M5.0 y M4.0. Son escala semántica —el MISMO rojo y el
 * MISMO ámbar que `getMagnitudeColor` (`lib/utils.ts:28-34`)— y por eso NO se
 * tematizan: si cambiaran con el tema, dos sismos iguales se verían distintos
 * según la hora del día.
 *
 * Van hoisteados a constantes, y no inline en el `stroke`, por el mismo motivo
 * que `TremorPanel.THRESHOLD_COLOR`: `chart-chrome.test.ts` prohíbe el hex
 * pegado al atributo de cromo, y no puede distinguir cromo de dato mirando el
 * literal. La constante con nombre deja explícito que esto es DATO.
 */
const M5_THRESHOLD_COLOR = '#ef4444';
const M4_THRESHOLD_COLOR = '#f59e0b';

interface MagnitudeTimeChartProps {
  eventos: SeismicEvent[];
  className?: string;
}

export function MagnitudeTimeChart({ eventos, className }: MagnitudeTimeChartProps) {
  const t = useTranslations('charts');
  const tCommon = useTranslations('common');
  // Formatter con el locale activo (Decision 6): reemplaza al 'es-ES'
  // hardcodeado del tickFormatter — con la UI en EN, ejes y tooltip salen en
  // formato en-US. Las horas van en UTC: el eje usa opciones inline, que
  // heredan el timeZone global de i18n/request.ts (antes caían en la zona del
  // navegador y quedaban corridas respecto del tooltip, que sí era UTC).
  const format = useFormatter();
  const data = eventos.map((ev) => ({
    timestamp: new Date(ev.hora_utc).getTime(),
    mag: ev.mag,
    lugar: ev.lugar,
    color: getMagnitudeColor(ev.mag),
  }));

  return (
    <div className={className}>
      <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
        {t('magnitudeVsTime')}
      </h3>
      <ResponsiveContainer width="100%" height={300}>
        <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
          <XAxis
            type="number"
            dataKey="timestamp"
            name={t('timeAxis')}
            domain={['dataMin', 'dataMax']}
            tickFormatter={(ts) =>
              format.dateTime(new Date(ts), { hour: '2-digit', minute: '2-digit' })
            }
            stroke={CHART_AXIS_STROKE}
          />
          <YAxis
            type="number"
            dataKey="mag"
            name={t('magnitudeAxis')}
            domain={[0, 'dataMax + 1']}
            stroke={CHART_AXIS_STROKE}
          />
          <Tooltip
            content={({ payload }) => {
              if (!payload || payload.length === 0) return null;
              const data = payload[0].payload;
              return (
                <div className="rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
                  <p className="font-bold">M{data.mag.toFixed(1)}</p>
                  <p className="text-sm">
                    {format.dateTime(new Date(data.timestamp), 'medium')} {tCommon('utcSuffix')}
                  </p>
                  <p className="text-xs text-muted-foreground">{data.lugar}</p>
                </div>
              );
            }}
          />
          <ReferenceLine y={5} stroke={M5_THRESHOLD_COLOR} strokeDasharray="3 3" label="M5.0" />
          <ReferenceLine y={4} stroke={M4_THRESHOLD_COLOR} strokeDasharray="3 3" label="M4.0" />
          <Scatter data={data} fill="#8884d8">
            {data.map((entry, index) => (
              <Cell key={index} fill={entry.color} />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
