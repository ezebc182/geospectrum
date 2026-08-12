/**
 * Panel de filtros avanzados para búsqueda de eventos sísmicos
 * Similar a EMSC: https://www.emsc-csem.org/Earthquake_information/
 */

'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Filter, X, Search } from 'lucide-react';
import { DATA_SOURCES, type DataSourceId } from '@/lib/map-layers';
import { cn } from '@/lib/utils';

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
  const t = useTranslations('filters');
  // Las descripciones de DATA_SOURCES viven en el ns `map` (Decision 5:
  // lib/map-layers.ts es lib pura y exporta ids; el componente traduce).
  const tMap = useTranslations('map');
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
  };

  return (
    <div className={cn('rounded-lg border-2 border-border bg-card shadow-lg', className)}>
      {/* Header */}
      <div className="flex items-center justify-between border-b-2 border-border p-4">
        <div className="flex items-center gap-2">
          <Filter className="h-5 w-5 text-primary" />
          <h3 className="font-bold text-lg text-foreground">{t('title')}</h3>
        </div>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="rounded p-1 hover:bg-muted"
          aria-label={isExpanded ? t('collapse') : t('expand')}
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
            <label className="mb-2 block text-sm font-semibold text-foreground">
              {t('dataSources')}
            </label>
            <div className="space-y-2">
              {DATA_SOURCES.map(source => (
                <label key={source.id} className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={filters.sources.includes(source.id)}
                    onChange={() => toggleSource(source.id)}
                    className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                  />
                  <div className="flex-1">
                    <div className="font-medium text-foreground">{source.name}</div>
                    <div className="text-xs text-muted-foreground">{tMap(`sources.${source.id}`)}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Magnitud */}
          <div>
            <label className="mb-2 block text-sm font-semibold text-foreground">
              {t('magnitude')}
            </label>
            <div className="space-y-3">
              <div>
                <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                  <span>{t('min')}</span>
                  <span className="font-mono">M{filters.minMag.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="9"
                  step="0.5"
                  value={filters.minMag}
                  onChange={(e) => updateFilter('minMag', parseFloat(e.target.value))}
                  className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-muted"
                />
              </div>
              <div>
                <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                  <span>{t('max')}</span>
                  <span className="font-mono">M{filters.maxMag.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="9"
                  step="0.5"
                  value={filters.maxMag}
                  onChange={(e) => updateFilter('maxMag', parseFloat(e.target.value))}
                  className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-muted"
                />
              </div>
            </div>
          </div>

          {/* Profundidad */}
          <div>
            <label className="mb-2 block text-sm font-semibold text-foreground">
              {t('depthKm')}
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">{t('min')}</label>
                <input
                  type="number"
                  placeholder="0"
                  value={filters.minDepth ?? ''}
                  onChange={(e) => updateFilter('minDepth', e.target.value ? parseFloat(e.target.value) : null)}
                  className="w-full rounded-lg border-2 border-border bg-card px-3 py-2 text-foreground"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{t('max')}</label>
                <input
                  type="number"
                  placeholder="700"
                  value={filters.maxDepth ?? ''}
                  onChange={(e) => updateFilter('maxDepth', e.target.value ? parseFloat(e.target.value) : null)}
                  className="w-full rounded-lg border-2 border-border bg-card px-3 py-2 text-foreground"
                />
              </div>
            </div>
          </div>

          {/* Período de Tiempo */}
          <div>
            <label className="mb-2 block text-sm font-semibold text-foreground">
              {t('timePeriod')}
            </label>
            <select
              value={filters.windowMinutes}
              onChange={(e) => updateFilter('windowMinutes', parseInt(e.target.value))}
              className="w-full rounded-lg border-2 border-border bg-card px-3 py-2 text-foreground"
            >
              <option value={60}>{t('windows.hour1')}</option>
              <option value={360}>{t('windows.hours6')}</option>
              <option value={720}>{t('windows.hours12')}</option>
              <option value={1440}>{t('windows.hours24')}</option>
              <option value={4320}>{t('windows.days3')}</option>
              <option value={10080}>{t('windows.week1')}</option>
              <option value={43200}>{t('windows.month1')}</option>
            </select>
          </div>

          {/* Región Geográfica */}
          <div>
            <label className="mb-2 block text-sm font-semibold text-foreground">
              {t('geoRegion')}
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">{t('latMin')}</label>
                <input
                  type="number"
                  placeholder="-90"
                  step="0.1"
                  value={filters.minLat ?? ''}
                  onChange={(e) => updateFilter('minLat', e.target.value ? parseFloat(e.target.value) : null)}
                  className="w-full rounded-lg border-2 border-border bg-card px-3 py-2 text-sm text-foreground"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{t('latMax')}</label>
                <input
                  type="number"
                  placeholder="90"
                  step="0.1"
                  value={filters.maxLat ?? ''}
                  onChange={(e) => updateFilter('maxLat', e.target.value ? parseFloat(e.target.value) : null)}
                  className="w-full rounded-lg border-2 border-border bg-card px-3 py-2 text-sm text-foreground"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{t('lonMin')}</label>
                <input
                  type="number"
                  placeholder="-180"
                  step="0.1"
                  value={filters.minLon ?? ''}
                  onChange={(e) => updateFilter('minLon', e.target.value ? parseFloat(e.target.value) : null)}
                  className="w-full rounded-lg border-2 border-border bg-card px-3 py-2 text-sm text-foreground"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{t('lonMax')}</label>
                <input
                  type="number"
                  placeholder="180"
                  step="0.1"
                  value={filters.maxLon ?? ''}
                  onChange={(e) => updateFilter('maxLon', e.target.value ? parseFloat(e.target.value) : null)}
                  className="w-full rounded-lg border-2 border-border bg-card px-3 py-2 text-sm text-foreground"
                />
              </div>
            </div>
          </div>

          {/* Opciones Adicionales */}
          <div>
            <label className="mb-2 block text-sm font-semibold text-foreground">
              {t('options')}
            </label>
            <div className="space-y-2">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={filters.feltOnly}
                  onChange={(e) => updateFilter('feltOnly', e.target.checked)}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                <span className="text-sm text-foreground">{t('feltOnly')}</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={filters.reviewedOnly}
                  onChange={(e) => updateFilter('reviewedOnly', e.target.checked)}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                <span className="text-sm text-foreground">{t('reviewedOnly')}</span>
              </label>
            </div>
          </div>
          </div>

          {/* Área Fija - Botones y Avisos */}
          <div className="border-t-2 border-border bg-card">
            {/* Info de fuentes seleccionadas */}
            {filters.sources.length === 0 && (
              <div className="mx-4 mt-4 rounded-lg border-2 border-severity-moderate/30 bg-severity-moderate/10 p-3">
                <p className="text-sm text-foreground">{t('selectSource')}</p>
              </div>
            )}

            {/* Botones de Acción */}
            <div className="flex gap-3 p-4">
              <button
                onClick={onSearch}
                disabled={isSearching || filters.sources.length === 0}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
              >
                <Search className="h-4 w-4" />
                {isSearching ? t('searching') : t('searchEvents')}
              </button>
              <button
                onClick={resetFilters}
                className="rounded-lg border-2 border-border px-4 py-3 font-semibold text-foreground transition-colors hover:bg-muted"
              >
                {t('reset')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
