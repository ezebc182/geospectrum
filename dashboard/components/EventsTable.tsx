/**
 * Tabla de eventos sísmicos
 */

'use client';

import { SeismicEvent } from '@/lib/types';
import { formatDateTime, formatMagnitude, formatDepth, getMagnitudeColor, cn } from '@/lib/utils';
import { CheckCircle, Clock, Users } from 'lucide-react';

interface EventsTableProps {
  eventos: SeismicEvent[];
  limit?: number;
  className?: string;
}

export function EventsTable({ eventos, limit, className }: EventsTableProps) {
  const displayEvents = limit ? eventos.slice(0, limit) : eventos;

  if (displayEvents.length === 0) {
    return (
      <div className={cn('rounded-lg border-2 border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-8 text-center', className)}>
        <p className="text-gray-500 dark:text-gray-400">
          No hay eventos registrados en la ventana de tiempo actual
        </p>
      </div>
    );
  }

  return (
    <div className={cn('overflow-hidden rounded-lg border-2 border-gray-200 dark:border-gray-700', className)}>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-100 dark:bg-gray-800">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300">
                Tiempo
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300">
                Magnitud
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300">
                Profundidad
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300">
                Ubicación
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300">
                Fuente
              </th>
              <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300">
                Estado
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-900">
            {displayEvents.map((evento) => (
              <tr
                key={evento.id}
                className="hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-gray-400" />
                    {formatDateTime(evento.hora_utc)}
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <span
                    className="inline-flex items-center rounded-full px-3 py-1 text-sm font-bold text-white"
                    style={{ backgroundColor: getMagnitudeColor(evento.mag) }}
                  >
                    M{formatMagnitude(evento.mag)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                  {formatDepth(evento.prof_km)}
                </td>
                <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                  <div className="max-w-md truncate" title={evento.lugar || 'Desconocido'}>
                    {evento.lugar || 'Desconocido'}
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-sm">
                  <div className="flex flex-wrap gap-1">
                    {evento.fuentes.map((fuente) => (
                      <span
                        key={fuente}
                        className="inline-flex items-center rounded-full bg-blue-100 dark:bg-blue-900 px-2 py-0.5 text-xs font-medium text-blue-800 dark:text-blue-200"
                      >
                        {fuente}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-center">
                  <div className="flex items-center justify-center gap-2">
                    {evento.revisado && (
                      <span title="Revisado">
                        <CheckCircle className="h-4 w-4 text-green-500" />
                      </span>
                    )}
                    {evento.sentido && (
                      <span title="Sentido">
                        <Users className="h-4 w-4 text-orange-500" />
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {limit && eventos.length > limit && (
        <div className="border-t-2 border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-4 py-3 text-center text-sm text-gray-600 dark:text-gray-400">
          Mostrando {limit} de {eventos.length} eventos
        </div>
      )}
    </div>
  );
}
