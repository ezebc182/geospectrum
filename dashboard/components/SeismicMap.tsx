/**
 * Mapa interactivo con epicentros sísmicos
 * Usa Leaflet para visualización geoespacial
 */

'use client';

import { useEffect, useRef } from 'react';
import type { SeismicEvent } from '@/lib/types';
import { getMagnitudeColor, formatMagnitude, formatDateTime } from '@/lib/utils';

interface SeismicMapProps {
  eventos: SeismicEvent[];
  region: { minlat: number; maxlat: number; minlon: number; maxlon: number };
  className?: string;
}

export function SeismicMap({ eventos, region, className }: SeismicMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMapRef = useRef<any>(null);

  useEffect(() => {
    // Dynamic import de Leaflet (solo client-side)
    if (typeof window !== 'undefined' && mapRef.current && !leafletMapRef.current) {
      import('leaflet').then((L) => {
        // Inicializar mapa
        const map = L.map(mapRef.current!).setView(
          [(region.minlat + region.maxlat) / 2, (region.minlon + region.maxlon) / 2],
          6
        );

        // Tile layer
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenStreetMap contributors',
        }).addTo(map);

        // Bounding box
        const bounds = L.latLngBounds(
          [region.minlat, region.minlon],
          [region.maxlat, region.maxlon]
        );
        L.rectangle(bounds, {
          color: '#3b82f6',
          weight: 2,
          fillOpacity: 0.1,
        }).addTo(map);

        leafletMapRef.current = map;
      });
    }

    return () => {
      if (leafletMapRef.current) {
        leafletMapRef.current.remove();
        leafletMapRef.current = null;
      }
    };
  }, [region]);

  useEffect(() => {
    if (leafletMapRef.current && typeof window !== 'undefined') {
      import('leaflet').then((L) => {
        const map = leafletMapRef.current;

        // Limpiar marcadores previos
        map.eachLayer((layer: any) => {
          if (layer instanceof L.CircleMarker) {
            map.removeLayer(layer);
          }
        });

        // Agregar marcadores para cada evento
        eventos.forEach((evento) => {
          const color = getMagnitudeColor(evento.mag);
          const radius = Math.max(5, evento.mag * 3);

          L.circleMarker([evento.lat, evento.lon], {
            radius,
            fillColor: color,
            color: '#fff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.7,
          })
            .bindPopup(`
              <div class="text-sm">
                <p class="font-bold">M${formatMagnitude(evento.mag)}</p>
                <p>${evento.lugar || 'Desconocido'}</p>
                <p class="text-xs text-gray-600">${formatDateTime(evento.hora_utc)}</p>
                <p class="text-xs">Prof: ${evento.prof_km ? `${evento.prof_km.toFixed(0)} km` : 'N/A'}</p>
                <p class="text-xs">Fuente: ${evento.fuentes.join(', ')}</p>
              </div>
            `)
            .addTo(map);
        });
      });
    }
  }, [eventos]);

  return (
    <div className={className}>
      <div
        ref={mapRef}
        className="h-full w-full rounded-lg border-2 border-gray-200 dark:border-gray-700"
        style={{ minHeight: '400px' }}
      />
      <link
        rel="stylesheet"
        href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
        integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
        crossOrigin=""
      />
    </div>
  );
}
