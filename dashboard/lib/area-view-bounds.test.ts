import { describe, expect, it } from 'vitest';

import { areaViewBounds } from '@/lib/area-view-bounds';
import type { AreaBbox, AreaGeometry } from '@/lib/types';

/** Rectángulo simple como Polygon, en el orden [lon, lat] de GeoJSON. */
function rect(
  minlon: number,
  maxlon: number,
  minlat: number,
  maxlat: number
): AreaGeometry {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minlon, minlat],
        [maxlon, minlat],
        [maxlon, maxlat],
        [minlon, maxlat],
        [minlon, minlat],
      ],
    ],
  };
}

/** Dos rectángulos como MultiPolygon: la forma de un área partida por el antimeridiano. */
function twoRects(
  a: [number, number, number, number],
  b: [number, number, number, number]
): AreaGeometry {
  const ring = ([minlon, maxlon, minlat, maxlat]: [number, number, number, number]) =>
    (rect(minlon, maxlon, minlat, maxlat) as { coordinates: [number, number][][] })
      .coordinates;

  return {
    type: 'MultiPolygon',
    coordinates: [ring(a), ring(b)],
  };
}

describe('areaViewBounds — áreas que no cruzan el antimeridiano', () => {
  it('encuadra un Polygon simple por su propia extensión', () => {
    // Japón: 128..148 E, 30..46 N.
    const bounds = areaViewBounds(rect(128, 148, 30, 46), null);

    expect(bounds).toEqual([
      [30, 128],
      [46, 148],
    ]);
  });

  it('cae al bbox cuando no hay geometría todavía', () => {
    // El área se pide aparte del reporte; mientras carga sólo está el bbox.
    const bbox: AreaBbox = { minlat: -56, maxlat: -17.5, minlon: -76.5, maxlon: -66 };

    expect(areaViewBounds(null, bbox)).toEqual([
      [-56, -76.5],
      [-17.5, -66],
    ]);
  });

  it('devuelve null sin geometría ni bbox', () => {
    expect(areaViewBounds(null, null)).toBeNull();
  });
});

describe('areaViewBounds — áreas que cruzan el antimeridiano', () => {
  it('NO abraza el mundo entero con Kamchatka', () => {
    // El caso que rompía: bbox_minlon=-180 y bbox_maxlon=180 hacían que
    // fitBounds encuadrara los 360° de longitud, o sea el planeta entero, en
    // vez de la franja real de 55° de ancho.
    const kamchatka = twoRects([150, 180, 47, 60], [-180, -155, 47, 60]);

    const bounds = areaViewBounds(kamchatka, {
      minlat: 47,
      maxlat: 60,
      minlon: -180,
      maxlon: 180,
    });

    expect(bounds).not.toBeNull();
    const [[southLat, westLon], [northLat, eastLon]] = bounds!;

    expect(southLat).toBe(47);
    expect(northLat).toBe(60);

    // El ancho real es 55° (150E..205E), no 360°. Es LA aserción que separa el
    // encuadre correcto del bug: sin desenrollar, esto da 360.
    expect(eastLon - westLon).toBeCloseTo(55);

    // Se expresa como 150..205: pasado el antimeridiano las longitudes siguen
    // creciendo en vez de saltar a -180. Leaflet lo acepta y no da la vuelta.
    expect(westLon).toBeCloseTo(150);
    expect(eastLon).toBeCloseTo(205);
  });

  it('mantiene el área contigua cuando la parte oriental es la más chica', () => {
    // Nueva Zelanda extendida: la mayor parte al este, un pedazo pasado el
    // antimeridiano. Cambia cuál de los dos lados es el "grande", y el
    // resultado tiene que seguir siendo una franja angosta.
    const bounds = areaViewBounds(twoRects([170, 180, -48, -33], [-180, -175, -48, -33]), null);

    expect(bounds).not.toBeNull();
    const [[, westLon], [, eastLon]] = bounds!;

    expect(eastLon - westLon).toBeCloseTo(15);
    expect(westLon).toBeCloseTo(170);
    expect(eastLon).toBeCloseTo(185);
  });

  it('no desenrolla un área ancha que NO cruza, aunque toque los bordes', () => {
    // El cinturón alpino-himalayo va de -10 a 105: es genuinamente ancho, pero
    // es UN solo polígono contiguo. No hay que tocarlo.
    const bounds = areaViewBounds(rect(-10, 105, 25, 47), null);

    expect(bounds).toEqual([
      [25, -10],
      [47, 105],
    ]);
  });

  it('no desenrolla dos polígonos que están a ambos lados de Greenwich', () => {
    // Un área partida en dos trozos, uno a cada lado del meridiano 0, pero que
    // NO toca el antimeridiano: el Mediterráneo occidental (-10..0) más el
    // oriental (0..37). Tener partes en los dos hemisferios NO alcanza para
    // desenrollar — hace falta que toquen los bordes ±180.
    //
    // Sin la condición completa esto daría [−10 .. 397]: el mapa encuadraría
    // una vuelta entera del planeta en vez de los 47° reales.
    const bounds = areaViewBounds(twoRects([-10, -1, 32, 42], [1, 37, 32, 42]), null);

    expect(bounds).toEqual([
      [32, -10],
      [42, 37],
    ]);
  });

  it('deja el área global como el mundo entero', () => {
    // -180..180 en un solo polígono ES el planeta: acá encuadrar todo es lo
    // correcto, no un bug. Distinguirlo del caso Kamchatka importa.
    const bounds = areaViewBounds(rect(-180, 180, -90, 90), null);

    expect(bounds).toEqual([
      [-90, -180],
      [90, 180],
    ]);
  });
});
