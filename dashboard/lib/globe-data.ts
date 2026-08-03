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
  /** Altura del punto sobre la superficie, 0..1 en radios de globo. */
  altitude: number;
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
 * Altura del punto sobre la superficie.
 *
 * Escala con la magnitud, no con la profundidad: en una esfera del tamaño de
 * la pantalla, 700 km de profundidad son menos de un píxel y no se distinguen
 * de un evento superficial. La magnitud sí es lo que se quiere comparar de un
 * vistazo, y elevarla hace que los eventos grandes se lean sin tener que girar
 * el globo buscándolos.
 *
 * El techo de 0.35 evita que un M8 quede tan alto que parezca desprendido de
 * la superficie.
 */
export function pointAltitude(magnitude: number): number {
  return Math.min(0.35, Math.max(0.01, (magnitude / 10) ** 2 * 1.4));
}

/**
 * Convierte los eventos del reporte a puntos del globo.
 *
 * Descarta los que no tienen coordenadas numéricas: la API devuelve el campo
 * pero una fuente puede mandarlo nulo, y un NaN en globe.gl no se ve como un
 * punto faltante sino como un artefacto en el centro de la Tierra.
 */
export function eventsToPoints(eventos: SeismicEvent[]): GlobePoint[] {
  const points: GlobePoint[] = [];

  for (const evento of eventos) {
    const lat = Number(evento.lat);
    const lng = Number(evento.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const magnitude = Number(evento.mag) || 0;
    points.push({
      lat,
      lng,
      magnitude,
      altitude: pointAltitude(magnitude),
      color: magnitudeColor(magnitude),
      label: `M${magnitude.toFixed(1)} — ${evento.lugar ?? 'sin ubicación'}`,
      id: evento.id ?? `${lat},${lng},${evento.hora_utc ?? ''}`,
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
