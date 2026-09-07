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

import { toDepthSectionPoints } from '@/lib/depth-section';
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
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis
              type="number"
              dataKey="mag"
              name={t('bValue.magnitudeAxis')}
              stroke="#9ca3af"
              tick={{ fontSize: 12 }}
            />
            {/* `reversed`: la profundidad crece hacia abajo. */}
            <YAxis
              type="number"
              dataKey="depthKm"
              name={t('depthSection.depthAxis')}
              reversed
              stroke="#9ca3af"
              tick={{ fontSize: 12 }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1f2937',
                border: '1px solid #374151',
                borderRadius: '0.5rem',
                color: '#f9fafb',
              }}
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
