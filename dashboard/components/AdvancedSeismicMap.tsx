/**
 * Mapa sísmico avanzado con capas múltiples y overlays geológicos
 * Similar a EMSC y USGS con selector de capas base y overlays
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import type { AreaGeometry, SeismicEvent } from '@/lib/types';
import { areaViewBounds } from '@/lib/area-view-bounds';
import {
  getMagnitudeColor,
  getMagnitudeCategory,
  formatMagnitude,
  MAGNITUDE_CATEGORIES,
  type MagnitudeCategory,
} from '@/lib/utils';
import { BASE_LAYERS, type BaseLayerId, type DataSourceId } from '@/lib/map-layers';
import { countEventsInBounds } from '@/lib/map-bounds';
import { shouldShowCityLabel } from '@/lib/city-labels';
import { MAJOR_CITIES } from '@/lib/major-cities';
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
  const t = useTranslations('map');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const format = useFormatter();

  // Labels de los popups de Leaflet, traducidas ANTES de armar el HTML y
  // memoizadas POR VALOR: los efectos que construyen los markers dependen de
  // este objeto (y de `locale`) para regenerar los popups al cambiar de
  // idioma. La trampa documentada del proyecto es leer un ref en un efecto
  // sin tenerlo en deps —corre una vez y nunca más—, así que acá nada de lo
  // que deba re-traducirse viaja por ref.
  const popupLabels = useMemo(
    () => ({
      population: t('popup.population'),
      unknownLocation: t('popup.unknownLocation'),
      depth: t('popup.depth'),
      coordinates: t('popup.coordinates'),
      felt: t('popup.felt'),
      reviewed: t('popup.reviewed'),
      preliminary: t('popup.preliminary'),
      source: t('popup.source'),
      notAvailable: tCommon('notAvailable'),
    }),
    [t, tCommon],
  );

  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMapRef = useRef<any>(null);
  const layersRef = useRef<any>({});
  // Grupos de capas de ciudades (markers + labels), para poder regenerarlos
  // al cambiar de idioma sin destruir el mapa.
  const cityLayersRef = useRef<{ markers: any; labels: any } | null>(null);
  const plateBoundariesLayerRef = useRef<any>(null);
  // Lookup de marcador de evento por id, para centrar/resaltar vía selectedEventId (Decisión 2/3 de design.md).
  const eventMarkersRef = useRef<Map<string, any>>(new Map());

  const [currentLayer, setCurrentLayer] = useState<keyof typeof BASE_LAYERS>(defaultLayer);
  const [showLayerControl, setShowLayerControl] = useState(false);
  // Categorías de magnitud ocultas por click en la leyenda. Vacío por defecto:
  // todo visible, igual que antes de que la leyenda fuera interactiva.
  const [hiddenCategories, setHiddenCategories] = useState<Set<MagnitudeCategory>>(
    () => new Set()
  );
  const toggleCategory = (category: MagnitudeCategory) => {
    setHiddenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };
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

  // Leaflet nunca se entera solo de que su contenedor cambió de tamaño: si
  // algo externo a este componente (ej. un panel hermano que colapsa/expande
  // en la página que lo usa) hace que el <div> del mapa cambie de ancho,
  // Leaflet sigue pintando los tiles con las dimensiones viejas hasta que
  // algo fuerza un recálculo (zoom, por ejemplo). El síntoma es una franja
  // sin tiles y elementos (rutas de placas, marcadores) cortados a mitad de
  // camino, como si el mapa no ocupara todo su contenedor real.
  useEffect(() => {
    if (!mapInstance || !mapRef.current) return;

    const observer = new ResizeObserver(() => {
      mapInstance.invalidateSize();
    });
    observer.observe(mapRef.current);

    return () => observer.disconnect();
  }, [mapInstance]);

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

        // Las ciudades viven en su propio efecto (más abajo): sus popups son
        // HTML strings traducidos y deben regenerarse al cambiar de idioma
        // sin destruir el mapa (destruirlo perdería zoom, capas y selección).

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
    // `showCities` ya no está en las deps: las ciudades tienen efecto propio.
  }, [currentLayer]);

  // Ciudades: efecto separado de la creación del mapa. Sus popups y labels son
  // HTML strings, así que las labels traducidas entran POR VALOR en las deps
  // (`popupLabels` memoizado + `locale`): al cambiar el idioma el efecto corre
  // de nuevo y reconstruye la capa entera con los textos del idioma activo.
  useEffect(() => {
    if (!mapInstance || !showCities) return;

    let cancelled = false;
    let onMoveEnd: (() => void) | null = null;

    import('leaflet').then((L) => {
      if (cancelled || !leafletMapRef.current) return;
      const map = mapInstance;

      const cityLayerGroup = L.layerGroup();
      // Los labels van en su propia capa para poder rehacerlos al cambiar
      // el zoom sin tocar los marcadores, que se dibujan una sola vez.
      const cityLabelGroup = L.layerGroup();

      MAJOR_CITIES.forEach((city) => {
        // Las ciudades son referencia, no dato: puntos chicos y apagados
        // para que no compitan con los eventos. Con el negro anterior se
        // leían como "puntos negros" más fuertes que los sismos.
        const size = city.population > 5000000 ? 4 : city.population > 2000000 ? 3 : 2.5;

        L.circleMarker([city.lat, city.lon], {
          radius: size,
          fillColor: '#94a3b8',
          color: '#ffffff',
          weight: 1,
          opacity: 0.7,
          fillOpacity: 0.7,
        })
          .bindPopup(`
            <div class="text-sm">
              <p class="font-bold">${city.name}</p>
              <p class="text-xs text-gray-600">${city.country}</p>
              <p class="text-xs">${popupLabels.population}: ${(city.population / 1000000).toFixed(1)}M</p>
            </div>
          `)
          .addTo(cityLayerGroup);
      });

      // Redibuja los nombres según el zoom: a nivel continental solo las
      // megaciudades, y el resto va apareciendo al acercarse. Sin esto los
      // 30 labels se apilan sobre Sudamérica y no se lee ninguno.
      const renderCityLabels = () => {
        cityLabelGroup.clearLayers();
        const zoom = map.getZoom();

        // El filtro por viewport es el que hace el trabajo pesado ahora que
        // la lista es mundial: mirando Sudamérica, las ciudades de Asia no
        // compiten por espacio aunque pasen el corte de población.
        const bounds = map.getBounds();

        MAJOR_CITIES.filter(
          (city) =>
            shouldShowCityLabel(city.population, zoom) &&
            bounds.contains([city.lat, city.lon]),
        ).forEach(
          (city) => {
            const size = city.population > 5000000 ? 4 : city.population > 2000000 ? 3 : 2.5;
            const isMegacity = city.population > 5000000;

            // Texto con halo oscuro en vez de píldora con fondo: el
            // rectángulo negro se leía como una franja pegada al punto y
            // ensuciaba el mapa (feedback del usuario, 2026-08-05). El
            // halo mantiene la legibilidad sobre cualquier capa base.
            const icon = L.divIcon({
              className: 'city-label',
              html: `<div style="
                color: #f1f5f9;
                text-shadow: 0 1px 2px rgba(0,0,0,0.9), 0 0 4px rgba(0,0,0,0.8);
                font-size: ${isMegacity ? '11px' : '9px'};
                font-weight: ${isMegacity ? 'bold' : 'normal'};
                white-space: nowrap;
                pointer-events: none;
              ">${city.name}</div>`,
              iconSize: [0, 0],
              iconAnchor: [-size - 5, 0],
            });

            L.marker([city.lat, city.lon], { icon, interactive: false }).addTo(
              cityLabelGroup,
            );
          },
        );
      };

      renderCityLabels();
      // moveend cubre zoom Y paneo: Leaflet lo dispara al terminar
      // cualquiera de los dos, y al panear también cambia qué ciudades
      // entran en el viewport.
      onMoveEnd = renderCityLabels;
      map.on('moveend', renderCityLabels);

      cityLayerGroup.addTo(map);
      cityLabelGroup.addTo(map);
      cityLayersRef.current = { markers: cityLayerGroup, labels: cityLabelGroup };
    });

    return () => {
      cancelled = true;
      // El guard sobre leafletMapRef cubre el desmontaje: si el mapa ya se
      // destruyó, no queda nada de qué remover.
      if (leafletMapRef.current) {
        if (onMoveEnd) leafletMapRef.current.off('moveend', onMoveEnd);
        if (cityLayersRef.current) {
          leafletMapRef.current.removeLayer(cityLayersRef.current.markers);
          leafletMapRef.current.removeLayer(cityLayersRef.current.labels);
        }
      }
      cityLayersRef.current = null;
    };
  }, [mapInstance, showCities, popupLabels, locale]);

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

  // Actualizar eventos sísmicos
  useEffect(() => {
    if (leafletMapRef.current && typeof window !== 'undefined') {
      import('leaflet').then((L) => {
        // Remover marcadores de eventos previos. Se identifican por la marca
        // explícita, no por color: el criterio anterior ("todo lo que no sea
        // negro es evento") borraba las ciudades apenas cambiara su paleta.
        leafletMapRef.current.eachLayer((layer: any) => {
          if (layer instanceof L.CircleMarker && (layer.options as any).isEventMarker) {
            leafletMapRef.current.removeLayer(layer);
          }
        });
        eventMarkersRef.current.clear();

        // Agregar nuevos eventos, salvo los de una categoría oculta por la
        // leyenda: se filtra acá (no en el padre) para que "N of M events in
        // map area" siga contando sobre el total real, no sobre lo visible.
        eventos
          .filter((evento) => !hiddenCategories.has(getMagnitudeCategory(evento.mag)))
          .forEach((evento) => {
            const color = getMagnitudeColor(evento.mag);
            const radius = Math.max(4, Math.min(evento.mag * 4, 30));

            // Determinar icono de fuente
            const sourceIcon = evento.fuentes.includes('EMSC') ? '🇪🇺' :
                             evento.fuentes.includes('INPRES') ? '🇦🇷' :
                             '🇺🇸';

            // `isEventMarker` no es una opción de Leaflet: es la marca que usa
            // el guard de limpieza para distinguir eventos de ciudades.
            // Leaflet conserva las opciones extra en layer.options.
            const marker = L.circleMarker([evento.lat, evento.lon], {
              radius,
              fillColor: color,
              color: '#ffffff',
              weight: 2,
              opacity: 1,
              fillOpacity: 0.6,
              isEventMarker: true,
            } as any)
              .bindPopup(`
                <div class="text-sm">
                  <p class="font-bold text-lg">M${formatMagnitude(evento.mag)} ${sourceIcon}</p>
                  <p class="font-medium">${evento.lugar || popupLabels.unknownLocation}</p>
                  <p class="text-xs text-gray-600 mt-1">${format.dateTime(new Date(evento.hora_utc), 'medium')}</p>
                  <p class="text-xs">${popupLabels.depth}: ${evento.prof_km ? `${evento.prof_km.toFixed(1)} km` : popupLabels.notAvailable}</p>
                  <p class="text-xs">${popupLabels.coordinates}: ${evento.lat.toFixed(3)}°, ${evento.lon.toFixed(3)}°</p>
                  <p class="text-xs mt-1">
                    ${evento.sentido ? `👥 ${popupLabels.felt}` : ''}
                    ${evento.revisado ? ` ✓ ${popupLabels.reviewed}` : ` ~ ${popupLabels.preliminary}`}
                  </p>
                  <p class="text-xs font-mono mt-1">${popupLabels.source}: ${evento.fuentes.join(', ').toUpperCase()}</p>
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
    // `popupLabels` (por valor, memoizado) y `locale` regeneran los popups al
    // cambiar de idioma; `format` re-formatea la fecha en el locale nuevo.
  }, [eventos, onEventClick, hiddenCategories, popupLabels, locale, format]);

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
  //
  // Depende de `mapInstance` y de `eventos` además de `selectedEventId`, y no
  // sólo de este último: `eventMarkersRef` es un ref y poblarlo no dispara
  // renders. En el Explorador la lista y el mapa son vistas excluyentes, así
  // que al saltar de una a otra el mapa se monta con `selectedEventId` YA
  // puesto: el efecto corría una vez con el ref todavía vacío, salía por el
  // `!marker` y no volvía a intentarlo nunca. Con `mapInstance` en las deps
  // vuelve a correr cuando el mapa existe y los marcadores ya están creados.
  useEffect(() => {
    if (!leafletMapRef.current || !selectedEventId) return;
    const marker = eventMarkersRef.current.get(selectedEventId);
    if (!marker) return;

    const latLng = marker.getLatLng();
    leafletMapRef.current.panTo(latLng);
    marker.openPopup();
  }, [selectedEventId, mapInstance, eventos]);

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
          title={t('layersButton')}
        >
          <Layers className="h-5 w-5 text-gray-700 dark:text-gray-300" />
        </button>

        {showLayerControl && (
          <div className="absolute top-14 right-0 max-h-[70vh] w-72 overflow-y-auto bg-white dark:bg-gray-900 border-2 border-gray-300 dark:border-gray-700 rounded-lg shadow-xl p-4">
            {/* Capas Base */}
            <div className="mb-4">
              <h4 className="font-bold text-sm mb-2 text-gray-900 dark:text-white">{t('baseLayer')}</h4>
              <div className="space-y-1">
                {(Object.keys(BASE_LAYERS) as BaseLayerId[]).map((key) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded">
                    <input
                      type="radio"
                      name="baseLayer"
                      checked={currentLayer === key}
                      onChange={() => setCurrentLayer(key)}
                      className="h-4 w-4"
                    />
                    <span className="text-sm text-gray-900 dark:text-white">{t(`baseLayers.${key}`)}</span>
                  </label>
                ))}
              </div>
            </div>

            {/*
              Capas Tectónicas: vectoriales (GeoJSON), no tiles — por eso no
              son una capa base. Los "Overlays Geológicos" que vivían debajo
              se retiraron el 2026-08-05: los tres endpoints estaban muertos
              (dos 404 del USGS y uno devolviendo HTML con status 200), así
              que eran checkboxes que no hacían nada y estiraban el panel.
            */}
            <div className="border-t-2 border-gray-200 dark:border-gray-700 pt-4">
              <h4 className="font-bold text-sm mb-2 text-gray-900 dark:text-white">{t('tectonicLayers')}</h4>
              <label className="flex items-start gap-2 cursor-pointer p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded">
                <input
                  type="checkbox"
                  checked={showPlates}
                  onChange={() => setShowPlates(prev => !prev)}
                  className="mt-0.5 h-4 w-4"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-gray-900 dark:text-white">{t('plateBoundaries')}</div>
                  <div className="text-xs text-gray-600 dark:text-gray-400">
                    {t('plateBoundariesDescription')}
                  </div>
                </div>
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Leyenda: cada categoría es un toggle — clickearla oculta/muestra esos
          eventos en el mapa, para poder aislar visualmente una franja de
          magnitud sin que las demás "molesten". */}
      <div className="absolute bottom-4 left-4 right-4 z-[1000] flex justify-center pointer-events-none sm:right-auto sm:justify-start">
        <div className="pointer-events-auto bg-white dark:bg-gray-900 border-2 border-gray-300 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <div className="flex flex-wrap gap-3 text-xs">
            {MAGNITUDE_CATEGORIES.map(({ id, label, color }) => {
              const isHidden = hiddenCategories.has(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggleCategory(id)}
                  aria-pressed={!isHidden}
                  className={`flex items-center gap-2 rounded px-1 transition-opacity hover:bg-gray-100 dark:hover:bg-gray-800 ${
                    isHidden ? 'opacity-40' : ''
                  }`}
                >
                  <div
                    className="h-4 w-4 rounded-full border-2 border-white"
                    style={{ backgroundColor: color }}
                  />
                  <span
                    className={`text-gray-900 dark:text-white ${isHidden ? 'line-through' : ''}`}
                  >
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
