/**
 * Mapa sísmico avanzado con capas múltiples y overlays geológicos
 * Similar a EMSC y USGS con selector de capas base y overlays
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import type { SeismicEvent } from '@/lib/types';
import { getMagnitudeColor, formatMagnitude, formatDateTime } from '@/lib/utils';
import { BASE_LAYERS, GEOLOGICAL_OVERLAYS, type DataSourceId } from '@/lib/map-layers';
import { Layers, Eye, EyeOff } from 'lucide-react';

interface AdvancedSeismicMapProps {
  eventos: SeismicEvent[];
  className?: string;
  showCities?: boolean;
  defaultLayer?: keyof typeof BASE_LAYERS;
}

const MAJOR_CITIES = [
  { name: 'Buenos Aires', lat: -34.6037, lon: -58.3816, population: 15000000 },
  { name: 'Santiago', lat: -33.4489, lon: -70.6693, population: 7000000 },
  { name: 'Lima', lat: -12.0464, lon: -77.0428, population: 10000000 },
  { name: 'Bogotá', lat: 4.7110, lon: -74.0721, population: 10000000 },
  { name: 'Caracas', lat: 10.4806, lon: -66.9036, population: 3000000 },
  { name: 'Quito', lat: -0.1807, lon: -78.4678, population: 2800000 },
  { name: 'La Paz', lat: -16.5000, lon: -68.1500, population: 2300000 },
  { name: 'Asunción', lat: -25.2637, lon: -57.5759, population: 2500000 },
  { name: 'Montevideo', lat: -34.9011, lon: -56.1645, population: 1900000 },
];

export function AdvancedSeismicMap({ eventos, className = '', showCities = true, defaultLayer = 'terrain' }: AdvancedSeismicMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMapRef = useRef<any>(null);
  const layersRef = useRef<any>({});
  const overlaysRef = useRef<any>({});

  const [currentLayer, setCurrentLayer] = useState<keyof typeof BASE_LAYERS>(defaultLayer);
  const [activeOverlays, setActiveOverlays] = useState<string[]>([]);
  const [showLayerControl, setShowLayerControl] = useState(false);

  // Inicializar mapa
  useEffect(() => {
    if (typeof window !== 'undefined' && mapRef.current && !leafletMapRef.current) {
      import('leaflet').then((L) => {
        // Limpiar cualquier instancia previa
        if (leafletMapRef.current) {
          leafletMapRef.current.remove();
          leafletMapRef.current = null;
        }

        // Verificar que el contenedor no tenga un mapa ya
        const container = mapRef.current;
        if (!container) return;

        // Limpiar el _leaflet_id si existe
        if ((container as any)._leaflet_id) {
          delete (container as any)._leaflet_id;
        }

        const map = L.map(container).setView([-30, -65], 4);

        // Crear todas las capas base
        Object.entries(BASE_LAYERS).forEach(([key, layer]) => {
          layersRef.current[key] = L.tileLayer(layer.url, {
            attribution: layer.attribution,
            maxZoom: layer.maxZoom || 18,
          });
        });

        // Agregar capa por defecto
        layersRef.current[currentLayer].addTo(map);

        // Crear overlays geológicos
        Object.entries(GEOLOGICAL_OVERLAYS).forEach(([key, overlay]) => {
          overlaysRef.current[key] = L.tileLayer(overlay.url, {
            opacity: 0.6,
          });
        });

        // Agregar ciudades si está habilitado
        if (showCities) {
          const cityLayerGroup = L.layerGroup();

          MAJOR_CITIES.forEach((city) => {
            const size = city.population > 5000000 ? 8 : city.population > 2000000 ? 6 : 5;

            L.circleMarker([city.lat, city.lon], {
              radius: size,
              fillColor: '#000000',
              color: '#ffffff',
              weight: 2,
              opacity: 1,
              fillOpacity: 0.8,
            })
              .bindPopup(`
                <div class="text-sm">
                  <p class="font-bold">${city.name}</p>
                  <p class="text-xs">Población: ${(city.population / 1000000).toFixed(1)}M</p>
                </div>
              `)
              .addTo(cityLayerGroup);

            const icon = L.divIcon({
              className: 'city-label',
              html: `<div style="
                background-color: rgba(0, 0, 0, 0.7);
                color: white;
                padding: 2px 6px;
                border-radius: 3px;
                font-size: ${size > 6 ? '11px' : '9px'};
                font-weight: ${size > 6 ? 'bold' : 'normal'};
                white-space: nowrap;
                pointer-events: none;
              ">${city.name}</div>`,
              iconSize: [0, 0],
              iconAnchor: [-size - 5, 0],
            });

            L.marker([city.lat, city.lon], { icon, interactive: false }).addTo(cityLayerGroup);
          });

          cityLayerGroup.addTo(map);
        }

        leafletMapRef.current = map;
      });
    }

    return () => {
      if (leafletMapRef.current) {
        leafletMapRef.current.remove();
        leafletMapRef.current = null;
      }
    };
  }, [showCities, currentLayer]);

  // Actualizar capa base cuando cambia
  useEffect(() => {
    if (leafletMapRef.current && layersRef.current[currentLayer]) {
      // Remover todas las capas base
      Object.values(layersRef.current).forEach((layer: any) => {
        try {
          if (leafletMapRef.current.hasLayer(layer)) {
            leafletMapRef.current.removeLayer(layer);
          }
        } catch (e) {
          console.error('Error removing layer:', e);
        }
      });

      // Agregar nueva capa
      try {
        layersRef.current[currentLayer].addTo(leafletMapRef.current);
      } catch (e) {
        console.error('Error adding layer:', e);
      }
    }
  }, [currentLayer]);

  // Actualizar overlays
  useEffect(() => {
    if (leafletMapRef.current) {
      // Primero remover todos los overlays
      Object.entries(overlaysRef.current).forEach(([key, layer]: [string, any]) => {
        if (leafletMapRef.current.hasLayer(layer)) {
          leafletMapRef.current.removeLayer(layer);
        }
      });

      // Agregar overlays activos
      activeOverlays.forEach((key) => {
        if (overlaysRef.current[key]) {
          overlaysRef.current[key].addTo(leafletMapRef.current);
        }
      });
    }
  }, [activeOverlays]);

  // Actualizar eventos sísmicos
  useEffect(() => {
    if (leafletMapRef.current && typeof window !== 'undefined') {
      import('leaflet').then((L) => {
        // Remover marcadores de eventos previos
        leafletMapRef.current.eachLayer((layer: any) => {
          if (layer instanceof L.CircleMarker && layer.options.fillColor !== '#000000') {
            leafletMapRef.current.removeLayer(layer);
          }
        });

        // Agregar nuevos eventos
        eventos.forEach((evento) => {
          const color = getMagnitudeColor(evento.mag);
          const radius = Math.max(4, Math.min(evento.mag * 4, 30));

          // Determinar icono de fuente
          const sourceIcon = evento.fuentes.includes('EMSC') ? '🇪🇺' :
                           evento.fuentes.includes('INPRES') ? '🇦🇷' :
                           '🇺🇸';

          L.circleMarker([evento.lat, evento.lon], {
            radius,
            fillColor: color,
            color: '#ffffff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.6,
          })
            .bindPopup(`
              <div class="text-sm">
                <p class="font-bold text-lg">M${formatMagnitude(evento.mag)} ${sourceIcon}</p>
                <p class="font-medium">${evento.lugar || 'Ubicación desconocida'}</p>
                <p class="text-xs text-gray-600 mt-1">${formatDateTime(evento.hora_utc)}</p>
                <p class="text-xs">Profundidad: ${evento.prof_km ? `${evento.prof_km.toFixed(1)} km` : 'N/A'}</p>
                <p class="text-xs">Coordenadas: ${evento.lat.toFixed(3)}°, ${evento.lon.toFixed(3)}°</p>
                <p class="text-xs mt-1">
                  ${evento.sentido ? '👥 Sentido' : ''}
                  ${evento.revisado ? ' ✓ Revisado' : ' ~ Preliminar'}
                </p>
                <p class="text-xs font-mono mt-1">Fuente: ${evento.fuentes.join(', ').toUpperCase()}</p>
              </div>
            `)
            .addTo(leafletMapRef.current);
        });
      });
    }
  }, [eventos]);

  const toggleOverlay = (overlayKey: string) => {
    setActiveOverlays(prev =>
      prev.includes(overlayKey)
        ? prev.filter(k => k !== overlayKey)
        : [...prev, overlayKey]
    );
  };

  return (
    <div className={`relative ${className}`}>
      <div
        ref={mapRef}
        className="h-full w-full rounded-lg border-2 border-gray-300 dark:border-gray-700 shadow-lg"
        style={{ minHeight: '600px' }}
      />

      <link
        rel="stylesheet"
        href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
        integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
        crossOrigin=""
      />

      {/* Control de Capas */}
      <div className="absolute top-4 right-4 z-[1000]">
        <button
          onClick={() => setShowLayerControl(!showLayerControl)}
          className="p-3 bg-white dark:bg-gray-900 border-2 border-gray-300 dark:border-gray-700 rounded-lg shadow-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          title="Capas del mapa"
        >
          <Layers className="h-5 w-5 text-gray-700 dark:text-gray-300" />
        </button>

        {showLayerControl && (
          <div className="absolute top-14 right-0 w-72 bg-white dark:bg-gray-900 border-2 border-gray-300 dark:border-gray-700 rounded-lg shadow-xl p-4">
            {/* Capas Base */}
            <div className="mb-4">
              <h4 className="font-bold text-sm mb-2 text-gray-900 dark:text-white">Capa Base</h4>
              <div className="space-y-1">
                {Object.entries(BASE_LAYERS).map(([key, layer]) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded">
                    <input
                      type="radio"
                      name="baseLayer"
                      checked={currentLayer === key}
                      onChange={() => setCurrentLayer(key as keyof typeof BASE_LAYERS)}
                      className="h-4 w-4"
                    />
                    <span className="text-sm text-gray-900 dark:text-white">{layer.name}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Overlays Geológicos */}
            <div className="border-t-2 border-gray-200 dark:border-gray-700 pt-4">
              <h4 className="font-bold text-sm mb-2 text-gray-900 dark:text-white">Overlays Geológicos</h4>
              <div className="space-y-1">
                {Object.entries(GEOLOGICAL_OVERLAYS).map(([key, overlay]) => (
                  <label key={key} className="flex items-start gap-2 cursor-pointer p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded">
                    <input
                      type="checkbox"
                      checked={activeOverlays.includes(key)}
                      onChange={() => toggleOverlay(key)}
                      className="mt-0.5 h-4 w-4"
                    />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-gray-900 dark:text-white">{overlay.name}</div>
                      <div className="text-xs text-gray-600 dark:text-gray-400">{overlay.description}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Leyenda */}
      <div className="absolute bottom-4 left-4 z-[1000] bg-white/90 dark:bg-gray-900/90 border-2 border-gray-300 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <div className="flex flex-wrap gap-3 text-xs">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-green-500 border-2 border-white"></div>
            <span className="text-gray-900 dark:text-white">M &lt; 4.0</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded-full bg-yellow-500 border-2 border-white"></div>
            <span className="text-gray-900 dark:text-white">M 4.0-5.0</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-orange-500 border-2 border-white"></div>
            <span className="text-gray-900 dark:text-white">M 5.0-6.0</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-red-500 border-2 border-white"></div>
            <span className="text-gray-900 dark:text-white">M &gt; 6.0</span>
          </div>
        </div>
      </div>
    </div>
  );
}
