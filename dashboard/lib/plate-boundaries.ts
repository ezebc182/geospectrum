/**
 * Utilidades puras para clasificar y estilizar los límites de placas tectónicas
 * (dataset PB2002 de Peter Bird, vendorizado en public/geo/plate-boundaries.json).
 *
 * Extraído de AdvancedSeismicMap para ser testeable sin una instancia real de
 * Leaflet, siguiendo el patrón de map-bounds.ts. La vista 3D (globe.gl) reusará
 * este módulo tal cual y solo aportará su propio render de símbolos.
 *
 * Ver docs/superpowers/specs/2026-07-27-plate-boundaries-usgs-style-design.md
 */

/** Propiedades de cada feature del dataset PB2002. */
export interface PlateBoundaryProperties {
  LAYER: string;
  /** Códigos de las dos placas, separados por `/` o `\` (ver parsePolarity). */
  Name: string;
  PlateA: string;
  PlateB: string;
  Source: string;
  /** `"subduction"` en 65 de los 241 features; cadena vacía en el resto. */
  Type: string;
}

export interface PlateBoundaryFeature {
  type: 'Feature';
  properties: PlateBoundaryProperties;
  geometry: {
    type: 'LineString';
    coordinates: [number, number][];
  };
}

export interface PlateBoundaryCollection {
  type: 'FeatureCollection';
  features: PlateBoundaryFeature[];
}

/** Tipo de contacto entre placas, a efectos de estilizado. */
export type BoundaryKind = 'subduction' | 'other';

/**
 * Lado hacia el que se hunde la placa en una zona de subducción, y por lo tanto
 * hacia dónde apuntan los dientes de sierra.
 */
export type Polarity = 'forward' | 'reverse';

export interface BoundaryStyle {
  color: string;
  weight: number;
  opacity: number;
}

/** Rojo del referente USGS, ya usado por el mapa antes de este change. */
const BOUNDARY_COLOR = '#dc2626';

const STYLES: Record<BoundaryKind, BoundaryStyle> = {
  subduction: { color: BOUNDARY_COLOR, weight: 2, opacity: 0.85 },
  other: { color: BOUNDARY_COLOR, weight: 1.2, opacity: 0.65 },
};

/** Separación entre dientes de sierra, en píxeles de pantalla. */
export const SUBDUCTION_SYMBOL_SPACING_PX = 40;

/** Tamaño del diente de sierra, en píxeles. */
export const SUBDUCTION_SYMBOL_SIZE_PX = 7;

/**
 * Clasifica un feature por su tipo de contacto.
 *
 * El dataset solo distingue `"subduction"` del resto (cadena vacía), así que
 * cualquier valor no reconocido cae en `'other'`: un dataset actualizado que
 * agregue tipos nuevos degrada a trazo simple en vez de romper el render.
 */
export function classify(feature: PlateBoundaryFeature): BoundaryKind {
  return feature.properties?.Type === 'subduction' ? 'subduction' : 'other';
}

/**
 * Extrae la polaridad de subducción del campo `Name`.
 *
 * PB2002 codifica de qué lado se hunde la placa mediante el separador entre los
 * dos códigos: `EU/AF` es la orientación opuesta a `EU\AF`. En el dataset actual
 * la correlación con `Type` es del 100%: los 65 features de subducción tienen
 * separador (44 con `/`, 21 con `\`) y los 176 restantes no tienen ninguno.
 *
 * Devuelve `null` cuando no hay separador, que es el caso normal de los límites
 * que no son de subducción (y que no llevan símbolos).
 */
export function parsePolarity(name: string): Polarity | null {
  if (!name) return null;
  if (name.includes('\\')) return 'reverse';
  if (name.includes('/')) return 'forward';
  return null;
}

/** Estilo de trazo para un tipo de contacto. */
export function styleFor(kind: BoundaryKind): BoundaryStyle {
  return STYLES[kind];
}

/**
 * Separa los features por tipo de contacto en una sola pasada.
 *
 * El render necesita los dos grupos por separado: solo el de subducción lleva
 * decorador de símbolos, y aplicarlo sobre los 241 features en vez de sobre los
 * 65 relevantes multiplicaría el trabajo en cada zoom sin efecto visible.
 */
export function partitionByKind(collection: PlateBoundaryCollection): Record<BoundaryKind, PlateBoundaryFeature[]> {
  const groups: Record<BoundaryKind, PlateBoundaryFeature[]> = { subduction: [], other: [] };
  for (const feature of collection.features ?? []) {
    groups[classify(feature)].push(feature);
  }
  return groups;
}
