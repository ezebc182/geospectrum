'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { FilterPanel, type SeismicFilters } from '@/components/FilterPanel';
import { AdvancedSeismicMap } from '@/components/AdvancedSeismicMap';
import { EventsTable } from '@/components/EventsTable';
import { seismicAPI } from '@/lib/api';
import { getActiveArea } from '@/lib/areas';
import { useAreaRefresh } from '@/lib/use-area-refresh';
import type { SeismicEvent } from '@/lib/types';
import { Search, MapPin, List, Download } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

/**
 * Estado de error de la búsqueda: se guarda el CÓDIGO (o el mensaje crudo del
 * backend, fuera de alcance por decisión del usuario) y se traduce al render —
 * un cambio de idioma re-traduce el error visible (patrón de los errores OAuth
 * del login y del panel admin).
 */
type SearchError =
  | { kind: 'noResults' }
  | { kind: 'failed'; message: string | null };

export default function ExplorePage() {
  const t = useTranslations('explore');
  const [filters, setFilters] = useState<SeismicFilters>({
    sources: ['usgs', 'emsc', 'inpres'],
    minMag: 2.5,
    maxMag: 9.0,
    minDepth: null,
    maxDepth: null,
    minLat: null,
    maxLat: null,
    minLon: null,
    maxLon: null,
    windowMinutes: 1440,
    feltOnly: false,
    reviewedOnly: false,
  });

  const [eventos, setEventos] = useState<SeismicEvent[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<SearchError | null>(null);
  const [view, setView] = useState<'map' | 'list'>('map');

  // Evento elegido desde la lista. A diferencia del Dashboard —donde mapa y
  // tabla conviven en pantalla— acá las dos vistas son excluyentes, así que
  // seleccionar sin cambiar de vista no mostraría nada: el clic en una fila
  // salta al mapa y lo centra en ese evento (ver handleRowClick).
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const handleRowClick = (id: string) => {
    setSelectedEventId(id);
    setView('map');
  };

  // Recibe los filtros por parámetro (no del closure): el cambio de área
  // busca con filtros recién calculados que el estado todavía no reflejó —
  // leer `filters` acá sería la trampa del closure viejo.
  const runSearch = async (f: SeismicFilters) => {
    setIsSearching(true);
    setError(null);

    try {
      const params = {
        sources: f.sources.join(','),
        minMag: f.minMag,
        maxMag: f.maxMag,
        minDepth: f.minDepth ?? undefined,
        maxDepth: f.maxDepth ?? undefined,
        minLat: f.minLat ?? undefined,
        maxLat: f.maxLat ?? undefined,
        minLon: f.minLon ?? undefined,
        maxLon: f.maxLon ?? undefined,
        windowMinutes: f.windowMinutes,
        feltOnly: f.feltOnly,
        reviewedOnly: f.reviewedOnly,
      };

      const results = await seismicAPI.searchEvents(params);
      setEventos(results);

      if (results.length === 0) {
        setError({ kind: 'noResults' });
      }
    } catch (err) {
      setError({ kind: 'failed', message: err instanceof Error ? err.message : null });
      console.error('Search error:', err);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSearch = () => runSearch(filters);

  // El selector de área del header también manda acá (bug 2026-08-20: cambiar
  // la región no actualizaba nada — nadie escuchaba el evento). El bbox del
  // área se vuelca a los filtros y se re-busca; volver al preset por defecto
  // (is_default) limpia el recorte. Para áreas que cruzan el antimeridiano el
  // bbox dice -180..180: filtro más ancho de la cuenta — mostrar de más es el
  // error seguro, un min/max de longitud no puede representar ese corte.
  useAreaRefresh(async () => {
    const active = await getActiveArea();
    const bbox = active && !active.is_default ? active.area.bbox : null;
    // `filters` sale de la clausura del render en que llegó el evento —
    // useAreaRefresh invoca siempre la versión fresca del handler. No se usa
    // el updater funcional de setFilters porque disparar la búsqueda adentro
    // sería un efecto colateral en una función que React exige pura.
    const next: SeismicFilters = {
      ...filters,
      minLat: bbox?.minlat ?? null,
      maxLat: bbox?.maxlat ?? null,
      minLon: bbox?.minlon ?? null,
      maxLon: bbox?.maxlon ?? null,
    };
    setFilters(next);
    await runSearch(next);
  });

  const exportToCSV = () => {
    if (eventos.length === 0) return;

    // Los encabezados y los Sí/No del CSV también son superficie user-facing
    // (mismo criterio que el fileName de ExportData en settings).
    const headers = [
      t('csv.id'),
      t('csv.dateUtc'),
      t('csv.latitude'),
      t('csv.longitude'),
      t('csv.depthKm'),
      t('csv.magnitude'),
      t('csv.magType'),
      t('csv.place'),
      t('csv.felt'),
      t('csv.reviewed'),
      t('csv.sources'),
    ];
    const rows = eventos.map(e => [
      e.id,
      e.hora_utc,
      e.lat,
      e.lon,
      e.prof_km || '',
      e.mag,
      e.mag_tipo || '',
      e.lugar || '',
      e.sentido ? t('csv.yes') : t('csv.no'),
      e.revisado ? t('csv.yes') : t('csv.no'),
      e.fuentes.join('+'),
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `seismic_events_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
  };

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-foreground mb-2">
          {t('title')}
        </h1>
        <p className="text-muted-foreground">{t('subtitle')}</p>
      </div>

      {/* Layout Principal */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Panel de Filtros (Izquierda) */}
        <div className="lg:col-span-1">
          <FilterPanel
            filters={filters}
            onFiltersChange={setFilters}
            onSearch={handleSearch}
            isSearching={isSearching}
            className="sticky top-4"
          />
        </div>

        {/* Contenido Principal (Centro y Derecha) */}
        <div className="lg:col-span-3 space-y-6">
          {/* Controles y Estadísticas */}
          <Card className="p-4">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-4">
                <div className="text-sm text-muted-foreground">
                  {/* t.rich preserva el resaltado del número sin atar la
                      traducción al orden de palabras del español. */}
                  {t.rich('resultsCount', {
                    count: eventos.length,
                    n: (chunks) => (
                      <span className="font-bold text-lg text-foreground">{chunks}</span>
                    ),
                  })}
                </div>

                {eventos.length > 0 && (
                  <div className="text-sm text-muted-foreground">
                    M{Math.min(...eventos.map(e => e.mag)).toFixed(1)} - M{Math.max(...eventos.map(e => e.mag)).toFixed(1)}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                {/* Selector de Vista */}
                <div className="flex border-2 border-border rounded-lg overflow-hidden">
                  <button
                    onClick={() => setView('map')}
                    className={`px-4 py-2 flex items-center gap-2 transition-colors ${
                      view === 'map'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-background text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    <MapPin className="h-4 w-4" />
                    {t('viewMap')}
                  </button>
                  <button
                    onClick={() => setView('list')}
                    className={`px-4 py-2 flex items-center gap-2 transition-colors border-l-2 border-border ${
                      view === 'list'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-background text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    <List className="h-4 w-4" />
                    {t('viewList')}
                  </button>
                </div>

                {/* Botón de Exportar */}
                {eventos.length > 0 && (
                  <Button onClick={exportToCSV}>
                    <Download className="h-4 w-4" />
                    {t('exportCsv')}
                  </Button>
                )}
              </div>
            </div>
          </Card>

          {/* Error Message */}
          {error && (
            <div className="border-2 border-severity-critical/30 bg-severity-critical/10 rounded-lg p-4">
              <p className="text-severity-critical">
                {error.kind === 'noResults'
                  ? t('noEventsFound')
                  : error.message ?? t('searchError')}
              </p>
            </div>
          )}

          {/* Vista de Mapa */}
          {view === 'map' && (
            <div>
              {eventos.length > 0 ? (
                <AdvancedSeismicMap
                  eventos={eventos}
                  className="h-[calc(100vh-22rem)] min-h-[420px]"
                  showCities={true}
                  selectedEventId={selectedEventId}
                />
              ) : (
                <div className="border-2 border-dashed border-border bg-muted rounded-lg p-12 text-center">
                  <Search className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-foreground mb-2">
                    {t('noResultsTitle')}
                  </h3>
                  <p className="text-muted-foreground">{t('noResultsHint')}</p>
                </div>
              )}
            </div>
          )}

          {/* Vista de Lista */}
          {view === 'list' && (
            <div>
              {eventos.length > 0 ? (
                <EventsTable
                  eventos={eventos}
                  className="h-[calc(100vh-22rem)] min-h-[420px]"
                  onRowClick={handleRowClick}
                  selectedEventId={selectedEventId}
                />
              ) : (
                <div className="border-2 border-dashed border-border bg-muted rounded-lg p-12 text-center">
                  <List className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-foreground mb-2">
                    {t('noResultsTitle')}
                  </h3>
                  <p className="text-muted-foreground">{t('noResultsHint')}</p>
                </div>
              )}
            </div>
          )}

          {/* Info sobre fuentes */}
          {eventos.length > 0 && (
            <div className="border-2 border-severity-low/30 bg-severity-low/10 rounded-lg p-4">
              <h4 className="font-semibold text-foreground mb-2">
                {t('sourcesUsed')}
              </h4>
              <div className="flex flex-wrap gap-2">
                {filters.sources.map(source => (
                  <Badge key={source} variant="secondary">
                    {source.toUpperCase()}
                  </Badge>
                ))}
              </div>
              <p className="text-sm text-muted-foreground mt-2">{t('dedupNote')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
