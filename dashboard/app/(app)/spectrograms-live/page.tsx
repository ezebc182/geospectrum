/**
 * Espectrogramas sísmicos — buscador de ciudades + drag & drop, con toggle
 * Vivo/24h por tarjeta. "Vivo" (streaming SeedLink por WebSocket) solo está
 * disponible en las ciudades que src/services/seedlink_ingestor.py tiene
 * suscriptas (GET /spectrograms/live-channels); el resto muestra el
 * histórico estático de 24h (imagen FDSN vía matplotlib).
 */

'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy } from '@dnd-kit/sortable';
import { SortableSpectrogramCard } from '@/components/SortableSpectrogramCard';
import {
  HIGH_RISK_SEISMIC_CITIES,
  type SeismicCity,
  createCustomLocation,
} from '@/lib/seismic-cities';
import { searchPlace, type GeocodingResult } from '@/lib/geocoding';
import { seismicAPI } from '@/lib/api';
import { Activity, Grid3x3, Plus, Search, X, MapPin, Loader2 } from 'lucide-react';

type ViewMode = 'grid' | 'list';
type GridSize = 2 | 3 | 4 | 6;

const STORAGE_KEY = 'spectrograms.selectedCities.v1';

function loadStoredCities(): SeismicCity[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export default function SpectrogramsLivePage() {
  const t = useTranslations('charts.spectrogramsPage');
  const [selectedCities, setSelectedCities] = useState<SeismicCity[]>(
    HIGH_RISK_SEISMIC_CITIES.slice(0, 12)
  );
  const [hydrated, setHydrated] = useState(false);
  const [gridCols, setGridCols] = useState<GridSize>(3);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCitySelector, setShowCitySelector] = useState(false);
  const [liveChannelsByCity, setLiveChannelsByCity] = useState<Record<string, string>>({});

  const [placeQuery, setPlaceQuery] = useState('');
  const [placeResults, setPlaceResults] = useState<GeocodingResult[]>([]);
  const [placeSearching, setPlaceSearching] = useState(false);
  // Se guarda la CLAVE del error (no el texto) para que se re-traduzca si
  // el usuario cambia de idioma con el error visible (patrón del repo).
  const [customError, setCustomError] = useState<'alreadyAdded' | null>(null);

  // Qué ciudades tienen streaming en vivo disponible — determina en qué
  // tarjetas aparece el toggle Vivo/24h.
  useEffect(() => {
    seismicAPI
      .getLiveChannels()
      .then((channels) => {
        const map: Record<string, string> = {};
        for (const c of channels) map[c.city_id] = c.channel;
        setLiveChannelsByCity(map);
      })
      .catch(() => setLiveChannelsByCity({}));
  }, []);

  useEffect(() => {
    if (!placeQuery.trim() || placeQuery.trim().length < 3) {
      setPlaceResults([]);
      setPlaceSearching(false);
      return;
    }

    const controller = new AbortController();
    setPlaceSearching(true);
    const timer = setTimeout(() => {
      searchPlace(placeQuery, controller.signal)
        .then(setPlaceResults)
        .catch(() => setPlaceResults([]))
        .finally(() => setPlaceSearching(false));
    }, 400);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [placeQuery]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    const stored = loadStoredCities();
    if (stored && stored.length > 0) {
      setSelectedCities(stored);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedCities));
  }, [selectedCities, hydrated]);

  const availableCities = HIGH_RISK_SEISMIC_CITIES.filter(
    (city) => !selectedCities.find((c) => c.id === city.id)
  );

  const filteredCities = availableCities.filter(
    (city) =>
      city.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      city.country.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const addCity = (city: SeismicCity) => {
    setSelectedCities((prev) => [...prev, city]);
  };

  const removeCity = (cityId: string) => {
    setSelectedCities((prev) => prev.filter((c) => c.id !== cityId));
  };

  const addPlaceResult = (result: GeocodingResult) => {
    setCustomError(null);
    const parts = result.displayName.split(',').map((p) => p.trim());
    const shortName = parts[0];
    const countryName = parts[parts.length - 1];
    const location = createCustomLocation({
      name: shortName,
      country: countryName,
      lat: result.lat,
      lon: result.lon,
    });

    if (selectedCities.find((c) => c.id === location.id)) {
      setCustomError('alreadyAdded');
      return;
    }

    addCity(location);
    setPlaceQuery('');
    setPlaceResults([]);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    setSelectedCities((prev) => {
      const oldIndex = prev.findIndex((c) => c.id === active.id);
      const newIndex = prev.findIndex((c) => c.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  const gridColsClass = {
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
    6: 'grid-cols-6',
  };

  const liveCount = selectedCities.filter((c) => liveChannelsByCity[c.id]).length;

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="font-heading text-3xl font-bold text-foreground mb-2 flex items-center gap-3">
              <Activity className="h-8 w-8 text-primary" />
              {t('title')}
            </h1>
            <p className="text-muted-foreground">
              {t('subtitle', { count: selectedCities.length, live: liveCount })}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 bg-card border border-border rounded-lg p-2">
              <Grid3x3 className="h-4 w-4 text-muted-foreground" />
              <select
                value={gridCols}
                onChange={(e) => setGridCols(Number(e.target.value) as GridSize)}
                className="bg-transparent text-sm font-medium text-foreground border-none outline-none cursor-pointer"
              >
                <option value={2}>{t('columns', { count: 2 })}</option>
                <option value={3}>{t('columns', { count: 3 })}</option>
                <option value={4}>{t('columns', { count: 4 })}</option>
                <option value={6}>{t('columns', { count: 6 })}</option>
              </select>
            </div>

            <button
              onClick={() => setShowCitySelector(!showCitySelector)}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity font-semibold"
            >
              <Plus className="h-4 w-4" />
              {t('addCity')}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between bg-accent border border-border rounded-lg p-4">
          <div className="flex items-center gap-4 text-sm font-data">
            <div>
              <span className="text-accent-foreground font-semibold font-sans">{t('liveLegendLabel')}</span>
              <span className="text-muted-foreground ml-2">{t('liveLegendDescription')}</span>
            </div>
            <div className="h-4 w-px bg-border"></div>
            <div>
              <span className="text-accent-foreground font-semibold font-sans">{t('historyLegendLabel')}</span>
              <span className="text-muted-foreground ml-2">{t('historyLegendDescription')}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Selector de Ciudades */}
      {showCitySelector && (
        <div className="mb-6 bg-card border border-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-foreground flex items-center gap-2">
              <Plus className="h-5 w-5" />
              {t('addLocation')}
            </h3>
            <button
              onClick={() => setShowCitySelector(false)}
              aria-label={t('closeSelector')}
              className="p-1 hover:bg-accent rounded"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="mb-4 relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder={t('searchPlacePlaceholder')}
              value={placeQuery}
              onChange={(e) => setPlaceQuery(e.target.value)}
              className="w-full pl-10 pr-10 py-2 border border-border rounded-lg bg-background text-foreground"
            />
            {placeSearching && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
            )}

            {placeResults.length > 0 && (
              <div className="absolute z-40 mt-1 w-full bg-popover border border-border rounded-lg shadow-lg overflow-hidden">
                {placeResults.map((result, idx) => (
                  <button
                    key={idx}
                    onClick={() => addPlaceResult(result)}
                    className="w-full text-left px-3 py-2 hover:bg-accent transition-colors text-sm border-b border-border last:border-0"
                  >
                    <div className="font-medium text-popover-foreground">
                      {result.displayName.split(',')[0]}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {result.displayName}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {customError && (
              <p className="text-xs text-destructive mt-2">{t(customError)}</p>
            )}
          </div>

          <div className="pt-2 border-t border-border mt-2">
            <div className="relative my-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                placeholder={t('searchPresetPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-border rounded-lg bg-background text-foreground"
              />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 max-h-60 overflow-y-auto">
              {filteredCities.map((city) => (
                <button
                  key={city.id}
                  onClick={() => {
                    addCity(city);
                    setSearchQuery('');
                  }}
                  className="flex items-center justify-between p-3 border border-border hover:border-primary rounded-lg transition-colors text-left"
                >
                  <div>
                    <div className="font-medium text-foreground text-sm flex items-center gap-1.5">
                      {city.name}
                      {liveChannelsByCity[city.id] && (
                        <span className="text-[9px] uppercase font-bold text-severity-low">
                          {t('livePill')}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">{city.country}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Grid de Espectrogramas (arrastrable para reordenar) */}
      {selectedCities.length > 0 ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={selectedCities.map((c) => c.id)} strategy={rectSortingStrategy}>
            <div className={`grid ${gridColsClass[gridCols]} gap-4`}>
              {selectedCities.map((city) => (
                <SortableSpectrogramCard
                  key={city.id}
                  city={city}
                  liveChannel={liveChannelsByCity[city.id]}
                  onRemove={removeCity}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="flex flex-col items-center justify-center h-96 bg-card border border-dashed border-border rounded-lg">
          <Activity className="h-16 w-16 text-muted-foreground mb-4" />
          <h3 className="text-xl font-semibold text-foreground mb-2">{t('emptyTitle')}</h3>
          <p className="text-muted-foreground mb-4">{t('emptyHint')}</p>
          <button
            onClick={() => setShowCitySelector(true)}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity font-semibold"
          >
            <Plus className="h-4 w-4" />
            {t('addCities')}
          </button>
        </div>
      )}
    </div>
  );
}
