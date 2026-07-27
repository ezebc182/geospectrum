import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classify,
  parsePolarity,
  partitionByKind,
  styleFor,
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
