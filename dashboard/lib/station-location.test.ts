import { describe, expect, it } from 'vitest';

import { resolveStationLocation } from './station-location';
import type { CatalogStation } from './station-search';

const CATALOG: CatalogStation[] = [
  {
    channel: 'CI.USC..BHZ',
    city_id: 'losangeles',
    network: 'CI',
    station: 'USC',
    is_live: true,
    is_primary: true,
  },
  {
    channel: 'XX.FANTASMA..BHZ',
    city_id: 'ciudad-que-no-existe',
    network: 'XX',
    station: 'FANTASMA',
    is_live: false,
    is_primary: false,
  },
];

describe('resolveStationLocation — orientación geográfica del detalle', () => {
  it('resuelve nombre, país y coordenadas de una estación del catálogo', () => {
    const loc = resolveStationLocation(CATALOG, 'CI.USC..BHZ');
    expect(loc).not.toBeNull();
    expect(loc?.name).toBe('Los Angeles');
    // 'USA' es el valor literal de seismic-cities.ts — la fuente manda.
    expect(loc?.country).toBe('USA');
    // Coordenadas a nivel CIUDAD (el catálogo no trae las de la estación):
    // alcanza para orientar, no para geolocalizar el sensor.
    expect(loc?.latitude).toBeCloseTo(34.05, 1);
    expect(loc?.longitude).toBeCloseTo(-118.24, 1);
  });

  it('devuelve null para un canal fuera del catálogo (búsqueda FDSN)', () => {
    expect(resolveStationLocation(CATALOG, 'IU.MAJO.00.BHZ')).toBeNull();
  });

  it('devuelve null si la ciudad del catálogo no existe en seismic-cities', () => {
    expect(resolveStationLocation(CATALOG, 'XX.FANTASMA..BHZ')).toBeNull();
  });

  it('devuelve null sin catálogo cargado (SWR todavía en vuelo)', () => {
    expect(resolveStationLocation(undefined, 'CI.USC..BHZ')).toBeNull();
  });
});
