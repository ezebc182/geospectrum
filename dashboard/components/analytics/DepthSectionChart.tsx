/**
 * Corte de profundidad de /analytics (analytics-professional-panels, 5.9).
 *
 * Scatter magnitud (X) vs profundidad (Y) sobre los MISMOS eventos que dibuja
 * `HypocenterMap`: el mapa muestra dónde y este panel a qué profundidad.
 *
 * El eje Y va `reversed` porque la profundidad crece hacia ABAJO — un corte
 * con el 0 abajo estaría dado vuelta respecto de cualquier sección
 * sismológica. El color sale de `getMagnitudeColor` (vía `toDepthSectionPoints`):
 * el mismo de la tabla y del resto de la app, para no inventar una cuarta
 * escala de magnitud.
 *
 * Presentacional puro: recibe los eventos por props, no pide nada.
 */

'use client';

import { useTranslations } from 'next-intl';
import {
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  CHART_AXIS_STROKE,
  CHART_GRID_STROKE,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_ITEM_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
} from '@/lib/chart-theme';
import { depthAxisDomain, formatDepthTick, toDepthSectionPoints } from '@/lib/depth-section';
import type { SeismicEvent } from '@/lib/types';

interface DepthSectionChartProps {
  eventos: SeismicEvent[];
  className?: string;
}

export function DepthSectionChart({ eventos, className }: DepthSectionChartProps) {
  const t = useTranslations('analytics');
  const { points, omitted } = toDepthSectionPoints(eventos);

  return (
    <div className={className} data-testid="depth-section">
      <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
        {t('depthSection.title')}
      </h3>

      {points.length > 0 && (
        <ResponsiveContainer width="100%" height={300}>
          <ScatterChart data={points} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
            <XAxis
              type="number"
              dataKey="mag"
              name={t('bValue.magnitudeAxis')}
              stroke={CHART_AXIS_STROKE}
              tick={{ fontSize: 12, fill: CHART_AXIS_STROKE }}
            />
            {/*
              `reversed` + dominio explícito: la profundidad crece hacia ABAJO,
              como en cualquier sección sismológica. El dominio se calcula a
              mano porque el automático de Recharts daba vuelta el eje y
              dibujaba ticks negativos hacia arriba.
            */}
            <YAxis
              type="number"
              dataKey="depthKm"
              name={t('depthSection.depthAxis')}
              reversed
              domain={depthAxisDomain(points.map((p) => p.depthKm))}
              tickFormatter={formatDepthTick}
              stroke={CHART_AXIS_STROKE}
              tick={{ fontSize: 12, fill: CHART_AXIS_STROKE }}
            />
            {/* Las tres props: sin `itemStyle` Recharts pinta cada fila con el
                color del punto (la escala de magnitud) y en oscuro no se lee.
                Acá el color no se pierde: sigue en el punto del gráfico. */}
            <Tooltip
              contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
              labelStyle={CHART_TOOLTIP_LABEL_STYLE}
              itemStyle={CHART_TOOLTIP_ITEM_STYLE}
            />
            <Scatter data={points}>
              {points.map((point) => (
                <Cell key={point.id} fill={point.color} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      )}

      {omitted > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('depthSection.omittedNoDepth', { count: omitted })}
        </p>
      )}
    </div>
  );
}
