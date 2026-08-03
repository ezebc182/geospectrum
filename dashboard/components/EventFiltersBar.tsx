/**
 * Barra de filtros de la tabla de eventos.
 *
 * Es un componente controlado: no guarda estado propio, lo recibe y avisa los
 * cambios. Así cada página decide dónde vive el filtro y puede resetearlo (por
 * ejemplo, al cambiar de área de interés).
 *
 * El rango de fechas se acota al de los eventos cargados a propósito. Hoy
 * /report devuelve una ventana de horas y NO existe todavía la tabla histórica:
 * un calendario abierto haría creer que se puede pedir el mes pasado y
 * devolvería siempre vacío.
 */

'use client';

import { Search, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  EMPTY_FILTERS,
  TIME_PERIODS,
  hasActiveFilters,
  type EventFilters,
} from '@/lib/event-filters';
import { cn } from '@/lib/utils';

interface EventFiltersBarProps {
  filters: EventFilters;
  onChange: (filters: EventFilters) => void;
  /** Fuentes disponibles en los eventos cargados (USGS, EMSC…). */
  sources: string[];
  /** Rango de fechas cubierto por los eventos cargados, si hay alguno. */
  dateRange: { min: string; max: string } | null;
  /** Cuántos eventos quedaron tras filtrar, sobre el total. */
  matched: number;
  total: number;
  className?: string;
}

export function EventFiltersBar({
  filters,
  onChange,
  sources,
  dateRange,
  matched,
  total,
  className,
}: EventFiltersBarProps) {
  const isFiltered = hasActiveFilters(filters);

  const update = (patch: Partial<EventFilters>) => {
    onChange({ ...filters, ...patch });
  };

  // Un input de número vacío tiene que volver a "sin límite", no a 0: un 0
  // literal filtraría de verdad y escondería los eventos de magnitud negativa.
  const parseMagnitude = (value: string): number | null => {
    if (value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  };

  const toggleSource = (source: string) => {
    const next = filters.sources.includes(source)
      ? filters.sources.filter((item) => item !== source)
      : [...filters.sources, source];
    update({ sources: next });
  };

  return (
    <div
      className={cn(
        'space-y-3 rounded-lg border-2 border-border bg-muted/30 p-3',
        className
      )}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-1">
          <label
            htmlFor="event-filter-query"
            className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Buscar por zona
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="event-filter-query"
              type="search"
              value={filters.query}
              onChange={(event) => update({ query: event.target.value })}
              placeholder="Chile, Antofagasta, Japón…"
              className="pl-8"
            />
          </div>
        </div>

        <div>
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Magnitud
          </span>
          <div className="flex items-center gap-1">
            <Input
              aria-label="Magnitud mínima"
              type="number"
              inputMode="decimal"
              step="0.1"
              value={filters.minMagnitude ?? ''}
              onChange={(event) =>
                update({ minMagnitude: parseMagnitude(event.target.value) })
              }
              placeholder="mín"
              className="w-20 font-data"
            />
            <span className="text-muted-foreground">–</span>
            <Input
              aria-label="Magnitud máxima"
              type="number"
              inputMode="decimal"
              step="0.1"
              value={filters.maxMagnitude ?? ''}
              onChange={(event) =>
                update({ maxMagnitude: parseMagnitude(event.target.value) })
              }
              placeholder="máx"
              className="w-20 font-data"
            />
          </div>
        </div>

        <div>
          <span
            id="event-filter-period"
            className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Período
          </span>
          {/* Botones de período en vez de un calendario: /report trae una
              ventana de horas, así que un `<input type="date">` quedaba con
              casi todos los días deshabilitados y parecía roto. */}
          <div role="group" aria-labelledby="event-filter-period" className="flex flex-wrap gap-1">
            {TIME_PERIODS.map(({ value, label }) => {
              const isOn = filters.period === value;
              return (
                <Button
                  key={value}
                  type="button"
                  variant={isOn ? 'default' : 'outline'}
                  size="sm"
                  aria-pressed={isOn}
                  onClick={() => update({ period: value })}
                >
                  {label}
                </Button>
              );
            })}
          </div>
        </div>

        {isFiltered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="gap-1"
          >
            <X className="h-4 w-4" />
            Limpiar
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {sources.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Fuente
            </span>
            {sources.map((source) => {
              const isOn = filters.sources.includes(source);
              return (
                <button
                  key={source}
                  type="button"
                  onClick={() => toggleSource(source)}
                  aria-pressed={isOn}
                  className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Badge
                    variant={isOn ? 'default' : 'secondary'}
                    className={cn('cursor-pointer font-data', !isOn && 'opacity-60')}
                  >
                    {source}
                  </Badge>
                </button>
              );
            })}
          </div>
        )}

        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={filters.onlyFelt}
            onChange={(event) => update({ onlyFelt: event.target.checked })}
            className="h-4 w-4 cursor-pointer accent-seismic-600"
          />
          Sólo sentidos
        </label>

        {/* `aria-live` para que un lector de pantalla anuncie el resultado: sin
            esto, quien no ve la tabla no se entera de que el filtro hizo algo. */}
        <span
          aria-live="polite"
          className="ml-auto text-sm text-muted-foreground"
        >
          {isFiltered ? (
            <>
              <span className="font-data font-semibold text-foreground">{matched}</span>
              {' de '}
              <span className="font-data">{total}</span> eventos
            </>
          ) : (
            <>
              <span className="font-data">{total}</span> eventos
            </>
          )}
        </span>
      </div>

      {isFiltered && matched === 0 && (
        <p className="text-sm text-severity-moderate">
          Ningún evento coincide con los filtros.
          {dateRange && (
            <>
              {' '}El reporte en vivo cubre del{' '}
              <span className="font-data">{dateRange.min}</span> al{' '}
              <span className="font-data">{dateRange.max}</span>.
            </>
          )}
        </p>
      )}
    </div>
  );
}
