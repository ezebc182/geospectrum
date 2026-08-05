/**
 * Encuadre del mapa para un área de interés.
 *
 * El bbox NO sirve como encuadre para las áreas que cruzan el antimeridiano.
 * Kamchatka va de 150°E a -155°W: como el bbox es un rectángulo en
 * coordenadas -180..180, para "contenerla" tiene que declarar
 * minlon=-180, maxlon=180. Un fitBounds sobre eso encuadra los 360° de
 * longitud —el planeta entero— en vez de la franja real de 55° de ancho.
 *
 * La geometría sí tiene la información: el área viene como MultiPolygon con
 * una parte a cada lado del corte. Acá se desenrolla, sumando 360° a la parte
 * occidental para que las dos queden contiguas (150..205 en el ejemplo).
 * Leaflet acepta longitudes fuera de -180..180 y encuadra sin dar la vuelta.
 *
 * Ojo: esto es para el ENCUADRE, no para el recorte. El recorte de un área
 * cóncava sigue necesitando la geometría real (ver lib/area-geometry.ts): un
 * rectángulo envolvente incluiría puntos que están fuera del área.
 */

import type { AreaBbox, AreaGeometry } from '@/lib/types';

/** Par [[sur, oeste], [norte, este]] en el orden [lat, lon] que espera Leaflet. */
export type ViewBounds = [[number, number], [number, number]];

/**
 * Un área se considera partida por el antimeridiano cuando tiene anillos
 * pegados a cada borde y ninguno cruza el centro del mapa. El umbral es
 * generoso (1°) porque los datasets redondean las coordenadas del corte.
 */
const ANTIMERIDIAN_EPSILON = 1;

/** Todos los anillos exteriores de la geometría, sea Polygon o MultiPolygon. */
function outerRings(geometry: AreaGeometry): [number, number][][] {
  if (geometry.type === 'Polygon') {
    // El primer anillo es el exterior; los siguientes son huecos y no aportan
    // al encuadre, que siempre queda contenido en el exterior.
    return geometry.coordinates.slice(0, 1);
  }

  return geometry.coordinates
    .map((polygon) => polygon[0])
    .filter((ring): ring is [number, number][] => Array.isArray(ring) && ring.length > 0);
}

export function areaViewBounds(
  geometry: AreaGeometry | null | undefined,
  bbox: AreaBbox | null | undefined
): ViewBounds | null {
  if (!geometry) {
    // Mientras el área carga sólo está el bbox del reporte. Para la enorme
    // mayoría de las áreas es exacto; para las que cruzan el antimeridiano es
    // el encuadre demasiado ancho, pero dura hasta que llega la geometría.
    if (!bbox) return null;
    return [
      [bbox.minlat, bbox.minlon],
      [bbox.maxlat, bbox.maxlon],
    ];
  }

  const rings = outerRings(geometry);
  if (rings.length === 0) return null;

  let minlat = Infinity;
  let maxlat = -Infinity;

  // Se acumulan por separado los anillos del hemisferio oriental (lon > 0) y
  // los del occidental, para poder detectar el corte y desenrollar.
  let eastMin = Infinity; // extremo oeste de la parte oriental
  let eastMax = -Infinity;
  let westMin = Infinity; // extremo oeste de la parte occidental
  let westMax = -Infinity;
  let hasEast = false;
  let hasWest = false;

  for (const ring of rings) {
    // Un anillo se clasifica por su centro y no punto por punto: partirlo
    // mezclaría los dos lados de un mismo polígono contiguo.
    let ringMin = Infinity;
    let ringMax = -Infinity;

    for (const [lon, lat] of ring) {
      if (lat < minlat) minlat = lat;
      if (lat > maxlat) maxlat = lat;
      if (lon < ringMin) ringMin = lon;
      if (lon > ringMax) ringMax = lon;
    }

    if ((ringMin + ringMax) / 2 >= 0) {
      hasEast = true;
      if (ringMin < eastMin) eastMin = ringMin;
      if (ringMax > eastMax) eastMax = ringMax;
    } else {
      hasWest = true;
      if (ringMin < westMin) westMin = ringMin;
      if (ringMax > westMax) westMax = ringMax;
    }
  }

  if (!Number.isFinite(minlat) || !Number.isFinite(maxlat)) return null;

  // El corte se reconoce por la forma característica: hay partes de los dos
  // lados, la oriental termina en +180 y la occidental empieza en -180.
  const split =
    hasEast &&
    hasWest &&
    eastMax >= 180 - ANTIMERIDIAN_EPSILON &&
    westMin <= -180 + ANTIMERIDIAN_EPSILON;

  if (split) {
    // Se desenrolla la parte occidental sumándole una vuelta entera: -155
    // pasa a ser 205, contiguo al 180 donde termina la oriental.
    return [
      [minlat, eastMin],
      [maxlat, westMax + 360],
    ];
  }

  // Caso normal, incluido el área global (-180..180 en un solo polígono, que
  // ES el planeta) y las áreas anchas pero contiguas como el cinturón
  // alpino-himalayo.
  const minlon = Math.min(hasEast ? eastMin : Infinity, hasWest ? westMin : Infinity);
  const maxlon = Math.max(hasEast ? eastMax : -Infinity, hasWest ? westMax : -Infinity);

  if (!Number.isFinite(minlon) || !Number.isFinite(maxlon)) return null;

  return [
    [minlat, minlon],
    [maxlat, maxlon],
  ];
}

/** Centro y altitud de cámara para react-globe.gl, derivados de un ViewBounds. */
export interface GlobeFocus {
  lat: number;
  lng: number;
  altitude: number;
}

/** Altitud mínima y máxima, en radios de globo (mismo rango que FOCUS_ALTITUDE de eventos). */
const MIN_AREA_ALTITUDE = 1.4;
const MAX_AREA_ALTITUDE = 2.8;

/**
 * Traduce un ViewBounds (formato Leaflet, [lat, lon]) al foco que espera
 * `globe.pointOfView()`: centro en [-180, 180] y una altitud proporcional al
 * lado más largo del área, para que una falla local acerque la cámara y un
 * área tan ancha como el Anillo de Fuego se vea completa.
 */
export function globeFocusFromBounds(bounds: ViewBounds): GlobeFocus {
  const [[south, west], [north, east]] = bounds;

  const lat = (south + north) / 2;
  // west/east pueden salir "desenrollados" más allá de ±180 (ver split arriba):
  // el centro se calcula sobre esos valores y recién después se normaliza, o el
  // promedio de un área partida por el antimeridiano cae del lado equivocado.
  const lngRaw = (west + east) / 2;
  const lng = ((((lngRaw + 180) % 360) + 360) % 360) - 180;

  const latSpan = north - south;
  const lngSpan = east - west;
  const span = Math.max(latSpan, lngSpan);

  // 180° de lado (un área del tamaño del planeta) mapea a la altitud máxima;
  // 0° a la mínima. Lineal y clampeado: no hace falta más precisión que "más
  // grande el área, más lejos la cámara".
  const altitude =
    MIN_AREA_ALTITUDE +
    (Math.min(span, 180) / 180) * (MAX_AREA_ALTITUDE - MIN_AREA_ALTITUDE);

  return { lat, lng, altitude };
}
