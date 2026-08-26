'use client';

/**
 * Miniatura de mapa para el detalle de estación: ORIENTACIÓN, no navegación.
 *
 * Deliberadamente no interactiva (sin drag/zoom/teclado): un mapa chico que
 * scrollea secuestra la rueda del mouse justo arriba del helicorder. Quien
 * quiera navegar tiene el mapa grande en /live.
 *
 * El marcador es un divIcon: el icono default de Leaflet referencia PNGs que
 * Next no sirve sin configuración extra (gotcha conocido), y un vector
 * necesita renderer SVG que jsdom no tiene — el divIcon evita ambos.
 */

import { useEffect, useRef } from 'react';
import type { Map as LeafletMap } from 'leaflet';

interface StationMiniMapProps {
  latitude: number;
  longitude: number;
}

export function StationMiniMap({ latitude, longitude }: StationMiniMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let map: LeafletMap | null = null;
    let cancelled = false;

    import('leaflet').then((L) => {
      if (cancelled || !containerRef.current) return;
      map = L.map(containerRef.current, {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false,
        touchZoom: false,
      }).setView([latitude, longitude], 5);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
      }).addTo(map);

      L.marker([latitude, longitude], {
        interactive: false,
        icon: L.divIcon({
          className: '',
          html: '<span class="block h-3 w-3 rounded-full bg-red-500 ring-2 ring-white"></span>',
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        }),
      }).addTo(map);
    });

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [latitude, longitude]);

  return (
    <>
      {/* Mismo patrón que SeismicMapWithCities/AdvancedSeismicMap: el CSS de
          Leaflet viaja con el componente que lo necesita. Next dedupe los
          <link> repetidos si conviven dos mapas. */}
      <link
        rel="stylesheet"
        href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
        integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
        crossOrigin=""
      />
      <div
        ref={containerRef}
        aria-hidden="true"
        className="h-24 w-44 shrink-0 overflow-hidden rounded-md border border-border"
      />
    </>
  );
}
