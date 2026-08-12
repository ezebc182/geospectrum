/**
 * Transformaciones de los datos del reporte al formato que espera globe.gl.
 *
 * Vive aparte del componente porque es lógica pura —entran eventos, salen
 * puntos— y así se testea sin montar three.js, que necesita WebGL y no corre
 * en jsdom.
 *
 * globe.gl trabaja con objetos planos y accesores (`pointLat`, `pointColor`…),
 * no con GeoJSON, salvo en la capa de paths. De ahí que haya que convertir.
 */

import type { SeismicEvent } from '@/lib/types';

/** Punto de evento sísmico sobre la esfera. */
export interface GlobePoint {
  lat: number;
  lng: number;
  magnitude: number;
  color: string;
  label: string;
  id: string;
}

/**
 * Color por magnitud, alineado con `magnitudeBadgeVariant` del resto del
 * dashboard: un M5.5 tiene que verse del mismo color en el globo que en la
 * tabla, o el usuario cree que son datos distintos.
 */
export function magnitudeColor(magnitude: number): string {
  if (magnitude >= 6) return '#dc2626'; // rojo — mayor
  if (magnitude >= 5) return '#ea580c'; // naranja — fuerte
  if (magnitude >= 4) return '#f59e0b'; // ámbar — moderado
  if (magnitude >= 3) return '#eab308'; // amarillo — ligero
  return '#22c55e'; // verde — menor
}

/**
 * Radio del disco del evento, en grados de arco.
 *
 * Escala cuadrática con la magnitud, como las ciudades por población en el
 * ejemplo de labels de globe.gl que el usuario tomó de referencia: la
 * diferencia de tamaño tiene que leerse de un vistazo, no medirse. El piso
 * mantiene visible y clickeable un M0; el techo evita que en un enjambre el
 * principal tape a sus réplicas.
 */
export function pointRadius(magnitude: number): number {
  return Math.min(0.7, Math.max(0.15, (magnitude / 9) ** 2 * 1.3));
}

/**
 * Radio máximo del pulso, en grados de arco.
 *
 * Escala cuadrática, no lineal: con pendiente lineal un M3 y un M6 pulsaban
 * casi igual y la magnitud no se leía de un vistazo (feedback del usuario,
 * 2026-08-05). Al cuadrado, el M6 pulsa ~4 veces más grande que el M3.
 *
 * Siempre por encima de pointRadius —un anillo que muere dentro del disco no
 * se ve nunca— y con techo: un pulso de M9 sin límite cruza medio hemisferio
 * y se lee como artefacto de render, no como indicador.
 */
export function ringMaxRadius(magnitude: number): number {
  return Math.min(8, Math.max(0.6, (magnitude / 9) ** 2 * 8));
}

/**
 * Milisegundos entre pulsos.
 *
 * Decrece con la magnitud: la frecuencia es jerarquía visual, un M7 llama la
 * atención antes que un M3, igual que el color. El piso evita el parpadeo
 * frenético; el techo, que un M0 pulse tan cada tanto que parezca estático.
 */
export function ringRepeatPeriod(magnitude: number): number {
  return Math.min(4000, Math.max(1200, 3800 - magnitude * 260));
}

/**
 * Interpolador de color del anillo: nace opaco en el epicentro y muere
 * transparente en el radio máximo.
 *
 * globe.gl llama esta función con t en 0..1 según la expansión del anillo.
 * Devuelve #rrggbbaa: mismo color base del evento (el de la tabla y el mapa
 * 2D) con sólo el alfa desvaneciéndose.
 */
export function ringColorInterpolator(color: string): (t: number) => string {
  return (t) =>
    `${color}${Math.round((1 - t) * 255)
      .toString(16)
      .padStart(2, '0')}`;
}

/**
 * Coordenada del evento, o null si no es utilizable.
 *
 * No alcanza con `Number.isFinite(Number(v))`: `Number(null)`, `Number('')` y
 * `Number([])` valen 0, no NaN. Un evento con `lat: null` pasaría el filtro
 * convertido en 0 y se dibujaría en el Golfo de Guinea —que es agua, así que
 * el punto se ve plausible y nadie lo detecta a simple vista. Mismo tipo de
 * fallo silencioso que invertir [lat,lng]: no rompe, miente.
 */
function toCoordinate(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  return Number.isFinite(value) ? value : null;
}

/**
 * Identificador estable del punto en el globo.
 *
 * Se exporta porque el componente necesita reconstruir la misma clave para
 * mapear un punto clickeado de vuelta a su evento. Si cada lado calculara el
 * id por su cuenta, los eventos sin `id` —los que caen en el respaldo por
 * coordenadas— dejarían de poder seleccionarse y nadie entendería por qué
 * unos puntos responden al click y otros no.
 */
export function globePointId(evento: SeismicEvent): string {
  return evento.id ?? `${Number(evento.lat)},${Number(evento.lon)},${evento.hora_utc ?? ''}`;
}

/**
 * Strings traducidos que necesita el armado de labels.
 *
 * Llegan por parámetro desde el componente con hook: este módulo es lógica
 * pura y no importa next-intl (Decision 5 de i18n-dashboard) — la dependencia
 * del idioma queda visible en la firma en vez de esconderse en estado global.
 */
export interface GlobePointLabels {
  /** Texto para un evento sin `lugar` (ej. "sin ubicación"). */
  unknownLocation: string;
}

/**
 * Convierte los eventos del reporte a puntos del globo.
 *
 * Descarta los que no tienen coordenadas numéricas: la API devuelve el campo
 * pero una fuente puede mandarlo nulo, y un NaN en globe.gl no se ve como un
 * punto faltante sino como un artefacto en el centro de la Tierra.
 */
export function eventsToPoints(
  eventos: SeismicEvent[],
  labels: GlobePointLabels,
): GlobePoint[] {
  const points: GlobePoint[] = [];

  for (const evento of eventos) {
    const lat = toCoordinate(evento.lat);
    const lng = toCoordinate(evento.lon);
    if (lat === null || lng === null) continue;

    const magnitude = Number(evento.mag) || 0;
    points.push({
      lat,
      lng,
      magnitude,
      color: magnitudeColor(magnitude),
      label: `M${magnitude.toFixed(1)} — ${evento.lugar ?? labels.unknownLocation}`,
      id: globePointId(evento),
    });
  }

  return points;
}

/** Segmento de límite de placa, como cadena de posiciones [lat, lng]. */
export interface GlobePath {
  coords: [number, number][];
  color: string;
}

/**
 * Convierte el GeoJSON de límites de placas a paths del globo.
 *
 * globe.gl espera [lat, lng] y GeoJSON guarda [lon, lat] (RFC 7946 §3.1.1):
 * invertir acá es obligatorio, y equivocarse no da error sino un dibujo
 * espejado que parece plausible.
 *
 * Acepta LineString y MultiLineString, que son los dos tipos que trae
 * plate-boundaries.json.
 */
export function plateBoundariesToPaths(
  geojson: unknown,
  color = 'rgba(239, 68, 68, 0.55)',
): GlobePath[] {
  const paths: GlobePath[] = [];
  const features = (geojson as { features?: unknown[] })?.features;
  if (!Array.isArray(features)) return paths;

  for (const feature of features) {
    const geometry = (feature as { geometry?: { type?: string; coordinates?: unknown } })
      ?.geometry;
    if (!geometry?.coordinates) continue;

    const lines =
      geometry.type === 'MultiLineString'
        ? (geometry.coordinates as number[][][])
        : geometry.type === 'LineString'
          ? [geometry.coordinates as number[][]]
          : [];

    for (const line of lines) {
      const coords = line
        .filter((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]))
        .map((p) => [p[1], p[0]] as [number, number]);
      if (coords.length >= 2) paths.push({ coords, color });
    }
  }

  return paths;
}
