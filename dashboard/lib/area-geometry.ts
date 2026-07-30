/**
 * Replicación del polígono del área de interés a las copias del mundo.
 *
 * Leaflet dibuja las capas vectoriales una sola vez, en longitudes -180..180:
 * al panear hacia el este o el oeste la capa DESAPARECE, porque el mapa sigue
 * mostrando tiles pero el vector se quedó en la copia original. Es el mismo
 * problema que ya resolvió lib/plate-boundaries.ts para los límites de placas.
 *
 * Se reusa `worldCopyOffsets()` de ahí —es genérico, sólo calcula qué copias
 * hacen falta para un viewport— pero el desplazamiento va aparte: aquel opera
 * sobre LineStrings ([lon,lat][]) y un área es un Polygon (anillos, un nivel
 * más de anidamiento) o un MultiPolygon (dos niveles más).
 *
 * Se recalcula en cada `moveend`, no se fija un número de copias: N copias
 * fijas siempre se quedan cortas si el usuario panea lo suficiente.
 */

import type { AreaGeometry } from './types';
import { worldCopyOffsets } from './plate-boundaries';

/** Desplaza en longitud los anillos de un Polygon. */
function shiftPolygon(
  coordinates: [number, number][][],
  offset: number
): [number, number][][] {
  return coordinates.map((ring) =>
    ring.map(([lon, lat]) => [lon + offset, lat] as [number, number])
  );
}

/**
 * Devuelve la geometría replicada a todas las copias del mundo visibles.
 *
 * El resultado es SIEMPRE un MultiPolygon, aun si la entrada era un Polygon:
 * cada copia es un polígono independiente y L.geoJSON los dibuja todos de una.
 *
 * @param geometry geometría del área, tal como viene del backend
 * @param west longitud del borde oeste del viewport, sin normalizar (puede ser -900)
 * @param east longitud del borde este del viewport, sin normalizar
 */
export function areaGeometryWithWorldCopies(
  geometry: AreaGeometry,
  west: number,
  east: number
): { type: 'MultiPolygon'; coordinates: [number, number][][][] } {
  const offsets = worldCopyOffsets(west, east);

  const polygons: [number, number][][][] =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;

  return {
    type: 'MultiPolygon',
    coordinates: offsets.flatMap((offset) =>
      offset === 0
        ? polygons
        : polygons.map((rings) => shiftPolygon(rings, offset))
    ),
  };
}
