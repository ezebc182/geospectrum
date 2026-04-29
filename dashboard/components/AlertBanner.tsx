/**
 * Banner de alertas activas
 */

'use client';

import { Alert } from '@/lib/types';
import { getAlertIcon, getAlertSeverity, cn } from '@/lib/utils';
import { AlertTriangle, Users, Activity } from 'lucide-react';

interface AlertBannerProps {
  alertas: Alert[];
  className?: string;
}

const severityStyles = {
  danger: 'bg-red-100 dark:bg-red-950 border-red-500 text-red-900 dark:text-red-100',
  warning: 'bg-yellow-100 dark:bg-yellow-950 border-yellow-500 text-yellow-900 dark:text-yellow-100',
  info: 'bg-blue-100 dark:bg-blue-950 border-blue-500 text-blue-900 dark:text-blue-100',
};

function getAlertIconComponent(tipo: string) {
  switch (tipo) {
    case 'evento_significativo':
      return <AlertTriangle className="h-5 w-5" />;
    case 'enjambre':
      return <Activity className="h-5 w-5" />;
    case 'actividad_sentida':
      return <Users className="h-5 w-5" />;
    default:
      return null;
  }
}

export function AlertBanner({ alertas, className }: AlertBannerProps) {
  if (alertas.length === 0) {
    return (
      <div className={cn('rounded-lg border-2 border-green-200 bg-green-50 dark:bg-green-950 p-4', className)}>
        <div className="flex items-center gap-3">
          <span className="text-2xl">✅</span>
          <div>
            <p className="font-semibold text-green-900 dark:text-green-100">
              No hay alertas activas
            </p>
            <p className="text-sm text-green-700 dark:text-green-300">
              Todos los parámetros dentro de rangos normales
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
        🚨 Alertas Activas ({alertas.length})
      </h3>
      {alertas.map((alerta, idx) => {
        const severity = getAlertSeverity(alerta.tipo);
        return (
          <div
            key={idx}
            className={cn(
              'rounded-lg border-l-4 p-4 animate-pulse-slow',
              severityStyles[severity]
            )}
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5">
                {getAlertIconComponent(alerta.tipo)}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{getAlertIcon(alerta.tipo)}</span>
                  <p className="font-semibold uppercase tracking-wide">
                    {alerta.tipo.replace('_', ' ')}
                  </p>
                </div>
                <p className="mt-1 text-sm font-medium">
                  {alerta.descripcion}
                </p>
                <p className="mt-1 text-xs opacity-75">
                  {alerta.eventos_relacionados.length} evento(s) relacionado(s)
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
