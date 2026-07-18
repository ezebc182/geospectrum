'use client';

import { useState } from 'react';
import { FilterPanel, type SeismicFilters } from '@/components/FilterPanel';
import { AdvancedSeismicMap } from '@/components/AdvancedSeismicMap';
import { EventsTable } from '@/components/EventsTable';
import { seismicAPI } from '@/lib/api';
import type { SeismicEvent } from '@/lib/types';
import { Search, MapPin, List, Download } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export default function ExplorePage() {
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
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'map' | 'list'>('map');

  const handleSearch = async () => {
    setIsSearching(true);
    setError(null);

    try {
      const params = {
        sources: filters.sources.join(','),
        minMag: filters.minMag,
        maxMag: filters.maxMag,
        minDepth: filters.minDepth ?? undefined,
        maxDepth: filters.maxDepth ?? undefined,
        minLat: filters.minLat ?? undefined,
        maxLat: filters.maxLat ?? undefined,
        minLon: filters.minLon ?? undefined,
        maxLon: filters.maxLon ?? undefined,
        windowMinutes: filters.windowMinutes,
        feltOnly: filters.feltOnly,
        reviewedOnly: filters.reviewedOnly,
      };

      const results = await seismicAPI.searchEvents(params);
      setEventos(results);

      if (results.length === 0) {
        setError('No se encontraron eventos con los filtros especificados');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al buscar eventos');
      console.error('Search error:', err);
    } finally {
      setIsSearching(false);
    }
  };

  const exportToCSV = () => {
    if (eventos.length === 0) return;

    const headers = ['ID', 'Fecha (UTC)', 'Latitud', 'Longitud', 'Profundidad (km)', 'Magnitud', 'Tipo Mag', 'Lugar', 'Sentido', 'Revisado', 'Fuentes'];
    const rows = eventos.map(e => [
      e.id,
      e.hora_utc,
      e.lat,
      e.lon,
      e.prof_km || '',
      e.mag,
      e.mag_tipo || '',
      e.lugar || '',
      e.sentido ? 'Sí' : 'No',
      e.revisado ? 'Sí' : 'No',
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
          Explorador de Eventos Sísmicos
        </h1>
        <p className="text-muted-foreground">
          Búsqueda avanzada con múltiples fuentes de datos y filtros personalizados
        </p>
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
                <div className="text-sm">
                  <span className="text-muted-foreground">Resultados: </span>
                  <span className="font-bold text-lg text-foreground">{eventos.length}</span>
                  <span className="text-muted-foreground"> eventos</span>
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
                    Mapa
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
                    Lista
                  </button>
                </div>

                {/* Botón de Exportar */}
                {eventos.length > 0 && (
                  <Button onClick={exportToCSV}>
                    <Download className="h-4 w-4" />
                    Exportar CSV
                  </Button>
                )}
              </div>
            </div>
          </Card>

          {/* Error Message */}
          {error && (
            <div className="border-2 border-severity-critical/30 bg-severity-critical/10 rounded-lg p-4">
              <p className="text-severity-critical">{error}</p>
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
                />
              ) : (
                <div className="border-2 border-dashed border-border bg-muted rounded-lg p-12 text-center">
                  <Search className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-foreground mb-2">
                    No hay resultados
                  </h3>
                  <p className="text-muted-foreground">
                    Ajusta los filtros y haz clic en "Buscar Eventos" para ver resultados
                  </p>
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
                />
              ) : (
                <div className="border-2 border-dashed border-border bg-muted rounded-lg p-12 text-center">
                  <List className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-foreground mb-2">
                    No hay resultados
                  </h3>
                  <p className="text-muted-foreground">
                    Ajusta los filtros y haz clic en "Buscar Eventos" para ver resultados
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Info sobre fuentes */}
          {eventos.length > 0 && (
            <div className="border-2 border-severity-low/30 bg-severity-low/10 rounded-lg p-4">
              <h4 className="font-semibold text-foreground mb-2">
                Fuentes de Datos Utilizadas
              </h4>
              <div className="flex flex-wrap gap-2">
                {filters.sources.map(source => (
                  <Badge key={source} variant="secondary">
                    {source.toUpperCase()}
                  </Badge>
                ))}
              </div>
              <p className="text-sm text-muted-foreground mt-2">
                Los eventos pueden estar deduplicados si aparecen en múltiples fuentes
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
