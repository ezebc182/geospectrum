/**
 * Mapa interactivo profesional con ciudades y eventos sísmicos
 * Similar a visualizaciones de USGS con ciudades principales
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import type { AreaGeometry, SeismicEvent } from '@/lib/types';
import { getMagnitudeColor, formatMagnitude } from '@/lib/utils';
import { areaGeometryWithWorldCopies } from '@/lib/area-geometry';
import { areaViewBounds } from '@/lib/area-view-bounds';

interface SeismicMapProps {
  eventos: SeismicEvent[];
  region: { minlat: number; maxlat: number; minlon: number; maxlon: number };
  /**
   * Geometría real del área de interés activa (AOI-1). Cuando viene, se dibuja
   * el polígono; si no, se cae al rectángulo del bbox.
   *
   * El fallback NO es decorativo: un área cóncava como el anillo de fuego tiene
   * un bbox que cubre casi todo el planeta, así que el rectángulo miente sobre
   * lo que se está monitoreando. Se conserva sólo para el caso en que el área
   * todavía no cargó.
   */
  areaGeometry?: AreaGeometry | null;
  className?: string;
}

// Ciudades principales de la región sísmica de Sudamérica
const MAJOR_CITIES = [
  // Argentina
  { name: 'Buenos Aires', lat: -34.6037, lon: -58.3816, population: 15000000, country: 'Argentina' },
  { name: 'Córdoba', lat: -31.4201, lon: -64.1888, population: 1500000, country: 'Argentina' },
  { name: 'Rosario', lat: -32.9468, lon: -60.6393, population: 1300000, country: 'Argentina' },
  { name: 'Mendoza', lat: -32.8895, lon: -68.8458, population: 1100000, country: 'Argentina' },
  { name: 'San Juan', lat: -31.5375, lon: -68.5364, population: 500000, country: 'Argentina' },
  { name: 'San Miguel de Tucumán', lat: -26.8083, lon: -65.2176, population: 900000, country: 'Argentina' },
  { name: 'Salta', lat: -24.7859, lon: -65.4117, population: 600000, country: 'Argentina' },
  { name: 'Mar del Plata', lat: -38.0055, lon: -57.5426, population: 650000, country: 'Argentina' },
  { name: 'Neuquén', lat: -38.9516, lon: -68.0591, population: 350000, country: 'Argentina' },

  // Chile
  { name: 'Santiago', lat: -33.4489, lon: -70.6693, population: 7000000, country: 'Chile' },
  { name: 'Valparaíso', lat: -33.0472, lon: -71.6127, population: 900000, country: 'Chile' },
  { name: 'Concepción', lat: -36.8201, lon: -73.0444, population: 730000, country: 'Chile' },
  { name: 'Antofagasta', lat: -23.6509, lon: -70.3975, population: 400000, country: 'Chile' },
  { name: 'Temuco', lat: -38.7359, lon: -72.5904, population: 300000, country: 'Chile' },
  { name: 'Iquique', lat: -20.2307, lon: -70.1355, population: 200000, country: 'Chile' },
  { name: 'Valdivia', lat: -39.8142, lon: -73.2459, population: 170000, country: 'Chile' },
  { name: 'Coquimbo', lat: -29.9533, lon: -71.3436, population: 200000, country: 'Chile' },

  // Perú
  { name: 'Lima', lat: -12.0464, lon: -77.0428, population: 10000000, country: 'Perú' },
  { name: 'Arequipa', lat: -16.4090, lon: -71.5375, population: 1000000, country: 'Perú' },
  { name: 'Cusco', lat: -13.5319, lon: -71.9675, population: 430000, country: 'Perú' },
  { name: 'Trujillo', lat: -8.1116, lon: -79.0288, population: 920000, country: 'Perú' },

  // Bolivia
  { name: 'La Paz', lat: -16.5000, lon: -68.1500, population: 2300000, country: 'Bolivia' },
  { name: 'Santa Cruz', lat: -17.8146, lon: -63.1561, population: 1900000, country: 'Bolivia' },
  { name: 'Cochabamba', lat: -17.3895, lon: -66.1568, population: 1200000, country: 'Bolivia' },

  // Paraguay
  { name: 'Asunción', lat: -25.2637, lon: -57.5759, population: 2500000, country: 'Paraguay' },

  // Uruguay
  { name: 'Montevideo', lat: -34.9011, lon: -56.1645, population: 1900000, country: 'Uruguay' },
];

export function SeismicMapWithCities({ eventos, region, areaGeometry, className }: SeismicMapProps) {
  const t = useTranslations('map');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const format = useFormatter();

  // Labels de los popups de Leaflet, traducidas ANTES de armar el HTML y
  // memoizadas POR VALOR: los efectos que construyen markers/popups dependen
  // de este objeto (y de `locale`) para regenerarse al cambiar de idioma.
  // Trampa documentada del proyecto: un efecto que lee un ref sin tenerlo en
  // deps corre una vez y nunca más — nada traducible viaja por ref acá.
  const popupLabels = useMemo(
    () => ({
      population: t('popup.population'),
      unknownLocation: t('popup.unknownLocation'),
      depth: t('popup.depth'),
      coordinates: t('popup.coordinates'),
      feltEvent: t('popup.feltEvent'),
      reviewed: t('popup.reviewed'),
      preliminary: t('popup.preliminary'),
      source: t('popup.source'),
      notAvailable: tCommon('notAvailable'),
      utcSuffix: tCommon('utcSuffix'),
    }),
    [t, tCommon],
  );

  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMapRef = useRef<any>(null);
  const cityLayerGroupRef = useRef<any>(null);
  const eventLayerGroupRef = useRef<any>(null);
  const areaLayerGroupRef = useRef<any>(null);
  const drawAreaRef = useRef<(() => void) | null>(null);
  // Capas base + control de capas de Leaflet: el control pinta labels
  // traducidos ("Terreno"/"Terrain"), así que se guarda para poder
  // reconstruirlo al cambiar de idioma sin recrear el mapa.
  const baseLayersRef = useRef<{ terrain: any; streets: any; satellite: any } | null>(null);
  const layersControlRef = useRef<any>(null);
  // La instancia del mapa vive TAMBIÉN en estado, no solo en el ref: un ref
  // no dispara re-render, así que los efectos de ciudades y control de capas
  // (que deben correr cuando el mapa queda listo Y cuando cambia el idioma)
  // dependen de este estado.
  const [mapInstance, setMapInstance] = useState<any>(null);

  // La geometría se lee desde un ref adentro del handler de `moveend`, que se
  // registra UNA sola vez al crear el mapa: si leyera la prop directamente,
  // capturaría el valor del primer render y seguiría dibujando el área vieja
  // para siempre. El efecto de abajo se encarga de redibujar cuando cambia.
  const areaGeometryRef = useRef<AreaGeometry | null | undefined>(areaGeometry);
  areaGeometryRef.current = areaGeometry;

  // Redibujar al cambiar el área. `drawAreaRef` NO alcanza como única
  // dependencia —un ref no dispara renders—, por eso el efecto depende de
  // `areaGeometry`: es el cambio de la prop lo que tiene que provocar el
  // redibujo. Sin esto el mapa se quedaría con el rectángulo del fallback
  // hasta el próximo paneo.
  useEffect(() => {
    drawAreaRef.current?.();
  }, [areaGeometry]);

  // Reencuadrar al cambiar el área.
  //
  // El efecto que crea el mapa ya depende de `region`, pero tiene un guard
  // `!leafletMapRef.current`: con el mapa ya creado sale por el guard sin hacer
  // nada, así que el encuadre se quedaba clavado en el área con la que se montó
  // la página. Sacar el guard no es opción —recrearía el mapa entero—, por eso
  // el reencuadre va acá.
  //
  // El encuadre sale de la geometría y no del bbox: las áreas que cruzan el
  // antimeridiano declaran un bbox de -180..180 que encuadraría el planeta
  // entero (ver lib/area-view-bounds.ts).
  //
  // Se serializa a string para las deps porque `areaViewBounds` devuelve un
  // array nuevo en cada render y SWR devuelve un `region` nuevo en cada
  // revalidación: dependiendo del objeto, el mapa se reencuadraría cada 30s
  // pisándole el zoom al usuario.
  const viewBoundsKey = JSON.stringify(areaViewBounds(areaGeometry, region));

  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map || viewBoundsKey === 'null') return;

    map.fitBounds(JSON.parse(viewBoundsKey));
  }, [viewBoundsKey]);

  useEffect(() => {
    // Dynamic import de Leaflet (solo client-side)
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

        // Inicializar mapa
        const map = L.map(container).setView(
          [(region.minlat + region.maxlat) / 2, (region.minlon + region.maxlon) / 2],
          5
        );

        // Tile layers con controles
        const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenStreetMap contributors',
        });

        const terrain = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenTopoMap contributors',
        });

        const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
          attribution: '© Esri',
        });

        // Default: terrain para mejor visualización sísmica
        terrain.addTo(map);

        // El control de capas se monta en su propio efecto (labels traducidos
        // que deben reconstruirse al cambiar de idioma); acá solo se publican
        // las capas base.
        baseLayersRef.current = { terrain, streets, satellite };

        // Región monitoreada: el polígono real del área si está disponible,
        // el rectángulo del bbox como fallback mientras carga. El área se
        // redibuja en cada moveend porque las capas vectoriales de Leaflet
        // sólo existen en -180..180 y desaparecen al panear (ver
        // lib/area-geometry.ts).
        const AREA_STYLE = {
          color: '#ef4444',
          weight: 2,
          fillOpacity: 0.05,
          dashArray: '5, 5',
        };

        const areaLayerGroup = L.layerGroup().addTo(map);
        areaLayerGroupRef.current = areaLayerGroup;

        const drawArea = () => {
          areaLayerGroup.clearLayers();
          const geometry = areaGeometryRef.current;

          if (!geometry) {
            L.rectangle(
              L.latLngBounds(
                [region.minlat, region.minlon],
                [region.maxlat, region.maxlon]
              ),
              AREA_STYLE
            ).addTo(areaLayerGroup);
            return;
          }

          const viewport = map.getBounds();
          L.geoJSON(
            areaGeometryWithWorldCopies(
              geometry,
              viewport.getWest(),
              viewport.getEast()
            ) as any,
            { style: AREA_STYLE, interactive: false }
          ).addTo(areaLayerGroup);
        };

        drawAreaRef.current = drawArea;
        drawArea();
        map.on('moveend', drawArea);

        // Layer groups para organizar marcadores. Las ciudades se agregan en
        // su propio efecto: sus popups son HTML strings traducidos que deben
        // regenerarse al cambiar de idioma sin destruir el mapa.
        cityLayerGroupRef.current = L.layerGroup().addTo(map);
        eventLayerGroupRef.current = L.layerGroup().addTo(map);

        leafletMapRef.current = map;
        // Publica la instancia como estado para despertar a los efectos que
        // dependen de que el mapa exista (ciudades, control de capas).
        setMapInstance(map);
      });
    }

    return () => {
      if (leafletMapRef.current) {
        leafletMapRef.current.remove();
        leafletMapRef.current = null;
        setMapInstance(null);
      }
    };
  }, [region]);

  // Control de capas: labels traducidos, así que se reconstruye al cambiar de
  // idioma (el control viejo se remueve y se agrega uno nuevo con los textos
  // del idioma activo). Depende de `mapInstance` (estado) porque tiene que
  // correr también cuando el mapa recién queda listo.
  useEffect(() => {
    if (!mapInstance || !baseLayersRef.current) return;

    let cancelled = false;

    import('leaflet').then((L) => {
      if (cancelled || !leafletMapRef.current || !baseLayersRef.current) return;

      const { terrain, streets, satellite } = baseLayersRef.current;
      layersControlRef.current = L.control
        .layers({
          [t('baseLayers.terrain')]: terrain,
          [t('baseLayers.street')]: streets,
          [t('baseLayers.satellite')]: satellite,
        })
        .addTo(mapInstance);
    });

    return () => {
      cancelled = true;
      if (layersControlRef.current && leafletMapRef.current) {
        layersControlRef.current.remove();
      }
      layersControlRef.current = null;
    };
  }, [mapInstance, t, locale]);

  // Ciudades: efecto separado de la creación del mapa, con las labels
  // traducidas POR VALOR en las deps para regenerar los popups al cambiar de
  // idioma (misma mecánica que AdvancedSeismicMap).
  useEffect(() => {
    if (!mapInstance || !cityLayerGroupRef.current) return;

    let cancelled = false;

    import('leaflet').then((L) => {
      if (cancelled || !cityLayerGroupRef.current) return;

      cityLayerGroupRef.current.clearLayers();

      // Agregar ciudades
      MAJOR_CITIES.forEach((city) => {
        // Solo mostrar ciudades dentro o cerca de la región
        if (city.lat >= region.minlat - 5 && city.lat <= region.maxlat + 5 &&
            city.lon >= region.minlon - 5 && city.lon <= region.maxlon + 5) {

          // Tamaño del marcador según población
          const size = city.population > 5000000 ? 10 :
                      city.population > 2000000 ? 8 :
                      city.population > 1000000 ? 6 : 5;

          // Marcador de ciudad (cuadrado negro)
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
                <p class="text-xs text-gray-600">${city.country}</p>
                <p class="text-xs">${popupLabels.population}: ${(city.population / 1000000).toFixed(1)}M</p>
              </div>
            `)
            .addTo(cityLayerGroupRef.current);

          // Label de ciudad
          const icon = L.divIcon({
            className: 'city-label',
            html: `<div style="
                background-color: rgba(0, 0, 0, 0.7);
                color: white;
                padding: 2px 6px;
                border-radius: 3px;
                font-size: ${size > 7 ? '12px' : '10px'};
                font-weight: ${size > 7 ? 'bold' : 'normal'};
                white-space: nowrap;
                pointer-events: none;
              ">${city.name}</div>`,
            iconSize: [0, 0],
            iconAnchor: [-size - 5, 0],
          });

          L.marker([city.lat, city.lon], { icon, interactive: false })
            .addTo(cityLayerGroupRef.current);
        }
      });
    });

    return () => {
      cancelled = true;
    };
  }, [mapInstance, region, popupLabels, locale]);

  // Actualizar eventos sísmicos
  useEffect(() => {
    if (eventLayerGroupRef.current && typeof window !== 'undefined') {
      import('leaflet').then((L) => {
        // Limpiar eventos previos
        eventLayerGroupRef.current.clearLayers();

        // Agregar marcadores para cada evento
        eventos.forEach((evento) => {
          const color = getMagnitudeColor(evento.mag);
          const radius = Math.max(4, Math.min(evento.mag * 4, 30));

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
                <p class="font-bold text-lg">M${formatMagnitude(evento.mag)}</p>
                <p class="font-medium">${evento.lugar || popupLabels.unknownLocation}</p>
                <p class="text-xs text-gray-600 mt-1">${format.dateTime(new Date(evento.hora_utc), 'medium')} ${popupLabels.utcSuffix}</p>
                <p class="text-xs">${popupLabels.depth}: ${evento.prof_km ? `${evento.prof_km.toFixed(1)} km` : popupLabels.notAvailable}</p>
                <p class="text-xs">${popupLabels.coordinates}: ${evento.lat.toFixed(3)}°, ${evento.lon.toFixed(3)}°</p>
                <p class="text-xs mt-1">
                  ${evento.sentido ? `👥 ${popupLabels.feltEvent}` : ''}
                  ${evento.revisado ? ` ✓ ${popupLabels.reviewed}` : ` ~ ${popupLabels.preliminary}`}
                </p>
                <p class="text-xs font-mono mt-1">${popupLabels.source}: ${evento.fuentes.join(', ').toUpperCase()}</p>
              </div>
            `)
            .addTo(eventLayerGroupRef.current);
        });
      });
    }
    // `popupLabels` (por valor) y `locale` regeneran los popups al cambiar de
    // idioma; `format` re-formatea la fecha en el locale nuevo.
  }, [eventos, popupLabels, locale, format]);

  return (
    <div className={className}>
      <div
        ref={mapRef}
        className="h-full w-full rounded-lg border-2 border-gray-300 dark:border-gray-700 shadow-lg"
        style={{ minHeight: '500px' }}
      />
      <link
        rel="stylesheet"
        href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
        integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
        crossOrigin=""
      />

      {/* Leyenda del mapa */}
      <div className="mt-3 flex flex-wrap gap-4 text-xs">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-full bg-green-500 border-2 border-white"></div>
          <span>M &lt; 4.0</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-yellow-500 border-2 border-white"></div>
          <span>M 4.0 - 5.0</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-orange-500 border-2 border-white"></div>
          <span>M 5.0 - 6.0</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-red-500 border-2 border-white"></div>
          <span>M &gt; 6.0</span>
        </div>
        <div className="flex items-center gap-2 ml-4">
          <div className="w-3 h-3 bg-black border-2 border-white"></div>
          <span>{t('legendCities')}</span>
        </div>
      </div>
    </div>
  );
}
