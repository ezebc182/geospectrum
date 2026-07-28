/**
 * Utilidades puras para clasificar y estilizar los límites de placas tectónicas
 * (dataset PB2002 de Peter Bird, vendorizado en public/geo/plate-boundaries.json).
 *
 * Extraído de AdvancedSeismicMap para ser testeable sin una instancia real de
 * Leaflet, siguiendo el patrón de map-bounds.ts. La vista 3D (globe.gl) reusará
 * este módulo tal cual y solo aportará su propio render de símbolos.
 *
 * El dataset vendorizado lo genera scripts/build_plate_boundaries.py a partir de
 * PB2002_steps.json, que es la variante que trae el tipo de contacto en STEPCLASS.
 *
 * Ver docs/superpowers/specs/2026-07-27-plate-boundaries-usgs-style-design.md
 */

/**
 * Tipo de contacto de PB2002, tal como viene en STEPCLASS.
 *
 * La inicial `O`/`C` distingue oceánico de continental, y el resto de la sigla es
 * Spreading Ridge, Transform Fault, SUBduction, Rift Boundary y Convergent Boundary.
 */
export type StepClass = 'OSR' | 'OTF' | 'SUB' | 'CRB' | 'CTF' | 'CCB' | 'OCB';

/** Propiedades de cada feature del dataset vendorizado. */
export interface PlateBoundaryProperties {
  /** Tipo de contacto; ver StepClass. */
  STEPCLASS: string;
  /** Códigos de las dos placas, separados por `/` o `\` (ver parsePolarity). */
  PLATEBOUND: string;
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

/**
 * Tipo de contacto a efectos de estilizado, siguiendo los tres trazos que usa el
 * USGS en sus mapas de tectónica:
 *
 * - `subduction`: trazo grueso con dientes de sierra apuntando a la placa cabalgante.
 * - `divergent`: trazo punteado, donde las placas se separan (dorsales y rifts).
 * - `other`: trazo sólido fino, para transformantes y convergencias sin subducción.
 */
export type BoundaryKind = 'subduction' | 'divergent' | 'other';

/**
 * Lado hacia el que se hunde la placa en una zona de subducción, y por lo tanto
 * hacia dónde apuntan los dientes de sierra.
 */
export type Polarity = 'forward' | 'reverse';

export interface BoundaryStyle {
  color: string;
  weight: number;
  opacity: number;
  /** Patrón de guiones de SVG; ausente en los trazos sólidos. */
  dashArray?: string;
}

/** Rojo del referente USGS, ya usado por el mapa antes de este change. */
const BOUNDARY_COLOR = '#dc2626';

const STYLES: Record<BoundaryKind, BoundaryStyle> = {
  subduction: { color: BOUNDARY_COLOR, weight: 2, opacity: 0.85 },
  divergent: { color: BOUNDARY_COLOR, weight: 1.5, opacity: 0.75, dashArray: '6 5' },
  other: { color: BOUNDARY_COLOR, weight: 1.2, opacity: 0.65 },
};

/**
 * Mapeo de los siete tipos de contacto de PB2002 a los tres trazos del USGS.
 *
 * Los divergentes son las dorsales oceánicas (OSR) y los rifts continentales (CRB):
 * en ambos las placas se separan, que es lo que el trazo punteado representa. Las
 * convergencias sin subducción (CCB, OCB) van con el trazo neutro junto a las
 * transformantes, porque PB2002 no identifica en ellas una placa cabalgante y por
 * lo tanto no hay lado hacia el que orientar dientes.
 */
const KIND_BY_STEP_CLASS: Record<StepClass, BoundaryKind> = {
  SUB: 'subduction',
  OSR: 'divergent',
  CRB: 'divergent',
  OTF: 'other',
  CTF: 'other',
  CCB: 'other',
  OCB: 'other',
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
 * Cualquier STEPCLASS no reconocido cae en `'other'`: un dataset actualizado que
 * agregue tipos nuevos degrada a trazo simple en vez de romper el render.
 */
export function classify(feature: PlateBoundaryFeature): BoundaryKind {
  const stepClass = feature.properties?.STEPCLASS as StepClass | undefined;
  return (stepClass && KIND_BY_STEP_CLASS[stepClass]) ?? 'other';
}

/**
 * Extrae la polaridad de subducción del campo `PLATEBOUND`.
 *
 * PB2002 codifica de qué lado se hunde la placa mediante el separador entre los
 * dos códigos: `EU/AF` es la orientación opuesta a `EU\AF`. Los 73 tramos de
 * subducción del dataset vendorizado tienen separador (50 con `/`, 23 con `\`).
 *
 * Devuelve `null` cuando no hay separador, que es el caso normal de los límites
 * que no son de subducción (y que no llevan símbolos). Ojo: un puñado de tramos
 * que no son de subducción SÍ trae separador, herencia del dataset original; es
 * inocuo porque solo el grupo `subduction` se decora con símbolos.
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
  return parsePolarity(feature.properties.PLATEBOUND) === 'reverse' ? latLngs.reverse() : latLngs;
}

/**
 * Separa los features por tipo de contacto en una sola pasada.
 *
 * El render necesita los grupos por separado: cada uno lleva su propio trazo, y solo
 * el de subducción lleva decorador de símbolos. Aplicarlo sobre los 1687 features en
 * vez de sobre los 73 relevantes multiplicaría el trabajo en cada zoom sin efecto
 * visible.
 */
export function partitionByKind(collection: PlateBoundaryCollection): Record<BoundaryKind, PlateBoundaryFeature[]> {
  const groups: Record<BoundaryKind, PlateBoundaryFeature[]> = {
    subduction: [],
    divergent: [],
    other: [],
  };
  for (const feature of collection.features ?? []) {
    groups[classify(feature)].push(feature);
  }
  return groups;
}
