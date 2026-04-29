/**
 * Gráfica de distribución de profundidades
 */

'use client';

import { SeismicEvent } from '@/lib/types';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { getDepthColor } from '@/lib/utils';

interface DepthDistributionChartProps {
  eventos: SeismicEvent[];
  className?: string;
}

export function DepthDistributionChart({ eventos, className }: DepthDistributionChartProps) {
  // Agrupar por rangos de profundidad
  const bins = [
    { name: '<70 km', min: 0, max: 70, count: 0, color: '#ef4444' },
    { name: '70-150 km', min: 70, max: 150, count: 0, color: '#f59e0b' },
    { name: '150-300 km', min: 150, max: 300, count: 0, color: '#3b82f6' },
    { name: '>300 km', min: 300, max: Infinity, count: 0, color: '#8b5cf6' },
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
        Distribución de Profundidades
      </h3>
      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={bins} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
          <XAxis dataKey="name" stroke="#9ca3af" />
          <YAxis stroke="#9ca3af" />
          <Tooltip
            contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '8px' }}
            labelStyle={{ color: '#fff' }}
          />
          <Bar dataKey="count" name="Eventos">
            {bins.map((entry, index) => (
              <Cell key={index} fill={entry.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
