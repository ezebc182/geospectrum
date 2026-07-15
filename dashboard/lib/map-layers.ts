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

export interface GeologicalOverlay {
  name: string;
  url: string;
  description: string;
  enabled: boolean;
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

// Overlays geológicos
// Nota: Estos son URLs de servicios WMS reales para datos geológicos.
// `plateBoundaries` (límites de placas tectónicas) se retiró de este mecanismo de tile layer:
// la URL apuntaba en realidad a un servicio de fronteras políticas (World_Boundaries_and_Places),
// mal etiquetado como "límites de placas tectónicas". El reemplazo real (dataset GeoJSON PB2002 de
// fraxen/tectonicplates) se renderiza directamente en AdvancedSeismicMap.tsx vía L.geoJSON(), ya
// que es una capa vectorial (líneas), no un tile layer — no encaja en el tipo GeologicalOverlay/MapLayer
// de este archivo. Ver Decisión 1 de openspec/changes/redesign-dashboard-page/design.md.
export const GEOLOGICAL_OVERLAYS: Record<string, GeologicalOverlay> = {
  populationDensity: {
    name: 'Densidad de Población',
    url: 'https://tiles.arcgis.com/tiles/P3ePLMYs2RVChkJx/arcgis/rest/services/World_Population_Density/MapServer/tile/{z}/{y}/{x}',
    description: 'Densidad poblacional para evaluar riesgo sísmico',
    enabled: false,
  },
  usFaults: {
    name: 'Fallas Geológicas (US)',
    url: 'https://earthquake.usgs.gov/arcgis/rest/services/eq/quaternaryfaults/MapServer/tile/{z}/{y}/{x}',
    description: 'Fallas cuaternarias activas en Estados Unidos (USGS)',
    enabled: false,
  },
  usHazard: {
    name: 'Peligro Sísmico (US)',
    url: 'https://earthquake.usgs.gov/arcgis/rest/services/haz/hazard2014/MapServer/tile/{z}/{y}/{x}',
    description: 'Mapa de peligro sísmico de USGS',
    enabled: false,
  },
};

// Data sources disponibles
export const DATA_SOURCES = [
  { id: 'usgs', name: 'USGS', description: 'United States Geological Survey - Global' },
  { id: 'emsc', name: 'EMSC', description: 'Euro-Mediterranean Seismological Centre' },
  { id: 'inpres', name: 'INPRES', description: 'Instituto Nacional de Prevención Sísmica (Argentina)' },
] as const;

export type DataSourceId = typeof DATA_SOURCES[number]['id'];
