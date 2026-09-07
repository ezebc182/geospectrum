/**
 * Configuración de capas de mapas y overlays geológicos
 * Similar a EMSC y USGS con múltiples capas base y overlays
 */

export interface MapLayer {
  url: string;
  attribution: string;
  maxZoom?: number;
}

// Capas base de mapas. Sin `name`: el label visible sale del diccionario
// (`map.baseLayers.<id>`) y lo resuelve el componente con t() — este módulo
// es lib pura y no importa next-intl (Decision 5 de i18n-dashboard).
const BASE_LAYER_DEFS = {
  terrain: {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '© OpenTopoMap contributors',
    maxZoom: 17,
  },
  street: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri',
  },
  // CARTO Positron, no el bw-mapnik de tiles.wmflabs.org: ese servicio se dio
  // de baja (el host ni siquiera resuelve) y la capa quedaba en blanco, con
  // los 3 tiles rotos y sólo las placas flotando sobre el vacío. Mismo caso
  // que los overlays geológicos retirados el 2026-08-05, así que la URL nueva
  // se verificó con curl antes de entrar acá. CARTO pide atribuirse además
  // de OSM (término de uso), de ahí la atribución doble.
  greyscale: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 20,
  },
  ocean: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri',
  },
} as const satisfies Record<string, MapLayer>;

export type BaseLayerId = keyof typeof BASE_LAYER_DEFS;

// API key de CARTO, opcional. Al ser NEXT_PUBLIC_*, Next la inlinea en el
// bundle del cliente durante el build: la key viaja al navegador y CUALQUIERA
// puede leerla desde el código fuente de la página. Es PÚBLICA por
// construcción, no hay forma de esconderla acá. Por eso la key tiene que
// estar restringida por dominio en la consola de CARTO: esa restricción es
// el único control que impide que un tercero la use desde otro sitio.
// Ausente o vacía, la capa sigue funcionando con la URL sin query string
// (dev local, deploys existentes y tests no necesitan configurar nada).
const CARTO_API_KEY = process.env.NEXT_PUBLIC_CARTO_API_KEY?.trim() || '';

/** Agrega `?api_key=` sólo si hay key; si no, devuelve la URL tal cual. */
function withCartoApiKey(url: string): string {
  if (!CARTO_API_KEY) return url;
  return `${url}?api_key=${encodeURIComponent(CARTO_API_KEY)}`;
}

// Claves literales (para t(`baseLayers.${id}`) tipado) con valores anchos
// (MapLayer): sin el widening, `layer.maxZoom` no tipa en las capas que no
// lo declaran.
export const BASE_LAYERS: Record<BaseLayerId, MapLayer> = {
  ...BASE_LAYER_DEFS,
  greyscale: {
    ...BASE_LAYER_DEFS.greyscale,
    url: withCartoApiKey(BASE_LAYER_DEFS.greyscale.url),
  },
};

// Los GEOLOGICAL_OVERLAYS (densidad de población, fallas US, peligro sísmico
// US) se retiraron el 2026-08-05: los tres endpoints de tiles estaban muertos
// (dos 404 del USGS, uno de ArcGIS devolviendo HTML con status 200), así que
// los checkboxes del panel no hacían nada. Los límites de placas tectónicas
// no pasaron por acá: son GeoJSON vectorial renderizado con L.geoJSON() en
// AdvancedSeismicMap.tsx. Si se reincorporan overlays, verificar los
// endpoints con un tile real ANTES de sumarlos al panel.

// Data sources disponibles. `name` es la sigla oficial del organismo (dato,
// idéntica en ambos idiomas); la descripción visible vive en el diccionario
// (`map.sources.<id>`) y la traduce el componente (Decision 5).
export const DATA_SOURCES = [
  { id: 'usgs', name: 'USGS' },
  { id: 'emsc', name: 'EMSC' },
  { id: 'inpres', name: 'INPRES' },
] as const;

export type DataSourceId = typeof DATA_SOURCES[number]['id'];
