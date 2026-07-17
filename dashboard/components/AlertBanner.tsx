/**
 * Banner de alertas activas
 */

'use client';

import { Alert } from '@/lib/types';
import { getAlertIcon, getAlertSeverity, cn } from '@/lib/utils';
import { AlertTriangle, Users, Activity, CheckCircle2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface AlertBannerProps {
  alertas: Alert[];
  className?: string;
}

/** Remapeo 1:1 de severidad de alerta a tokens `--severity-*`. */
const severityStyles = {
  danger: 'border-severity-critical bg-severity-critical/10 text-foreground',
  warning: 'border-severity-moderate bg-severity-moderate/10 text-foreground',
  info: 'border-severity-low bg-severity-low/10 text-foreground',
};

const severityBadgeVariant = {
  danger: 'destructive' as const,
  warning: 'outline' as const,
  info: 'secondary' as const,
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
      <div
        className={cn(
          'rounded-lg border-2 border-severity-ok bg-severity-ok/10 p-4',
          className
        )}
      >
        <div className="flex items-center gap-3">
          <CheckCircle2 className="h-6 w-6 text-severity-ok" />
          <div>
            <p className="font-semibold text-foreground">No hay alertas activas</p>
            <p className="text-sm text-muted-foreground">
              Todos los parámetros dentro de rangos normales
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      <h3 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        Alertas Activas
        <Badge variant="destructive" className="font-data">
          {alertas.length}
        </Badge>
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
              <div className="mt-0.5">{getAlertIconComponent(alerta.tipo)}</div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-lg" aria-hidden>
                    {getAlertIcon(alerta.tipo)}
                  </span>
                  <Badge variant={severityBadgeVariant[severity]} className="uppercase tracking-wide">
                    {alerta.tipo.replace('_', ' ')}
                  </Badge>
                </div>
                <p className="mt-1 text-sm font-medium">{alerta.descripcion}</p>
                <p className="mt-1 font-data text-xs opacity-75">
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
