/**
 * Tabla de eventos sísmicos
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { SeismicEvent } from '@/lib/types';
import {
  formatDateTimeCompact,
  formatMagnitude,
  formatDepth,
  getMagnitudeColor,
  cn,
} from '@/lib/utils';
import {
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  MapPin,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
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
  /**
   * Invocado con los eventos que sobreviven al filtro, para que el padre pueda
   * mostrar lo mismo en otras vistas (el mapa del Dashboard). Sin esto el
   * filtro sólo afectaba a la tabla y los marcadores seguían mostrando todo.
   * Default: undefined.
   */
  onFilteredEventsChange?: (eventos: SeismicEvent[]) => void;
  /**
   * Parte la lista en páginas con controles de navegación. Default: false,
   * para no cambiarles el aspecto a los usos que ya existían.
   *
   * Excluyente con `limit` en la práctica: `limit` recorta a los N primeros
   * sin forma de ver el resto (el asomo del dashboard), y esto recorre todo.
   * Si se pasan los dos, gana la paginación.
   */
  paginated?: boolean;
  /** Filas por página cuando `paginated`. Default: 50. */
  pageSize?: number;
}

/** Columnas opcionales: Tiempo/Magnitud/Ubicación son siempre visibles (lo
 * mínimo para identificar un sismo), estas dos se agregan a gusto. */
type OptionalColumn = 'fuente' | 'estado';

/** Sólo los ids: el label sale del diccionario dentro del componente
 * (Decision 5 — las constantes de módulo no llaman a t()). */
const OPTIONAL_COLUMNS: { id: OptionalColumn; labelKey: 'sourceLabel' | 'statusLabel' }[] = [
  { id: 'fuente', labelKey: 'sourceLabel' },
  { id: 'estado', labelKey: 'statusLabel' },
];

const VISIBLE_COLUMNS_STORAGE_KEY = 'events-table.visible-optional-columns.v1';

function loadVisibleColumns(): Set<OptionalColumn> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(VISIBLE_COLUMNS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    // localStorage corrupto o inaccesible (modo privado, cuota, etc.): se
    // degrada a "sin columnas opcionales" en vez de romper la tabla entera.
    return new Set();
  }
}

export function EventsTable({
  eventos,
  limit,
  className,
  onRowClick,
  selectedEventId,
  filterable = false,
  onFilteredEventsChange,
  paginated = false,
  pageSize = 50,
}: EventsTableProps) {
  const t = useTranslations('events');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);

  // Al cambiar de área los filtros se limpian: un "Chile" tecleado antes de
  // elegir Japón dejaría la tabla vacía y parecería que la app se rompió,
  // cuando lo que sobrevive es un filtro que ya no aplica.
  useAreaRefresh(() => {
    setFilters(EMPTY_FILTERS);
    setPage(1);
  });

  // Volver a la página 1 cuando cambian los filtros: quedarse en la 8 con un
  // filtro que dejó 20 resultados muestra una tabla vacía y parece que el
  // filtro no encontró nada. El clamp de `currentPage` cubre el render, pero
  // sin esto el estado `page` queda desfasado y "Siguiente" salta raro.
  const handleFiltersChange = (next: typeof filters) => {
    setFilters(next);
    setPage(1);
  };

  // Arranca vacío (sin columnas opcionales) y se hidrata en un efecto, no en
  // el useState inicial: leer localStorage durante el render de SSR daría un
  // resultado distinto al del cliente y React tiraría un warning de
  // hydration mismatch.
  const [visibleColumns, setVisibleColumns] = useState<Set<OptionalColumn>>(() => new Set());
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);

  useEffect(() => {
    setVisibleColumns(loadVisibleColumns());
  }, []);

  const toggleColumn = (column: OptionalColumn) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      window.localStorage.setItem(VISIBLE_COLUMNS_STORAGE_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  // Se filtra ANTES de recortar por `limit`: al revés, el dashboard buscaría
  // solamente entre los 10 eventos visibles y el filtro parecería no encontrar
  // nada que existe más abajo en la lista.
  const filteredEvents = useMemo(
    () => (filterable ? filterEvents(eventos, filters) : eventos),
    [filterable, eventos, filters]
  );

  // La callback se guarda en un ref para que el efecto dependa sólo de
  // `filteredEvents`: si dependiera de la función, un padre que la define
  // inline (lo normal) haría correr el efecto en cada render.
  const onFilteredEventsChangeRef = useRef(onFilteredEventsChange);
  useEffect(() => {
    onFilteredEventsChangeRef.current = onFilteredEventsChange;
  }, [onFilteredEventsChange]);

  useEffect(() => {
    onFilteredEventsChangeRef.current?.(filteredEvents);
  }, [filteredEvents]);

  const sources = useMemo(
    () => (filterable ? availableSources(eventos) : []),
    [filterable, eventos]
  );
  const dateRange = useMemo(
    () => (filterable ? dateRangeOf(eventos) : null),
    [filterable, eventos]
  );

  const isFiltered = filterable && hasActiveFilters(filters);

  // Paginación (pedido del usuario 2026-08-22): /analytics no pasa `limit` y
  // renderizaba TODAS las filas del reporte en un solo .map() — con 600+
  // eventos la página se arrastraba y no había forma de recorrerla.
  //
  // Convive con `limit` en vez de reemplazarlo: son dos necesidades
  // distintas. `limit` es "asomate a los 10 más recientes" (el dashboard, con
  // el mapa al lado); la paginación es "recorré todo el catálogo".
  const totalPages = paginated
    ? Math.max(1, Math.ceil(filteredEvents.length / pageSize))
    : 1;
  // El clamp evita quedar en una página que ya no existe: al filtrar estando
  // en la página 8, `filteredEvents` puede caer a 20 filas y sin esto la
  // tabla se veía vacía con el filtro puesto.
  const currentPage = Math.min(page, totalPages);

  const displayEvents = paginated
    ? filteredEvents.slice((currentPage - 1) * pageSize, currentPage * pageSize)
    : limit
      ? filteredEvents.slice(0, limit)
      : filteredEvents;

  const columnsToggle = (
    <div className="relative flex justify-end">
      <button
        type="button"
        onClick={() => setColumnsMenuOpen((open) => !open)}
        aria-expanded={columnsMenuOpen}
        aria-label={t('columns.choose')}
        className="flex items-center gap-1.5 rounded-md border-2 border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        {t('columns.button')}
      </button>

      {columnsMenuOpen && (
        <>
          {/* Capa invisible para cerrar al clickear afuera, sin depender de
              un dropdown compartido: el menú es sólo un puñado de checkboxes,
              no vale la pena el overhead de Radix para esto. */}
          <div className="fixed inset-0 z-10" onClick={() => setColumnsMenuOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border-2 border-border bg-popover p-2 shadow-lg">
            <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('columns.optional')}
            </p>
            {OPTIONAL_COLUMNS.map(({ id, labelKey }) => (
              <label
                key={id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/60"
              >
                <input
                  type="checkbox"
                  checked={visibleColumns.has(id)}
                  onChange={() => toggleColumn(id)}
                  className="h-4 w-4 cursor-pointer accent-primary"
                />
                {t(`columns.${labelKey}`)}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );

  const filtersBar = filterable ? (
    <>
      <EventFiltersBar
        filters={filters}
        onChange={handleFiltersChange}
        sources={sources}
        dateRange={dateRange}
        matched={filteredEvents.length}
        total={eventos.length}
      />
      {columnsToggle}
    </>
  ) : (
    columnsToggle
  );

  if (displayEvents.length === 0) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        {filtersBar}
        {/* Sin filtros el vacío significa "no hay datos"; con filtros significa
            "no hay coincidencias", y la barra ya lo explica arriba. */}
        {!isFiltered && (
          <div className="rounded-lg border-2 border-border bg-muted/40 p-8 text-center">
            <p className="text-muted-foreground">{t('emptyWindow')}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {filtersBar}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border-2 border-border">
      {/* Lista estilo USGS (magnitud grande a la izquierda, ubicación como
          título, fecha+profundidad chicas debajo) en vez de tabla de
          columnas: con 6 columnas fijas la tabla no entraba en pantallas
          angostas sin scroll horizontal. Fuente/Estado quedan como iconos
          chicos opcionales (ver columnsToggle), no columnas propias. */}
      {/* El rótulo de zona va UNA vez acá y no en cada fila: repetir "UTC" en
          una lista de cientos de eventos es ruido, pero sin él las horas de
          las filas se leen como locales. */}
      <div className="shrink-0 border-b-2 border-border bg-muted/40 px-4 py-1.5 text-right font-data text-[10px] uppercase tracking-wider text-muted-foreground">
        {t('timesInUtc')}
      </div>
      <div className="min-h-0 flex-1 divide-y divide-border overflow-auto bg-card">
        {displayEvents.map((evento) => {
          const isSelected = evento.id === selectedEventId;
          return (
            <div
              key={evento.id}
              role="row"
              onClick={onRowClick ? () => onRowClick(evento.id) : undefined}
              data-state={isSelected ? 'selected' : undefined}
              className={cn(
                'flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50',
                onRowClick && 'cursor-pointer',
                isSelected && 'bg-severity-low/10 ring-1 ring-inset ring-severity-low'
              )}
            >
              <span
                className="w-14 shrink-0 font-data text-2xl font-bold"
                style={{ color: getMagnitudeColor(evento.mag) }}
              >
                {formatMagnitude(evento.mag)}
              </span>

              <div className="min-w-0 flex-1">
                <p
                  className="truncate font-semibold text-foreground"
                  title={evento.lugar || t('unknownPlace')}
                >
                  {evento.lugar || t('unknownPlace')}
                </p>
                <p className="font-data text-xs text-muted-foreground">
                  {formatDateTimeCompact(evento.hora_utc)}
                  {' · '}
                  {formatDepth(evento.prof_km)}
                </p>

                {(visibleColumns.has('fuente') || visibleColumns.has('estado')) && (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {visibleColumns.has('fuente') &&
                      evento.fuentes.map((fuente) => (
                        <span
                          key={fuente}
                          className="rounded bg-muted px-1.5 py-0.5 font-data text-[10px] text-muted-foreground"
                        >
                          {fuente}
                        </span>
                      ))}
                    {visibleColumns.has('estado') && (
                      <span className="flex items-center gap-1.5">
                        {evento.revisado && (
                          <span title={t('reviewed')}>
                            <CheckCircle className="h-3.5 w-3.5 text-severity-ok" />
                          </span>
                        )}
                        {evento.sentido && (
                          <span title={t('felt')}>
                            <Users className="h-3.5 w-3.5 text-severity-moderate" />
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {isSelected && (
                <span title={t('selectedOnMap')} className="shrink-0">
                  <MapPin className="h-4 w-4 text-severity-low" />
                </span>
              )}
            </div>
          );
        })}
      </div>
        {/* El total del pie es el de los eventos FILTRADOS: decir "10 de 224"
            cuando el filtro dejó 12 sería mentir sobre lo que hay para ver. */}
        {limit && !paginated && filteredEvents.length > limit && (
          <div className="border-t-2 border-border bg-muted/40 px-4 py-3 text-center text-sm text-muted-foreground">
            {/* Dos claves en vez de concatenar " filtrados": en inglés el
                adjetivo va antes del sustantivo, no al final de la frase. */}
            {isFiltered
              ? t('showingFiltered', { shown: limit, total: filteredEvents.length })
              : t('showing', { shown: limit, total: filteredEvents.length })}
          </div>
        )}

        {/* Navegación entre páginas. Se muestra incluso con una sola página
            (con los botones deshabilitados) porque el contador "X-Y de Z" es
            información útil por sí solo: sin él la lista no dice cuánto hay. */}
        {paginated && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t-2 border-border bg-muted/40 px-4 py-2">
            <span className="font-data text-xs text-muted-foreground">
              {t('pagination.range', {
                from: filteredEvents.length === 0 ? 0 : (currentPage - 1) * pageSize + 1,
                to: Math.min(currentPage * pageSize, filteredEvents.length),
                total: filteredEvents.length,
              })}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                aria-label={t('pagination.previous')}
                className="rounded-md border-2 border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="px-2 font-data text-xs text-muted-foreground">
                {t('pagination.page', { current: currentPage, total: totalPages })}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
                aria-label={t('pagination.next')}
                className="rounded-md border-2 border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
