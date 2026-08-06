/**
 * Configuración de capas de mapas y overlays geológicos
 * Similar a EMSC y USGS con múltiples capas base y overlays
 */

export interface MapLayer {
  name: string;
  url: string;
  attribution: string;
  maxZoom?: number;
}

// Capas base de mapas
export const BASE_LAYERS: Record<string, MapLayer> = {
  terrain: {
    name: 'Terreno',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '© OpenTopoMap contributors',
    maxZoom: 17,
  },
  street: {
    name: 'Calles',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
  },
  satellite: {
    name: 'Satélite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri',
  },
  greyscale: {
    name: 'Escala de Grises',
    url: 'https://tiles.wmflabs.org/bw-mapnik/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
  },
  ocean: {
    name: 'Océano',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri',
  },
};

// Los GEOLOGICAL_OVERLAYS (densidad de población, fallas US, peligro sísmico
// US) se retiraron el 2026-08-05: los tres endpoints de tiles estaban muertos
// (dos 404 del USGS, uno de ArcGIS devolviendo HTML con status 200), así que
// los checkboxes del panel no hacían nada. Los límites de placas tectónicas
// no pasaron por acá: son GeoJSON vectorial renderizado con L.geoJSON() en
// AdvancedSeismicMap.tsx. Si se reincorporan overlays, verificar los
// endpoints con un tile real ANTES de sumarlos al panel.

// Data sources disponibles
export const DATA_SOURCES = [
  { id: 'usgs', name: 'USGS', description: 'United States Geological Survey - Global' },
  { id: 'emsc', name: 'EMSC', description: 'Euro-Mediterranean Seismological Centre' },
  { id: 'inpres', name: 'INPRES', description: 'Instituto Nacional de Prevención Sísmica (Argentina)' },
] as const;

export type DataSourceId = typeof DATA_SOURCES[number]['id'];
