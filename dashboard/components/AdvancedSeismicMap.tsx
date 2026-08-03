/**
 * Mapa sísmico avanzado con capas múltiples y overlays geológicos
 * Similar a EMSC y USGS con selector de capas base y overlays
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import type { AreaGeometry, SeismicEvent } from '@/lib/types';
import { areaViewBounds } from '@/lib/area-view-bounds';
import { getMagnitudeColor, formatMagnitude, formatDateTime } from '@/lib/utils';
import { BASE_LAYERS, GEOLOGICAL_OVERLAYS, type DataSourceId } from '@/lib/map-layers';
import { countEventsInBounds } from '@/lib/map-bounds';
import {
  partitionByKind,
  parsePolarity,
  styleFor,
  toLatLngs,
  withWorldCopies,
  worldCopyOffsets,
  SUBDUCTION_SYMBOL_SPACING_PX,
  SUBDUCTION_SYMBOL_SIZE_PX,
  SUBDUCTION_SYMBOL_HEAD_ANGLE_DEG,
  type PlateBoundaryCollection,
  type PlateBoundaryFeature,
} from '@/lib/plate-boundaries';
import { Layers, Eye, EyeOff } from 'lucide-react';

interface AdvancedSeismicMapProps {
  eventos: SeismicEvent[];
  className?: string;
  /**
   * Bbox del área de interés activa. El mapa se encuadra acá en vez de en un
   * centro fijo: sin esto el Dashboard apuntaba siempre a los Andes aunque el
   * usuario tuviera seleccionada otra región.
   *
   * Opcional para no romper a los llamadores que todavía no lo pasan; ahí se
   * cae al encuadre histórico de Sudamérica.
   */
  region?: { minlat: number; maxlat: number; minlon: number; maxlon: number };
  /**
   * Geometría real del área activa. Manda sobre `region` para el encuadre: el
   * bbox de un área que cruza el antimeridiano (Kamchatka, Anillo de Fuego)
   * declara -180..180 y encuadraría el planeta entero.
   */
  areaGeometry?: AreaGeometry | null;
  showCities?: boolean;
  defaultLayer?: keyof typeof BASE_LAYERS;
  /** Renderiza los límites de placas tectónicas reales (GeoJSON PB2002). Default: false (comportamiento actual sin cambios). */
  showPlateBoundaries?: boolean;
  /** Id del evento seleccionado externamente (p. ej. click en fila de tabla). Default: undefined (sin selección). */
  selectedEventId?: string | null;
  /** Callback invocado al hacer click sobre un marcador de evento en el mapa. Default: undefined (sin listener). */
  onEventClick?: (id: string) => void;
  /** Callback invocado con (visibleCount, totalCount) cada vez que cambian los bounds visibles o el set de eventos. Default: undefined. */
  onBoundsChange?: (visibleCount: number, totalCount: number) => void;
}

interface MajorCity {
  name: string;
  lat: number;
  lon: number;
  population: number;
  country: string;
}

// Listado unificado (Decisión 7 de design.md): 9 ciudades originales de este componente
// + 27 de SeismicMapWithCities, deduplicadas por coincidencia de coordenadas (6 en común).
// Total: 30 ciudades, todas con `country` para consistencia de tipo.
const MAJOR_CITIES: MajorCity[] = [
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

  // Exclusivas de las 9 originales de AdvancedSeismicMap (fuera de la cobertura AR/CL/PE/BO/PY/UY)
  { name: 'Bogotá', lat: 4.7110, lon: -74.0721, population: 10000000, country: 'Colombia' },
  { name: 'Caracas', lat: 10.4806, lon: -66.9036, population: 3000000, country: 'Venezuela' },
  { name: 'Quito', lat: -0.1807, lon: -78.4678, population: 2800000, country: 'Ecuador' },
];

export function AdvancedSeismicMap({
  eventos,
  className = '',
  region,
  areaGeometry,
  showCities = true,
  defaultLayer = 'terrain',
  showPlateBoundaries = false,
  selectedEventId = null,
  onEventClick,
  onBoundsChange,
}: AdvancedSeismicMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMapRef = useRef<any>(null);
  const layersRef = useRef<any>({});
  const overlaysRef = useRef<any>({});
  const plateBoundariesLayerRef = useRef<any>(null);
  // Lookup de marcador de evento por id, para centrar/resaltar vía selectedEventId (Decisión 2/3 de design.md).
  const eventMarkersRef = useRef<Map<string, any>>(new Map());

  const [currentLayer, setCurrentLayer] = useState<keyof typeof BASE_LAYERS>(defaultLayer);
  const [activeOverlays, setActiveOverlays] = useState<string[]>([]);
  const [showLayerControl, setShowLayerControl] = useState(false);
  // `showPlateBoundaries` es solo el valor INICIAL: el usuario puede togglear la capa desde el panel
  // (Decisión 3 de 2026-07-27-plate-boundaries-usgs-style-design.md). Antes era una prop fija, así
  // que las placas quedaban prendidas en el Dashboard y apagadas en /explore sin forma de cambiarlo.
  const [showPlates, setShowPlates] = useState(showPlateBoundaries);
  // La instancia del mapa vive TAMBIÉN en estado, no solo en `leafletMapRef`: un ref no
  // dispara re-render, así que un efecto que dependa únicamente de él corre una sola vez
  // —en el primer render, cuando el mapa todavía no existe— y ya nunca vuelve a correr.
  // El efecto de placas necesita re-ejecutarse cuando el mapa queda listo; por eso su
  // creación se publica como estado (ver deps del efecto de límites de placas).
  const [mapInstance, setMapInstance] = useState<any>(null);

  // El efecto que crea el mapa depende de [showCities, currentLayer], NO de
  // `region`: leer la prop directamente ahí congelaría el valor del primer
  // render (cuando el área todavía está cargando). Se lee del ref, y el efecto
  // de reencuadre de abajo se ocupa de los cambios posteriores.
  const regionRef = useRef(region);
  regionRef.current = region;
  const areaGeometryRef = useRef(areaGeometry);
  areaGeometryRef.current = areaGeometry;

  // Reencuadrar cuando cambia el área activa.
  //
  // Va en un efecto SEPARADO del que crea el mapa a propósito: aquel tiene un
  // guard `!leafletMapRef.current` y agregarle `region` a las deps no
  // reencuadraría nada —saldría por el guard—, mientras que sacarle el guard
  // destruiría y recrearía el mapa entero en cada cambio, perdiendo las capas
  // y la selección del usuario.
  //
  // Depende de `mapInstance` (estado) y no de `leafletMapRef` (ref) porque un
  // ref no dispara renders: con el ref, este efecto correría sólo en el primer
  // render, cuando el mapa todavía no existe, y nunca reencuadraría.
  //
  // El encuadre se serializa a string para las deps: `areaViewBounds` devuelve
  // un array nuevo en cada render, y SWR además devuelve un `region` nuevo en
  // cada revalidación. Dependiendo del objeto, el mapa saltaría al encuadre
  // inicial cada 60 segundos y le pisaría el zoom al usuario. Con la clave sólo
  // se reencuadra cuando los NÚMEROS cambian, o sea cuando cambió el área.
  const viewBounds = areaViewBounds(areaGeometry, region);
  const viewBoundsKey = viewBounds ? JSON.stringify(viewBounds) : null;

  useEffect(() => {
    if (!mapInstance || !viewBoundsKey) return;

    mapInstance.fitBounds(JSON.parse(viewBoundsKey));
    // `viewBounds` queda fuera de las deps a propósito: `viewBoundsKey` es su
    // forma estable y se parsea acá adentro para no depender de la identidad
    // del array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapInstance, viewBoundsKey]);

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

        // Sin `region` se cae al encuadre histórico (Sudamérica): este efecto
        // sólo corre al crear el mapa, y en ese momento el área todavía puede
        // estar cargando. El efecto de reencuadre de más abajo lo corrige
        // apenas llega, y también cuando el usuario cambia de área.
        const map = L.map(container);
        const initial = areaViewBounds(areaGeometryRef.current, regionRef.current);
        if (initial) {
          map.fitBounds(initial);
        } else {
          map.setView([-30, -65], 4);
        }

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
                  <p class="text-xs text-gray-600">${city.country}</p>
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
        // Publica la instancia como estado para despertar a los efectos que dependen de
        // que el mapa ya exista (límites de placas). El ref se mantiene porque el resto
        // del componente lo usa de forma síncrona dentro de callbacks.
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
        eventMarkersRef.current.clear();

        // Agregar nuevos eventos
        eventos.forEach((evento) => {
          const color = getMagnitudeColor(evento.mag);
          const radius = Math.max(4, Math.min(evento.mag * 4, 30));

          // Determinar icono de fuente
          const sourceIcon = evento.fuentes.includes('EMSC') ? '🇪🇺' :
                           evento.fuentes.includes('INPRES') ? '🇦🇷' :
                           '🇺🇸';

          const marker = L.circleMarker([evento.lat, evento.lon], {
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

          // Sincronización mapa→tabla es opcional/bonus (Decisión 3 de design.md);
          // no afecta la sincronización principal tabla→mapa, que es unidireccional.
          if (onEventClick) {
            marker.on('click', () => onEventClick(evento.id));
          }

          eventMarkersRef.current.set(evento.id, marker);
        });
      });
    }
  }, [eventos, onEventClick]);

  // Cargar y renderizar límites de placas tectónicas (GeoJSON PB2002 vendorizado), estilizados por
  // tipo de contacto como el mapa Latest Earthquakes del USGS: los 73 tramos de subducción llevan
  // dientes de sierra orientados según la polaridad codificada en `PLATEBOUND`; los 698 divergentes
  // (dorsales y rifts) van punteados; el resto, trazo simple
  // (2026-07-27-plate-boundaries-usgs-style-design.md).
  // Efecto separado del de inicialización del mapa: async, no bloqueante (Decisión 1 de design.md).
  useEffect(() => {
    // Depende de `mapInstance` (estado), no solo del ref: ver comentario en su declaración.
    // Con `[showPlates]` como única dependencia este efecto corría una sola vez, antes de que
    // el efecto de inicialización hubiera creado el mapa, y salía por el guard para siempre.
    if (!mapInstance || !showPlates) return;

    let cancelled = false;
    // Se asigna cuando el plugin de símbolos carga; hasta entonces la capa se dibuja sin dientes.
    let decorate: (group: any, features: PlateBoundaryFeature[]) => void = () => {};
    let onMoveEnd: (() => void) | null = null;

    import('leaflet').then((L) => {
      fetch('/geo/plate-boundaries.json')
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then(async (data: PlateBoundaryCollection) => {
          if (cancelled || !leafletMapRef.current) return;

          const groups = partitionByKind(data);
          const { subduction } = groups;

          // Copias del mundo ya dibujadas, para no rehacer trabajo en cada `moveend`.
          let drawnOffsets: number[] = [];

          /**
           * Redibuja la capa cubriendo las copias del mundo que abarca la vista actual.
           *
           * Leaflet repite las tiles al panear en horizontal, pero una capa vectorial se dibuja
           * una sola vez en el rango -180..180: sin esto, al cruzar el antimeridiano las placas
           * desaparecen. Replicar la geometría a las copias visibles hace que el planisferio se
           * una consigo mismo como una panorámica, sin el salto de vista de `worldCopyJump`.
           */
          const redraw = (decorate: (group: any, features: typeof subduction) => void) => {
            const map = leafletMapRef.current;
            if (!map) return;

            const bounds = map.getBounds();
            const offsets = worldCopyOffsets(bounds.getWest(), bounds.getEast());
            if (
              offsets.length === drawnOffsets.length &&
              offsets.every((o, i) => o === drawnOffsets[i])
            ) {
              return; // La vista sigue dentro de las copias ya dibujadas.
            }

            if (plateBoundariesLayerRef.current) {
              map.removeLayer(plateBoundariesLayerRef.current);
            }

            // Un solo LayerGroup contenedor: el cleanup sigue siendo un removeLayer.
            const group = L.layerGroup();
            // La subducción va última para que su trazo grueso quede por encima en los cruces.
            for (const kind of ['other', 'divergent', 'subduction'] as const) {
              const features = withWorldCopies(groups[kind], offsets);
              if (features.length === 0) continue;
              L.geoJSON(
                { type: 'FeatureCollection', features } as any,
                { style: styleFor(kind) }
              ).addTo(group);
            }

            decorate(group, withWorldCopies(subduction, offsets));
            group.addTo(map);
            plateBoundariesLayerRef.current = group;
            drawnOffsets = offsets;
          };

          // Primer render sin símbolos: las líneas aparecen sin esperar al plugin.
          redraw(() => {});

          // Dientes de sierra: se aplican solo sobre los tramos de subducción. El decorador es
          // opcional — si el plugin falla al cargar, las líneas ya están dibujadas y la capa degrada
          // a "placas sin símbolos" en lugar de romper el mapa.
          try {
            // leaflet-polylinedecorator es un bundle UMD: recibe Leaflet por parámetro y le
            // agrega `Symbol` y `polylineDecorator` a ESE objeto (ver dist/…js líneas 1-4,
            // `factory(require('leaflet'))` / `factory(global.L)`). El `L` que devuelve
            // `import('leaflet')` es el namespace ESM —un exotic object sellado, distinto del
            // export CommonJS que recibe el plugin—, así que las extensiones NO aparecen ahí
            // y `L.Symbol` queda undefined. Se publica `window.L` ANTES de cargar el plugin
            // para que la rama UMD decore un objeto que sí podemos leer después.
            const w = window as any;
            w.L = w.L ?? L;
            await import('leaflet-polylinedecorator');
            if (cancelled || !leafletMapRef.current) return;

            // Toma el namespace que realmente quedó decorado: `window.L` si el plugin lo
            // extendió por la rama global, o el módulo si Webpack resolvió por CommonJS.
            const LD: any = (w.L && w.L.Symbol) ? w.L : (L as any);
            if (!LD.Symbol || !LD.polylineDecorator) {
              throw new Error(
                'leaflet-polylinedecorator no extendió Leaflet (Symbol/polylineDecorator ausentes)'
              );
            }

            decorate = (group, features) => {
              for (const feature of features) {
                if (!parsePolarity(feature.properties.PLATEBOUND)) continue;
                // toLatLngs invierte el orden de los vértices cuando la polaridad es `reverse`:
                // el decorador deriva la dirección del símbolo del rumbo de cada segmento, así
                // que recorrer la traza al revés es lo que hace que los dientes de sierra miren
                // al lado correcto. `headAngle` NO sirve para esto: es el ángulo de apertura de
                // la punta (direction ± headAngle/2), no su orientación.
                const latLngs = toLatLngs(feature);
                LD
                  .polylineDecorator(latLngs, {
                    patterns: [
                      {
                        offset: SUBDUCTION_SYMBOL_SPACING_PX / 2,
                        repeat: SUBDUCTION_SYMBOL_SPACING_PX,
                        symbol: LD.Symbol.arrowHead({
                          pixelSize: SUBDUCTION_SYMBOL_SIZE_PX,
                          headAngle: SUBDUCTION_SYMBOL_HEAD_ANGLE_DEG,
                          polygon: true,
                          pathOptions: { ...styleFor('subduction'), fillOpacity: 0.9, weight: 1 },
                        }),
                      },
                    ],
                  })
                  .addTo(group);
              }
            };

            // Redibuja lo ya dibujado, ahora con símbolos.
            drawnOffsets = [];
            redraw(decorate);
          } catch (err) {
            console.error('No se pudieron dibujar los símbolos de subducción:', err);
          }

          // Al panear a una copia del mundo todavía sin dibujar, se replica la geometría hacia allá.
          onMoveEnd = () => redraw(decorate);
          leafletMapRef.current?.on('moveend', onMoveEnd);
        })
        .catch((err) => {
          // Falla de red/parseo no debe romper el resto del mapa (spec Requirement 2).
          console.error('No se pudo cargar el GeoJSON de placas tectónicas:', err);
        });
    });

    return () => {
      cancelled = true;
      if (onMoveEnd && leafletMapRef.current) {
        leafletMapRef.current.off('moveend', onMoveEnd);
      }
      if (plateBoundariesLayerRef.current && leafletMapRef.current) {
        leafletMapRef.current.removeLayer(plateBoundariesLayerRef.current);
        plateBoundariesLayerRef.current = null;
      }
    };
  }, [showPlates, mapInstance]);

  // Centrar/resaltar el evento seleccionado externamente (sincronización tabla→mapa, Decisión 3).
  useEffect(() => {
    if (!leafletMapRef.current || !selectedEventId) return;
    const marker = eventMarkersRef.current.get(selectedEventId);
    if (!marker) return;

    const latLng = marker.getLatLng();
    leafletMapRef.current.panTo(latLng);
    marker.openPopup();
  }, [selectedEventId]);

  // Contador "N of M events in map area" (Decisión 4 de design.md).
  useEffect(() => {
    if (!leafletMapRef.current || !onBoundsChange) return;
    const map = leafletMapRef.current;

    const recompute = () => {
      const { visible, total } = countEventsInBounds(eventos, map.getBounds());
      onBoundsChange(visible, total);
    };

    recompute();
    map.on('moveend zoomend', recompute);
    return () => {
      map.off('moveend zoomend', recompute);
    };
  }, [eventos, onBoundsChange]);

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

            {/* Capas Tectónicas: vectoriales (GeoJSON), no tiles — por eso no están en GEOLOGICAL_OVERLAYS. */}
            <div className="border-t-2 border-gray-200 dark:border-gray-700 pt-4 mb-4">
              <h4 className="font-bold text-sm mb-2 text-gray-900 dark:text-white">Capas Tectónicas</h4>
              <label className="flex items-start gap-2 cursor-pointer p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded">
                <input
                  type="checkbox"
                  checked={showPlates}
                  onChange={() => setShowPlates(prev => !prev)}
                  className="mt-0.5 h-4 w-4"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-gray-900 dark:text-white">Límites de Placas</div>
                  <div className="text-xs text-gray-600 dark:text-gray-400">
                    Zonas de subducción con dientes de sierra y otros límites tectónicos (PB2002)
                  </div>
                </div>
              </label>
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
      <div className="absolute bottom-4 left-4 right-4 z-[1000] flex justify-center pointer-events-none sm:right-auto sm:justify-start">
        <div className="pointer-events-auto bg-white dark:bg-gray-900 border-2 border-gray-300 dark:border-gray-700 rounded-lg shadow-lg p-3">
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
    </div>
  );
}
