/**
 * Tabla de eventos sísmicos
 */

'use client';

import { SeismicEvent } from '@/lib/types';
import { formatDateTime, formatMagnitude, formatDepth, getMagnitudeSeverity, cn } from '@/lib/utils';
import { CheckCircle, Clock, MapPin, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface EventsTableProps {
  eventos: SeismicEvent[];
  limit?: number;
  className?: string;
  /** Invocado con el id del evento al hacer click en su fila (sincronización tabla→mapa). Default: undefined. */
  onRowClick?: (id: string) => void;
  /** Id del evento actualmente seleccionado (resalta la fila correspondiente). Default: undefined. */
  selectedEventId?: string | null;
}

const magnitudeBadgeVariant = {
  low: 'secondary' as const,
  moderate: 'outline' as const,
  high: 'outline' as const,
  critical: 'destructive' as const,
};

const magnitudeBadgeClass = {
  low: 'bg-severity-low/15 text-severity-low',
  moderate: 'bg-severity-moderate/15 text-severity-moderate',
  high: 'bg-severity-high/15 text-severity-high',
  critical: 'bg-severity-critical/15 text-severity-critical',
};

export function EventsTable({ eventos, limit, className, onRowClick, selectedEventId }: EventsTableProps) {
  const displayEvents = limit ? eventos.slice(0, limit) : eventos;

  if (displayEvents.length === 0) {
    return (
      <div className={cn('rounded-lg border-2 border-border bg-muted/40 p-8 text-center', className)}>
        <p className="text-muted-foreground">
          No hay eventos registrados en la ventana de tiempo actual
        </p>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-lg border-2 border-border', className)}>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Tiempo
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Magnitud
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Profundidad
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Ubicación
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Fuente
              </th>
              <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Estado
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-card">
            {displayEvents.map((evento) => {
              const severity = getMagnitudeSeverity(evento.mag);
              const isSelected = evento.id === selectedEventId;
              return (
                <tr
                  key={evento.id}
                  onClick={onRowClick ? () => onRowClick(evento.id) : undefined}
                  data-state={isSelected ? 'selected' : undefined}
                  className={cn(
                    'transition-colors hover:bg-muted/50',
                    onRowClick && 'cursor-pointer',
                    isSelected && 'bg-severity-low/10 ring-1 ring-inset ring-severity-low'
                  )}
                >
                  <td className="whitespace-nowrap px-4 py-3 font-data text-sm text-foreground">
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      {formatDateTime(evento.hora_utc)}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <Badge
                      variant={magnitudeBadgeVariant[severity]}
                      className={cn('font-data font-bold', magnitudeBadgeClass[severity])}
                    >
                      M{formatMagnitude(evento.mag)}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-data text-sm text-muted-foreground">
                    {formatDepth(evento.prof_km)}
                  </td>
                  <td className="px-4 py-3 text-sm text-foreground">
                    <div className="max-w-md truncate" title={evento.lugar || 'Desconocido'}>
                      {evento.lugar || 'Desconocido'}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    <div className="flex flex-wrap gap-1">
                      {evento.fuentes.map((fuente) => (
                        <Badge key={fuente} variant="secondary" className="font-data">
                          {fuente}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-center">
                    <div className="flex items-center justify-center gap-2">
                      {isSelected && (
                        <span title="Seleccionado en el mapa">
                          <MapPin className="h-4 w-4 text-severity-low" />
                        </span>
                      )}
                      {evento.revisado && (
                        <span title="Revisado">
                          <CheckCircle className="h-4 w-4 text-severity-ok" />
                        </span>
                      )}
                      {evento.sentido && (
                        <span title="Sentido">
                          <Users className="h-4 w-4 text-severity-moderate" />
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {limit && eventos.length > limit && (
        <div className="border-t-2 border-border bg-muted/40 px-4 py-3 text-center text-sm text-muted-foreground">
          Mostrando {limit} de {eventos.length} eventos
        </div>
      )}
    </div>
  );
}
