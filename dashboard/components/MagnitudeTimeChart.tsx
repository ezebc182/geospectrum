/**
 * Gráfica de magnitud vs tiempo usando Recharts
 */

'use client';

import { useFormatter, useTranslations } from 'next-intl';
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

interface MagnitudeTimeChartProps {
  eventos: SeismicEvent[];
  className?: string;
}

export function MagnitudeTimeChart({ eventos, className }: MagnitudeTimeChartProps) {
  const t = useTranslations('charts');
  // Formatter con el locale activo (Decision 6): reemplaza al 'es-ES'
  // hardcodeado del tickFormatter y al formatDateTime fijo en es-AR del
  // tooltip — con la UI en EN, ejes y tooltip salen en formato en-US.
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
          <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
          <XAxis
            type="number"
            dataKey="timestamp"
            name={t('timeAxis')}
            domain={['dataMin', 'dataMax']}
            tickFormatter={(ts) =>
              format.dateTime(new Date(ts), { hour: '2-digit', minute: '2-digit' })
            }
            stroke="#9ca3af"
          />
          <YAxis
            type="number"
            dataKey="mag"
            name={t('magnitudeAxis')}
            domain={[0, 'dataMax + 1']}
            stroke="#9ca3af"
          />
          <Tooltip
            content={({ payload }) => {
              if (!payload || payload.length === 0) return null;
              const data = payload[0].payload;
              return (
                <div className="rounded-lg border border-gray-700 bg-gray-900 p-3 text-white shadow-lg">
                  <p className="font-bold">M{data.mag.toFixed(1)}</p>
                  <p className="text-sm">{format.dateTime(new Date(data.timestamp), 'medium')}</p>
                  <p className="text-xs text-gray-400">{data.lugar}</p>
                </div>
              );
            }}
          />
          <ReferenceLine y={5} stroke="#ef4444" strokeDasharray="3 3" label="M5.0" />
          <ReferenceLine y={4} stroke="#f59e0b" strokeDasharray="3 3" label="M4.0" />
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
