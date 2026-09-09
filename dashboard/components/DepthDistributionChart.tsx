/**
 * Gráfica de distribución de profundidades
 */

'use client';

import { useTranslations } from 'next-intl';
import {
  CHART_AXIS_STROKE,
  CHART_GRID_STROKE,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_ITEM_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
} from '@/lib/chart-theme';
import { SeismicEvent } from '@/lib/types';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { getDepthColor } from '@/lib/utils';

/**
 * Colores de los cuatro bins de profundidad, en el mismo orden que los cortes
 * de `getDepthColor` (`lib/utils.ts:65-70`): <70, 70-150, 150-300, >300 km.
 *
 * Son escala semántica, NO cromo: la profundidad de un sismo no cambia con el
 * tema de la UI, así que estos hex quedan fijos a propósito y no salen de
 * `chart-theme.ts`.
 *
 * Hoisteados a constante con nombre —no inline en cada bin— por el mismo
 * motivo que `TremorPanel.THRESHOLD_COLOR`: `chart-chrome.test.ts` prohíbe el
 * hex pegado a un atributo de cromo y no puede distinguir cromo de dato
 * mirando el literal suelto. El nombre deja explícito que esto es DATO.
 */
const DEPTH_BIN_COLORS = ['#ef4444', '#f59e0b', '#3b82f6', '#8b5cf6'] as const;

interface DepthDistributionChartProps {
  eventos: SeismicEvent[];
  className?: string;
}

export function DepthDistributionChart({ eventos, className }: DepthDistributionChartProps) {
  const t = useTranslations('charts');
  // Agrupar por rangos de profundidad
  const bins = [
    { name: '<70 km', min: 0, max: 70, count: 0, color: DEPTH_BIN_COLORS[0] },
    { name: '70-150 km', min: 70, max: 150, count: 0, color: DEPTH_BIN_COLORS[1] },
    { name: '150-300 km', min: 150, max: 300, count: 0, color: DEPTH_BIN_COLORS[2] },
    { name: '>300 km', min: 300, max: Infinity, count: 0, color: DEPTH_BIN_COLORS[3] },
  ];

  eventos.forEach((ev) => {
    if (ev.prof_km) {
      const bin = bins.find((b) => ev.prof_km! >= b.min && ev.prof_km! < b.max);
      if (bin) bin.count++;
    }
  });

  return (
    <div className={className}>
      <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
        {t('depthDistribution')}
      </h3>
      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={bins} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
          <XAxis dataKey="name" stroke={CHART_AXIS_STROKE} />
          <YAxis stroke={CHART_AXIS_STROKE} />
          <Tooltip
            contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
            itemStyle={CHART_TOOLTIP_ITEM_STYLE}
          />
          <Bar dataKey="count" name={t('eventsSeries')}>
            {bins.map((entry, index) => (
              <Cell key={index} fill={entry.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
