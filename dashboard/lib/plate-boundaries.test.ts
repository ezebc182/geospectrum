import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classify,
  parsePolarity,
  partitionByKind,
  styleFor,
  toLatLngs,
  withWorldCopies,
  worldCopyOffsets,
  type PlateBoundaryCollection,
  type PlateBoundaryFeature,
} from './plate-boundaries';

function makeFeature(plateBound: string, stepClass: string): PlateBoundaryFeature {
  return {
    type: 'Feature',
    properties: {
      PLATEBOUND: plateBound,
      STEPCLASS: stepClass,
    },
    geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
  };
}

describe('classify', () => {
  it('clasifica SUB como subduction', () => {
    expect(classify(makeFeature('EU/AF', 'SUB'))).toBe('subduction');
  });

  it('clasifica las dorsales oceánicas (OSR) como divergent', () => {
    expect(classify(makeFeature('AF-AN', 'OSR'))).toBe('divergent');
  });

  it('clasifica los rifts continentales (CRB) como divergent', () => {
    expect(classify(makeFeature('AF-AR', 'CRB'))).toBe('divergent');
  });

  it.each(['OTF', 'CTF', 'CCB', 'OCB'])(
    'clasifica %s como other: son transformantes o convergencias sin placa cabalgante',
    (stepClass) => {
      expect(classify(makeFeature('AF-AN', stepClass))).toBe('other');
    }
  );

  it('degrada a other ante un STEPCLASS desconocido en lugar de fallar', () => {
    expect(classify(makeFeature('XX/YY', 'FUTURO'))).toBe('other');
  });

  it('degrada a other ante un feature sin STEPCLASS', () => {
    const feature = makeFeature('XX-YY', '');
    delete (feature.properties as Partial<typeof feature.properties>).STEPCLASS;
    expect(classify(feature)).toBe('other');
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

  it('usa el mismo color base para los tres tipos', () => {
    expect(styleFor('divergent').color).toBe(styleFor('subduction').color);
    expect(styleFor('other').color).toBe(styleFor('subduction').color);
  });

  it('puntea solo el trazo divergente: es lo que lo distingue del sólido del USGS', () => {
    expect(styleFor('divergent').dashArray).toBeTruthy();
    expect(styleFor('subduction').dashArray).toBeUndefined();
    expect(styleFor('other').dashArray).toBeUndefined();
  });
});

describe('partitionByKind', () => {
  it('separa los features en los tres grupos', () => {
    const collection: PlateBoundaryCollection = {
      type: 'FeatureCollection',
      features: [
        makeFeature('EU/AF', 'SUB'),
        makeFeature('AF-AN', 'OTF'),
        makeFeature('AU\\PA', 'SUB'),
        makeFeature('NA-EU', 'OSR'),
        makeFeature('AF-AR', 'CRB'),
      ],
    };
    const groups = partitionByKind(collection);
    expect(groups.subduction).toHaveLength(2);
    expect(groups.divergent).toHaveLength(2);
    expect(groups.other).toHaveLength(1);
  });

  it('devuelve grupos vacíos ante una colección sin features', () => {
    const groups = partitionByKind({ type: 'FeatureCollection', features: [] });
    expect(groups).toEqual({ subduction: [], divergent: [], other: [] });
  });
});

describe('worldCopyOffsets', () => {
  it('cubre la copia original más un margen a cada lado cuando la vista no cruza bordes', () => {
    expect(worldCopyOffsets(-60, 60)).toEqual([-360, 0, 360]);
  });

  it('sigue la vista al panear al oeste: devuelve las copias negativas que la cubren', () => {
    // Vista centrada ~2 vueltas al oeste: la copia -720 tiene que estar incluida.
    expect(worldCopyOffsets(-800, -680)).toContain(-720);
  });

  it('sigue la vista al panear al este', () => {
    expect(worldCopyOffsets(680, 800)).toContain(720);
  });

  it('cubre todas las copias intermedias cuando la vista abarca varios mundos', () => {
    // A zoom muy bajo el viewport puede ser más ancho que un mundo entero.
    const offsets = worldCopyOffsets(-500, 500, 0);
    expect(offsets).toEqual([-360, 0, 360]);
  });

  it('devuelve offsets contiguos de 360 en 360, sin huecos', () => {
    const offsets = worldCopyOffsets(-1000, 1000);
    for (let i = 1; i < offsets.length; i += 1) {
      expect(offsets[i] - offsets[i - 1]).toBe(360);
    }
  });
});

describe('withWorldCopies', () => {
  it('replica los features a cada offset pedido', () => {
    const features = [makeFeature('AF-AN', 'OSR'), makeFeature('NZ\\SA', 'SUB')];
    expect(withWorldCopies(features, [-360, 0, 360])).toHaveLength(6);
  });

  it('desplaza la longitud y deja la latitud intacta', () => {
    const feature = makeFeature('AF-AN', 'OSR');
    feature.geometry.coordinates = [[-70, -33], [-71, -34]];

    const copias = withWorldCopies([feature], [-360, 0, 360]);
    expect(copias.map((f) => f.geometry.coordinates[0][0])).toEqual([-430, -70, 290]);
    for (const copia of copias) {
      expect(copia.geometry.coordinates.map(([, lat]) => lat)).toEqual([-33, -34]);
    }
  });

  it('conserva las properties, de las que dependen el estilo y la polaridad', () => {
    const copias = withWorldCopies([makeFeature('NZ\\SA', 'SUB')], [-360, 0, 360]);
    expect(copias.every((f) => f.properties.STEPCLASS === 'SUB')).toBe(true);
    expect(copias.every((f) => parsePolarity(f.properties.PLATEBOUND) === 'reverse')).toBe(true);
  });

  it('no muta los features originales', () => {
    const feature = makeFeature('AF-AN', 'OSR');
    feature.geometry.coordinates = [[-70, -33], [-71, -34]];
    withWorldCopies([feature], [-360, 0, 360]);
    expect(feature.geometry.coordinates).toEqual([[-70, -33], [-71, -34]]);
  });

  it('devuelve una lista vacía ante una entrada vacía', () => {
    expect(withWorldCopies([], [-360, 0, 360])).toEqual([]);
  });
});

describe('toLatLngs', () => {
  it('convierte [lon, lat] de GeoJSON a [lat, lon] de Leaflet', () => {
    const feature = makeFeature('AF-AN', 'OTF');
    feature.geometry.coordinates = [[-70, -33], [-71, -34]];
    expect(toLatLngs(feature)).toEqual([[-33, -70], [-34, -71]]);
  });

  it('conserva el orden de los vértices cuando la polaridad es forward', () => {
    const feature = makeFeature('NZ/SA', 'SUB');
    feature.geometry.coordinates = [[-70, -20], [-71, -30], [-72, -40]];
    expect(toLatLngs(feature)).toEqual([[-20, -70], [-30, -71], [-40, -72]]);
  });

  it('invierte el orden de los vértices cuando la polaridad es reverse', () => {
    const feature = makeFeature('NZ\\SA', 'SUB');
    feature.geometry.coordinates = [[-70, -20], [-71, -30], [-72, -40]];
    expect(toLatLngs(feature)).toEqual([[-40, -72], [-30, -71], [-20, -70]]);
  });

  it('no muta el feature original', () => {
    const feature = makeFeature('NZ\\SA', 'SUB');
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

const dataset: PlateBoundaryCollection = JSON.parse(
  readFileSync(join(__dirname, '..', 'public', 'geo', 'plate-boundaries.json'), 'utf-8')
);

/**
 * Fija la orientación de los dientes de sierra contra un caso de geología conocida,
 * que es lo único que ningún test de tipos puede cubrir: si alguien vuelve a intentar
 * invertir la polaridad con `headAngle` en vez de con el orden de los vértices, la
 * subducción quedaría dibujada del lado equivocado y este test lo detecta.
 */
describe('orientación de los dientes de sierra (caso Chile/Perú)', () => {
  it('orienta los símbolos de NZ\\SA hacia el este, donde Nazca subduce bajo Sudamérica', () => {
    // Traza más larga del límite Nazca/Sudamérica: costa de Chile y Perú.
    const nazcaSudamerica = dataset.features
      .filter((f) => f.properties.PLATEBOUND === 'NZ\\SA')
      .sort((a, b) => b.geometry.coordinates.length - a.geometry.coordinates.length)[0];

    expect(nazcaSudamerica).toBeDefined();
    expect(classify(nazcaSudamerica)).toBe('subduction');
    expect(parsePolarity(nazcaSudamerica.properties.PLATEBOUND)).toBe('reverse');

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
 * Contrato con el dataset vendorizado que genera scripts/build_plate_boundaries.py.
 * Si una regeneración cambia el pipeline (tolerancia de simplificación, criterio de
 * fusión) o rompe la convención del separador en `PLATEBOUND`, estos tests fallan y
 * el render queda avisado antes de degradarse en silencio.
 */
describe('contrato con el dataset PB2002 vendorizado', () => {
  it('tiene los 1687 features LineString esperados', () => {
    expect(dataset.features).toHaveLength(1687);
    expect(dataset.features.every((f) => f.geometry.type === 'LineString')).toBe(true);
  });

  it('clasifica los features en 73 de subducción, 698 divergentes y 916 restantes', () => {
    const groups = partitionByKind(dataset);
    expect(groups.subduction).toHaveLength(73);
    expect(groups.divergent).toHaveLength(698);
    expect(groups.other).toHaveLength(916);
  });

  it('todo feature de subducción tiene polaridad parseable', () => {
    const { subduction } = partitionByKind(dataset);
    const sinPolaridad = subduction.filter((f) => parsePolarity(f.properties.PLATEBOUND) === null);
    expect(sinPolaridad).toEqual([]);
  });

  it('mantiene la simplificación por debajo del presupuesto de vértices del render', () => {
    // El dataset crudo PB2002_steps trae 269.153 vértices: impracticable en Leaflet.
    // build_plate_boundaries.py lo simplifica a ~5.7k, por debajo de los 6.292 que
    // tenía el dataset de boundaries al que reemplaza. Si una regeneración se pasa de
    // este techo, el costo de render sube y conviene revisar la tolerancia.
    const vertices = dataset.features.reduce((sum, f) => sum + f.geometry.coordinates.length, 0);
    expect(vertices).toBeLessThan(6292);
  });

  it('usa solo los siete tipos de contacto conocidos de PB2002', () => {
    const conocidos = new Set(['OSR', 'OTF', 'SUB', 'CRB', 'CTF', 'CCB', 'OCB']);
    const desconocidos = [
      ...new Set(dataset.features.map((f) => f.properties.STEPCLASS)),
    ].filter((c) => !conocidos.has(c));
    expect(desconocidos).toEqual([]);
  });

  /**
   * PB2002_steps trae separador de polaridad en 15 tramos que no son de subducción
   * (10 OTF, 3 CTF, 2 CRB), a diferencia del dataset de boundaries anterior donde la
   * correlación con el tipo era del 100%.
   *
   * Es inocuo —solo el grupo `subduction` se decora con símbolos— pero se fija acá para
   * que quede explícito que es una propiedad conocida del dataset y no un síntoma de
   * que la clasificación se desalineó.
   */
  it('tolera los 15 tramos que no son de subducción y traen separador', () => {
    const { divergent, other } = partitionByKind(dataset);
    const conPolaridad = [...divergent, ...other].filter(
      (f) => parsePolarity(f.properties.PLATEBOUND) !== null
    );
    expect(conPolaridad).toHaveLength(15);
  });
});
