/**
 * Tabla de eventos sísmicos
 */

'use client';

import { useMemo, useState } from 'react';

import { SeismicEvent } from '@/lib/types';
import { formatDateTime, formatMagnitude, formatDepth, getMagnitudeSeverity, cn } from '@/lib/utils';
import { CheckCircle, Clock, MapPin, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EventFiltersBar } from '@/components/EventFiltersBar';
import {
  EMPTY_FILTERS,
  availableSources,
  dateRangeOf,
  filterEvents,
  hasActiveFilters,
} from '@/lib/event-filters';
import { useAreaRefresh } from '@/lib/use-area-refresh';

interface EventsTableProps {
  eventos: SeismicEvent[];
  limit?: number;
  className?: string;
  /** Invocado con el id del evento al hacer click en su fila (sincronización tabla→mapa). Default: undefined. */
  onRowClick?: (id: string) => void;
  /** Id del evento actualmente seleccionado (resalta la fila correspondiente). Default: undefined. */
  selectedEventId?: string | null;
  /**
   * Muestra la barra de búsqueda y filtros sobre la tabla. Default: false, para
   * no cambiar el aspecto de los usos que no la pidieron.
   */
  filterable?: boolean;
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

export function EventsTable({
  eventos,
  limit,
  className,
  onRowClick,
  selectedEventId,
  filterable = false,
}: EventsTableProps) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);

  // Al cambiar de área los filtros se limpian: un "Chile" tecleado antes de
  // elegir Japón dejaría la tabla vacía y parecería que la app se rompió,
  // cuando lo que sobrevive es un filtro que ya no aplica.
  useAreaRefresh(() => setFilters(EMPTY_FILTERS));

  // Se filtra ANTES de recortar por `limit`: al revés, el dashboard buscaría
  // solamente entre los 10 eventos visibles y el filtro parecería no encontrar
  // nada que existe más abajo en la lista.
  const filteredEvents = useMemo(
    () => (filterable ? filterEvents(eventos, filters) : eventos),
    [filterable, eventos, filters]
  );

  const sources = useMemo(
    () => (filterable ? availableSources(eventos) : []),
    [filterable, eventos]
  );
  const dateRange = useMemo(
    () => (filterable ? dateRangeOf(eventos) : null),
    [filterable, eventos]
  );

  const displayEvents = limit ? filteredEvents.slice(0, limit) : filteredEvents;
  const isFiltered = filterable && hasActiveFilters(filters);

  const filtersBar = filterable ? (
    <EventFiltersBar
      filters={filters}
      onChange={setFilters}
      sources={sources}
      dateRange={dateRange}
      matched={filteredEvents.length}
      total={eventos.length}
    />
  ) : null;

  if (displayEvents.length === 0) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        {filtersBar}
        {/* Sin filtros el vacío significa "no hay datos"; con filtros significa
            "no hay coincidencias", y la barra ya lo explica arriba. */}
        {!isFiltered && (
          <div className="rounded-lg border-2 border-border bg-muted/40 p-8 text-center">
            <p className="text-muted-foreground">
              No hay eventos registrados en la ventana de tiempo actual
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {filtersBar}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border-2 border-border">
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
        {/* El total del pie es el de los eventos FILTRADOS: decir "10 de 224"
            cuando el filtro dejó 12 sería mentir sobre lo que hay para ver. */}
        {limit && filteredEvents.length > limit && (
          <div className="border-t-2 border-border bg-muted/40 px-4 py-3 text-center text-sm text-muted-foreground">
            Mostrando {limit} de {filteredEvents.length} eventos
            {isFiltered && ' filtrados'}
          </div>
        )}
      </div>
    </div>
  );
}
