/**
 * Panel de filtros avanzados para búsqueda de eventos sísmicos
 * Similar a EMSC: https://www.emsc-csem.org/Earthquake_information/
 */

'use client';

import { useState } from 'react';
import { Filter, X, Search } from 'lucide-react';
import { DATA_SOURCES, type DataSourceId } from '@/lib/map-layers';

export interface SeismicFilters {
  sources: DataSourceId[];
  minMag: number;
  maxMag: number;
  minDepth: number | null;
  maxDepth: number | null;
  minLat: number | null;
  maxLat: number | null;
  minLon: number | null;
  maxLon: number | null;
  windowMinutes: number;
  feltOnly: boolean;
  reviewedOnly: boolean;
}

interface FilterPanelProps {
  filters: SeismicFilters;
  onFiltersChange: (filters: SeismicFilters) => void;
  onSearch: () => void;
  isSearching?: boolean;
  className?: string;
}

export function FilterPanel({ filters, onFiltersChange, onSearch, isSearching = false, className = '' }: FilterPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const updateFilter = <K extends keyof SeismicFilters>(key: K, value: SeismicFilters[K]) => {
    onFiltersChange({ ...filters, [key]: value });
  };

  const toggleSource = (sourceId: DataSourceId) => {
    const newSources = filters.sources.includes(sourceId)
      ? filters.sources.filter(s => s !== sourceId)
      : [...filters.sources, sourceId];
    updateFilter('sources', newSources);
  };

  const resetFilters = () => {
    onFiltersChange({
      sources: ['usgs', 'emsc'],
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
  };

  return (
    <div className={`bg-white dark:bg-gray-900 border-2 border-gray-200 dark:border-gray-700 rounded-lg shadow-lg ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b-2 border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <Filter className="h-5 w-5 text-seismic-600" />
          <h3 className="font-bold text-lg text-gray-900 dark:text-white">Filtros de Búsqueda</h3>
        </div>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
          aria-label={isExpanded ? 'Colapsar' : 'Expandir'}
        >
          {isExpanded ? <X className="h-5 w-5" /> : <Filter className="h-5 w-5" />}
        </button>
      </div>

      {isExpanded && (
        <div className="flex flex-col max-h-[calc(100vh-200px)]">
          {/* Área de Scroll - Filtros */}
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            {/* Fuentes de Datos */}
          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900 dark:text-white">
              Fuentes de Datos
            </label>
            <div className="space-y-2">
              {DATA_SOURCES.map(source => (
                <label key={source.id} className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={filters.sources.includes(source.id)}
                    onChange={() => toggleSource(source.id)}
                    className="mt-1 h-4 w-4 rounded border-gray-300 text-seismic-600 focus:ring-seismic-500"
                  />
                  <div className="flex-1">
                    <div className="font-medium text-gray-900 dark:text-white">{source.name}</div>
                    <div className="text-xs text-gray-600 dark:text-gray-400">{source.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Magnitud */}
          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900 dark:text-white">
              Magnitud
            </label>
            <div className="space-y-3">
              <div>
                <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400 mb-1">
                  <span>Mínima</span>
                  <span className="font-mono">M{filters.minMag.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="9"
                  step="0.5"
                  value={filters.minMag}
                  onChange={(e) => updateFilter('minMag', parseFloat(e.target.value))}
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700"
                />
              </div>
              <div>
                <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400 mb-1">
                  <span>Máxima</span>
                  <span className="font-mono">M{filters.maxMag.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="9"
                  step="0.5"
                  value={filters.maxMag}
                  onChange={(e) => updateFilter('maxMag', parseFloat(e.target.value))}
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700"
                />
              </div>
            </div>
          </div>

          {/* Profundidad */}
          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900 dark:text-white">
              Profundidad (km)
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-600 dark:text-gray-400">Mínima</label>
                <input
                  type="number"
                  placeholder="0"
                  value={filters.minDepth ?? ''}
                  onChange={(e) => updateFilter('minDepth', e.target.value ? parseFloat(e.target.value) : null)}
                  className="w-full px-3 py-2 border-2 border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                />
              </div>
              <div>
                <label className="text-xs text-gray-600 dark:text-gray-400">Máxima</label>
                <input
                  type="number"
                  placeholder="700"
                  value={filters.maxDepth ?? ''}
                  onChange={(e) => updateFilter('maxDepth', e.target.value ? parseFloat(e.target.value) : null)}
                  className="w-full px-3 py-2 border-2 border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                />
              </div>
            </div>
          </div>

          {/* Período de Tiempo */}
          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900 dark:text-white">
              Período de Tiempo
            </label>
            <select
              value={filters.windowMinutes}
              onChange={(e) => updateFilter('windowMinutes', parseInt(e.target.value))}
              className="w-full px-3 py-2 border-2 border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
            >
              <option value={60}>Última hora</option>
              <option value={360}>Últimas 6 horas</option>
              <option value={720}>Últimas 12 horas</option>
              <option value={1440}>Últimas 24 horas</option>
              <option value={4320}>Últimos 3 días</option>
              <option value={10080}>Última semana</option>
              <option value={43200}>Último mes</option>
            </select>
          </div>

          {/* Región Geográfica */}
          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900 dark:text-white">
              Región Geográfica
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-600 dark:text-gray-400">Lat. Min</label>
                <input
                  type="number"
                  placeholder="-90"
                  step="0.1"
                  value={filters.minLat ?? ''}
                  onChange={(e) => updateFilter('minLat', e.target.value ? parseFloat(e.target.value) : null)}
                  className="w-full px-3 py-2 border-2 border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-gray-600 dark:text-gray-400">Lat. Max</label>
                <input
                  type="number"
                  placeholder="90"
                  step="0.1"
                  value={filters.maxLat ?? ''}
                  onChange={(e) => updateFilter('maxLat', e.target.value ? parseFloat(e.target.value) : null)}
                  className="w-full px-3 py-2 border-2 border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-gray-600 dark:text-gray-400">Lon. Min</label>
                <input
                  type="number"
                  placeholder="-180"
                  step="0.1"
                  value={filters.minLon ?? ''}
                  onChange={(e) => updateFilter('minLon', e.target.value ? parseFloat(e.target.value) : null)}
                  className="w-full px-3 py-2 border-2 border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-gray-600 dark:text-gray-400">Lon. Max</label>
                <input
                  type="number"
                  placeholder="180"
                  step="0.1"
                  value={filters.maxLon ?? ''}
                  onChange={(e) => updateFilter('maxLon', e.target.value ? parseFloat(e.target.value) : null)}
                  className="w-full px-3 py-2 border-2 border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm"
                />
              </div>
            </div>
          </div>

          {/* Opciones Adicionales */}
          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900 dark:text-white">
              Opciones
            </label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.feltOnly}
                  onChange={(e) => updateFilter('feltOnly', e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-seismic-600 focus:ring-seismic-500"
                />
                <span className="text-sm text-gray-900 dark:text-white">Solo eventos sentidos</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.reviewedOnly}
                  onChange={(e) => updateFilter('reviewedOnly', e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-seismic-600 focus:ring-seismic-500"
                />
                <span className="text-sm text-gray-900 dark:text-white">Solo eventos revisados</span>
              </label>
            </div>
          </div>
          </div>

          {/* Área Fija - Botones y Avisos */}
          <div className="border-t-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
            {/* Info de fuentes seleccionadas */}
            {filters.sources.length === 0 && (
              <div className="mx-4 mt-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border-2 border-yellow-200 dark:border-yellow-800 rounded-lg">
                <p className="text-sm text-yellow-800 dark:text-yellow-200">
                  ⚠️ Selecciona al menos una fuente de datos
                </p>
              </div>
            )}

            {/* Botones de Acción */}
            <div className="flex gap-3 p-4">
              <button
                onClick={onSearch}
                disabled={isSearching || filters.sources.length === 0}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-seismic-600 text-white rounded-lg hover:bg-seismic-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-semibold transition-colors"
              >
                <Search className="h-4 w-4" />
                {isSearching ? 'Buscando...' : 'Buscar Eventos'}
              </button>
              <button
                onClick={resetFilters}
                className="px-4 py-3 border-2 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 font-semibold transition-colors"
              >
                Resetear
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
