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
 * Ángulo de APERTURA de la punta del diente de sierra, en grados: el símbolo se abre
 * `±SUBDUCTION_SYMBOL_HEAD_ANGLE_DEG / 2` respecto de la dirección del segmento.
 *
 * No confundir con la orientación del símbolo, que sale del sentido de recorrido de la
 * traza (ver `toLatLngs`). Cambiarle el signo a este valor no invierte el diente: solo
 * refleja la punta sobre su propio eje.
 */
export const SUBDUCTION_SYMBOL_HEAD_ANGLE_DEG = 60;

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
 * Convierte las coordenadas de un feature a pares `[lat, lon]` orientados según la
 * polaridad de subducción.
 *
 * GeoJSON usa `[lon, lat]` y Leaflet `[lat, lon]`, así que siempre hay que invertir
 * cada par. Además, cuando la polaridad es `reverse` se invierte el ORDEN de los
 * vértices.
 *
 * Ese segundo paso es el que orienta los dientes de sierra. Los renderers de símbolos
 * sobre polilíneas (leaflet-polylinedecorator y equivalentes) derivan la dirección del
 * símbolo del rumbo de cada segmento, y no exponen un flag para invertirla: el
 * `headAngle` de `L.Symbol.arrowHead` es el ángulo de APERTURA de la punta
 * (`direction ± headAngle/2`), no su orientación. Recorrer la traza al revés es lo que
 * hace que la punta mire al otro lado.
 *
 * Verificación geométrica de la convención, sobre el feature `NZ\SA` (costa de
 * Chile/Perú): su traza va de sur a norte con rumbo ~8°, y la geología conocida es que
 * Nazca (oceánica, al oeste) subduce bajo Sudamérica (al este), así que los dientes
 * deben apuntar al este. Con `\` mapeado a `reverse`, el recorrido invertido produce
 * esa orientación.
 */
export function toLatLngs(feature: PlateBoundaryFeature): [number, number][] {
  const latLngs = feature.geometry.coordinates.map(
    ([lon, lat]) => [lat, lon] as [number, number]
  );
  return parsePolarity(feature.properties.Name) === 'reverse' ? latLngs.reverse() : latLngs;
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
