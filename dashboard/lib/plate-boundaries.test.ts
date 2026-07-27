import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classify,
  parsePolarity,
  partitionByKind,
  styleFor,
  toLatLngs,
  type PlateBoundaryCollection,
  type PlateBoundaryFeature,
} from './plate-boundaries';

function makeFeature(name: string, type: string): PlateBoundaryFeature {
  return {
    type: 'Feature',
    properties: {
      LAYER: 'plate boundary',
      Name: name,
      PlateA: name.slice(0, 2),
      PlateB: name.slice(-2),
      Source: 'test',
      Type: type,
    },
    geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
  };
}

describe('classify', () => {
  it('clasifica como subduction cuando Type es "subduction"', () => {
    expect(classify(makeFeature('EU/AF', 'subduction'))).toBe('subduction');
  });

  it('clasifica como other cuando Type es cadena vacía', () => {
    expect(classify(makeFeature('AF-AN', ''))).toBe('other');
  });

  it('degrada a other ante un Type desconocido en lugar de fallar', () => {
    expect(classify(makeFeature('XX/YY', 'transform'))).toBe('other');
  });
});

describe('parsePolarity', () => {
  it('devuelve forward para el separador "/"', () => {
    expect(parsePolarity('EU/AF')).toBe('forward');
  });

  it('devuelve reverse para el separador "\\"', () => {
    expect(parsePolarity('EU\\AF')).toBe('reverse');
  });

  it('devuelve null cuando no hay separador de polaridad', () => {
    expect(parsePolarity('AF-AN')).toBeNull();
  });

  it('devuelve null ante un nombre vacío', () => {
    expect(parsePolarity('')).toBeNull();
  });
});

describe('styleFor', () => {
  it('da más grosor y opacidad a la subducción que al resto', () => {
    const subduction = styleFor('subduction');
    const other = styleFor('other');
    expect(subduction.weight).toBeGreaterThan(other.weight);
    expect(subduction.opacity).toBeGreaterThan(other.opacity);
  });

  it('usa el mismo color base para los dos tipos', () => {
    expect(styleFor('subduction').color).toBe(styleFor('other').color);
  });
});

describe('partitionByKind', () => {
  it('separa los features en los dos grupos', () => {
    const collection: PlateBoundaryCollection = {
      type: 'FeatureCollection',
      features: [
        makeFeature('EU/AF', 'subduction'),
        makeFeature('AF-AN', ''),
        makeFeature('AU\\PA', 'subduction'),
      ],
    };
    const groups = partitionByKind(collection);
    expect(groups.subduction).toHaveLength(2);
    expect(groups.other).toHaveLength(1);
  });

  it('devuelve grupos vacíos ante una colección sin features', () => {
    const groups = partitionByKind({ type: 'FeatureCollection', features: [] });
    expect(groups).toEqual({ subduction: [], other: [] });
  });
});

describe('toLatLngs', () => {
  it('convierte [lon, lat] de GeoJSON a [lat, lon] de Leaflet', () => {
    const feature = makeFeature('AF-AN', '');
    feature.geometry.coordinates = [[-70, -33], [-71, -34]];
    expect(toLatLngs(feature)).toEqual([[-33, -70], [-34, -71]]);
  });

  it('conserva el orden de los vértices cuando la polaridad es forward', () => {
    const feature = makeFeature('NZ/SA', 'subduction');
    feature.geometry.coordinates = [[-70, -20], [-71, -30], [-72, -40]];
    expect(toLatLngs(feature)).toEqual([[-20, -70], [-30, -71], [-40, -72]]);
  });

  it('invierte el orden de los vértices cuando la polaridad es reverse', () => {
    const feature = makeFeature('NZ\\SA', 'subduction');
    feature.geometry.coordinates = [[-70, -20], [-71, -30], [-72, -40]];
    expect(toLatLngs(feature)).toEqual([[-40, -72], [-30, -71], [-20, -70]]);
  });

  it('no muta el feature original', () => {
    const feature = makeFeature('NZ\\SA', 'subduction');
    feature.geometry.coordinates = [[-70, -20], [-72, -40]];
    toLatLngs(feature);
    expect(feature.geometry.coordinates).toEqual([[-70, -20], [-72, -40]]);
  });
});

/**
 * Rumbo inicial de una traza ya convertida a [lat, lon], en grados desde el norte.
 * Replica el cálculo con el que se validó la convención de polaridad contra la
 * geología conocida de la zona de subducción de Chile/Perú.
 */
function initialBearing(latLngs: [number, number][]): number {
  const [lat1, lon1] = latLngs[0];
  const [lat2, lon2] = latLngs[1];
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Fija la orientación de los dientes de sierra contra un caso de geología conocida,
 * que es lo único que ningún test de tipos puede cubrir: si alguien vuelve a intentar
 * invertir la polaridad con `headAngle` en vez de con el orden de los vértices, la
 * subducción quedaría dibujada del lado equivocado y este test lo detecta.
 */
describe('orientación de los dientes de sierra (caso Chile/Perú)', () => {
  const dataset: PlateBoundaryCollection = JSON.parse(
    readFileSync(join(__dirname, '..', 'public', 'geo', 'plate-boundaries.json'), 'utf-8')
  );

  it('orienta los símbolos de NZ\\SA hacia el este, donde Nazca subduce bajo Sudamérica', () => {
    // Traza más larga del límite Nazca/Sudamérica: costa de Chile y Perú.
    const nazcaSudamerica = dataset.features
      .filter((f) => f.properties.PlateA === 'NZ' && f.properties.PlateB === 'SA')
      .sort((a, b) => b.geometry.coordinates.length - a.geometry.coordinates.length)[0];

    expect(nazcaSudamerica).toBeDefined();
    expect(parsePolarity(nazcaSudamerica.properties.Name)).toBe('reverse');

    // Sin invertir, la traza corre de sur a norte (rumbo ~8°, casi Norte), lo que dejaría
    // los dientes apuntando al oeste, hacia el océano: al revés de la geología real.
    const sinInvertir = nazcaSudamerica.geometry.coordinates.map(
      ([lon, lat]) => [lat, lon] as [number, number]
    );
    expect(initialBearing(sinInvertir)).toBeLessThan(45);

    // toLatLngs invierte el recorrido: pasa a ir de norte a sur (rumbo ~188°), y el
    // símbolo, perpendicular a la izquierda del avance, queda mirando al este.
    const bearing = initialBearing(toLatLngs(nazcaSudamerica));
    expect(bearing).toBeGreaterThan(90);
    expect(bearing).toBeLessThan(270);
  });
});

/**
 * Contrato con el dataset vendorizado: si una actualización de
 * public/geo/plate-boundaries.json rompe la convención del separador en `Name`,
 * estos tests fallan y el render de dientes de sierra queda avisado antes de
 * degradarse en silencio.
 */
describe('contrato con el dataset PB2002 vendorizado', () => {
  const dataset: PlateBoundaryCollection = JSON.parse(
    readFileSync(join(__dirname, '..', 'public', 'geo', 'plate-boundaries.json'), 'utf-8')
  );

  it('tiene los 241 features LineString esperados', () => {
    expect(dataset.features).toHaveLength(241);
    expect(dataset.features.every((f) => f.geometry.type === 'LineString')).toBe(true);
  });

  it('clasifica los 241 features en 65 de subducción y 176 restantes', () => {
    const groups = partitionByKind(dataset);
    expect(groups.subduction).toHaveLength(65);
    expect(groups.other).toHaveLength(176);
  });

  it('todo feature de subducción tiene polaridad parseable', () => {
    const { subduction } = partitionByKind(dataset);
    const sinPolaridad = subduction.filter((f) => parsePolarity(f.properties.Name) === null);
    expect(sinPolaridad).toEqual([]);
  });

  it('ningún feature que no sea de subducción tiene separador de polaridad', () => {
    const { other } = partitionByKind(dataset);
    const conPolaridad = other.filter((f) => parsePolarity(f.properties.Name) !== null);
    expect(conPolaridad).toEqual([]);
  });
});
