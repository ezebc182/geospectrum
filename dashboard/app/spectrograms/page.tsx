/**
 * Dashboard de Espectrogramas Sísmicos en Tiempo Real
 * Similar a PNSN: https://pnsn.org/spectrograms/spec_local
 * Muestra matriz de espectrogramas para ciudades de alto riesgo sísmico
 */

'use client';

import { useState } from 'react';
import { SpectrogramView } from '@/components/SpectrogramView';
import { SpectrogramViewReal } from '@/components/SpectrogramViewReal';
import { HIGH_RISK_SEISMIC_CITIES, type SeismicCity, getRiskColor } from '@/lib/seismic-cities';
import { Activity, Grid3x3, List, Plus, Settings, Search, X, Wifi, WifiOff } from 'lucide-react';

type ViewMode = 'grid' | 'list';
type GridSize = 2 | 3 | 4 | 6;

export default function SpectrogramsPage() {
  const [selectedCities, setSelectedCities] = useState<SeismicCity[]>(
    HIGH_RISK_SEISMIC_CITIES.slice(0, 12) // Iniciar con 12 ciudades
  );
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [gridCols, setGridCols] = useState<GridSize>(3);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCitySelector, setShowCitySelector] = useState(false);
  const [useRealData, setUseRealData] = useState(true); // Toggle para datos reales

  const availableCities = HIGH_RISK_SEISMIC_CITIES.filter(
    city => !selectedCities.find(c => c.id === city.id)
  );

  const filteredCities = availableCities.filter(city =>
    city.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    city.country.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const addCity = (city: SeismicCity) => {
    setSelectedCities(prev => [...prev, city]);
  };

  const removeCity = (cityId: string) => {
    setSelectedCities(prev => prev.filter(c => c.id !== cityId));
  };

  const gridColsClass = {
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
    6: 'grid-cols-6',
  };

  return (
    <div className="min-h-screen">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2 flex items-center gap-3">
              <Activity className="h-8 w-8 text-seismic-600" />
              Espectrogramas Sísmicos en Tiempo Real
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              Monitoreo de actividad sísmica de {selectedCities.length} ciudades de alto riesgo
            </p>
          </div>

          {/* Controles */}
          <div className="flex items-center gap-3">
            {/* Toggle Datos Reales */}
            <button
              onClick={() => setUseRealData(!useRealData)}
              className={`flex items-center gap-2 px-4 py-2 border-2 rounded-lg transition-colors font-semibold ${
                useRealData
                  ? 'bg-green-600 border-green-600 text-white hover:bg-green-700'
                  : 'bg-gray-200 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
              }`}
              title={useRealData ? 'Usando datos FDSN reales' : 'Usando datos simulados'}
            >
              {useRealData ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
              {useRealData ? 'Datos Reales' : 'Simulado'}
            </button>

            {/* Selector de Grid */}
            <div className="flex items-center gap-2 bg-white dark:bg-gray-900 border-2 border-gray-200 dark:border-gray-700 rounded-lg p-2">
              <Grid3x3 className="h-4 w-4 text-gray-600 dark:text-gray-400" />
              <select
                value={gridCols}
                onChange={(e) => setGridCols(Number(e.target.value) as GridSize)}
                className="bg-transparent text-sm font-medium text-gray-900 dark:text-white border-none outline-none cursor-pointer"
              >
                <option value={2}>2 columnas</option>
                <option value={3}>3 columnas</option>
                <option value={4}>4 columnas</option>
                <option value={6}>6 columnas</option>
              </select>
            </div>

            {/* Botón agregar ciudad */}
            <button
              onClick={() => setShowCitySelector(!showCitySelector)}
              className="flex items-center gap-2 px-4 py-2 bg-seismic-600 text-white rounded-lg hover:bg-seismic-700 transition-colors font-semibold"
            >
              <Plus className="h-4 w-4" />
              Agregar Ciudad
            </button>
          </div>
        </div>

        {/* Info Bar */}
        <div className="flex items-center justify-between bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-200 dark:border-blue-800 rounded-lg p-4">
          <div className="flex items-center gap-4 text-sm">
            <div>
              <span className="text-blue-900 dark:text-blue-100 font-semibold">
                Actualización:
              </span>
              <span className="text-blue-700 dark:text-blue-300 ml-2">
                Tiempo real (cada 2s)
              </span>
            </div>
            <div className="h-4 w-px bg-blue-300 dark:bg-blue-700"></div>
            <div>
              <span className="text-blue-900 dark:text-blue-100 font-semibold">
                Ventana:
              </span>
              <span className="text-blue-700 dark:text-blue-300 ml-2">
                Últimas 24 horas
              </span>
            </div>
            <div className="h-4 w-px bg-blue-300 dark:bg-blue-700"></div>
            <div>
              <span className="text-blue-900 dark:text-blue-100 font-semibold">
                Rango de frecuencia:
              </span>
              <span className="text-blue-700 dark:text-blue-300 ml-2">
                0.1 - 20 Hz
              </span>
            </div>
          </div>

          {/* Leyenda de colores */}
          <div className="flex items-center gap-3 text-xs">
            <span className="text-blue-900 dark:text-blue-100 font-semibold">Intensidad:</span>
            <div className="flex items-center gap-1">
              <div className="w-4 h-4 bg-blue-600"></div>
              <span className="text-blue-700 dark:text-blue-300">Baja</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-4 h-4 bg-green-500"></div>
              <span className="text-blue-700 dark:text-blue-300">Media</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-4 h-4 bg-yellow-400"></div>
              <span className="text-blue-700 dark:text-blue-300">Alta</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-4 h-4 bg-red-500"></div>
              <span className="text-blue-700 dark:text-blue-300">Muy Alta</span>
            </div>
          </div>
        </div>
      </div>

      {/* Selector de Ciudades Modal */}
      {showCitySelector && (
        <div className="mb-6 bg-white dark:bg-gray-900 border-2 border-gray-200 dark:border-gray-700 rounded-lg p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <Plus className="h-5 w-5" />
              Agregar Ciudades ({availableCities.length} disponibles)
            </h3>
            <button
              onClick={() => setShowCitySelector(false)}
              className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Búsqueda */}
          <div className="mb-4 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Buscar ciudad o país..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border-2 border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
            />
          </div>

          {/* Lista de ciudades */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 max-h-60 overflow-y-auto">
            {filteredCities.map(city => (
              <button
                key={city.id}
                onClick={() => {
                  addCity(city);
                  setSearchQuery('');
                }}
                className="flex items-center justify-between p-3 border-2 border-gray-200 dark:border-gray-700 hover:border-seismic-600 rounded-lg transition-colors text-left"
              >
                <div>
                  <div className="font-medium text-gray-900 dark:text-white text-sm">
                    {city.name}
                  </div>
                  <div className="text-xs text-gray-600 dark:text-gray-400">
                    {city.country}
                  </div>
                </div>
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: getRiskColor(city.riskLevel) }}
                  title={`Riesgo: ${city.riskLevel}`}
                />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Grid de Espectrogramas */}
      {selectedCities.length > 0 ? (
        <div className={`grid ${gridColsClass[gridCols]} gap-4`}>
          {selectedCities.map(city => (
            <div key={city.id} className="relative group">
              {useRealData ? (
                <SpectrogramViewReal city={city} height={120} showLabel={true} useRealData={true} />
              ) : (
                <SpectrogramView city={city} height={120} showLabel={true} />
              )}

              {/* Botón eliminar (visible al hover) */}
              <button
                onClick={() => removeCity(city.id)}
                className="absolute top-2 right-2 p-1 bg-red-500 text-white rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 z-30"
                title="Eliminar ciudad"
              >
                <X className="h-3 w-3" />
              </button>

              {/* Indicador de nivel de riesgo */}
              <div
                className="absolute bottom-2 right-2 px-2 py-1 rounded text-[10px] font-bold text-white z-10"
                style={{ backgroundColor: getRiskColor(city.riskLevel) }}
              >
                {city.riskLevel.toUpperCase()}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center h-96 bg-gray-50 dark:bg-gray-900 border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-lg">
          <Activity className="h-16 w-16 text-gray-400 mb-4" />
          <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
            No hay ciudades seleccionadas
          </h3>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            Agrega ciudades para comenzar a monitorear su actividad sísmica
          </p>
          <button
            onClick={() => setShowCitySelector(true)}
            className="flex items-center gap-2 px-4 py-2 bg-seismic-600 text-white rounded-lg hover:bg-seismic-700 transition-colors font-semibold"
          >
            <Plus className="h-4 w-4" />
            Agregar Ciudades
          </button>
        </div>
      )}

      {/* Footer con info */}
      <div className="mt-8 p-4 bg-gray-100 dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-700 rounded-lg">
        <h4 className="font-semibold text-gray-900 dark:text-white mb-2 flex items-center gap-2">
          {useRealData ? <Wifi className="h-4 w-4 text-green-500" /> : <WifiOff className="h-4 w-4 text-gray-500" />}
          ℹ️ Sobre los Espectrogramas
        </h4>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
          Los espectrogramas muestran la actividad sísmica en el dominio de frecuencia vs tiempo.
          El eje vertical representa la frecuencia (0.1-20 Hz) y el eje horizontal el tiempo (últimas 24 horas).
          Los colores indican la intensidad de la señal: azul (baja), verde (media), amarillo (alta), rojo (muy alta).
        </p>
        {useRealData ? (
          <div className="text-sm space-y-1">
            <p className="text-green-700 dark:text-green-300 font-semibold">
              ✅ Modo Datos Reales Activado
            </p>
            <p className="text-gray-600 dark:text-gray-400">
              Los espectrogramas se generan desde datos reales de estaciones sísmicas FDSN (Federation of Digital Seismograph Networks).
              El sistema busca automáticamente estaciones cercanas a cada ciudad y procesa las señales sísmicas mediante Transformada de Fourier (FFT).
            </p>
            <p className="text-gray-600 dark:text-gray-400">
              <strong>Fuentes:</strong> IRIS, USGS, GeoNet, y otras redes sísmicas globales.
              Los datos se actualizan cada 5 minutos.
            </p>
          </div>
        ) : (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            <strong>Modo Simulado:</strong> Usando datos sintéticos para demostración.
            Activa "Datos Reales" para conectar con estaciones sísmicas FDSN.
          </p>
        )}
      </div>
    </div>
  );
}
