import { describe, expect, it } from 'vitest';

import {
  filterCatalog,
  groupByCity,
  shouldQueryFdsn,
  type CatalogStation,
} from './station-search';

const CATALOG: CatalogStation[] = [
  {
    channel: 'CI.USC..BHZ',
    city_id: 'losangeles',
    network: 'CI',
    station: 'USC',
    is_live: false,
    is_primary: true,
  },
  {
    channel: 'IU.MAJO.00.BHZ',
    city_id: 'tokyo',
    network: 'IU',
    station: 'MAJO',
    is_live: true,
    is_primary: false,
  },
  {
    channel: 'JP.JYT..BHZ',
    city_id: 'tokyo',
    network: 'JP',
    station: 'JYT',
    is_live: false,
    is_primary: true,
  },
  {
    channel: 'C1.CO01..HHZ',
    city_id: 'santiago',
    network: 'C1',
    station: 'CO01',
    is_live: false,
    is_primary: true,
  },
];

describe('filterCatalog', () => {
  it('sin término devuelve el catálogo entero', () => {
    expect(filterCatalog(CATALOG, '')).toHaveLength(4);
    expect(filterCatalog(CATALOG, '   ')).toHaveLength(4);
  });

  it('filtra por código de estación', () => {
    const result = filterCatalog(CATALOG, 'usc');
    expect(result.map((s) => s.channel)).toEqual(['CI.USC..BHZ']);
  });

  it('filtra por código de red', () => {
    const result = filterCatalog(CATALOG, 'JP');
    expect(result.map((s) => s.station)).toEqual(['JYT']);
  });

  it('filtra por nombre de ciudad', () => {
    // Este es el caso que FDSN NO puede hacer (no indexa nombres de sitio) y
    // por eso el catálogo local es imprescindible, no un mero atajo.
    const result = filterCatalog(CATALOG, 'tokyo');
    expect(result.map((s) => s.station).sort()).toEqual(['JYT', 'MAJO']);
  });

  it('filtra por el SCNL completo', () => {
    const result = filterCatalog(CATALOG, 'C1.CO01');
    expect(result.map((s) => s.channel)).toEqual(['C1.CO01..HHZ']);
  });

  it('ignora mayúsculas y minúsculas', () => {
    expect(filterCatalog(CATALOG, 'MaJo')).toHaveLength(1);
    expect(filterCatalog(CATALOG, 'SANTIAGO')).toHaveLength(1);
  });

  it('recorta espacios alrededor del término', () => {
    expect(filterCatalog(CATALOG, '  usc  ')).toHaveLength(1);
  });

  it('sin coincidencias devuelve lista vacía', () => {
    expect(filterCatalog(CATALOG, 'zzzz')).toEqual([]);
  });
});

describe('shouldQueryFdsn', () => {
  // Espeja is_searchable_code del backend (src/services/station_search.py).
  // Si divergen, el frontend dispara consultas que el backend rechaza con 422
  // o —peor— se calla búsquedas que sí habrían dado resultados.

  it('acepta códigos plausibles de 2 a 5 caracteres', () => {
    for (const term of ['ab', 'usc', 'MAJO', 'R195D', '113A']) {
      expect(shouldQueryFdsn(term), term).toBe(true);
    }
  });

  it('rechaza términos de menos de 2 o más de 5 caracteres', () => {
    for (const term of ['', 'a', 'nevado', 'santiago']) {
      expect(shouldQueryFdsn(term), term).toBe(false);
    }
  });

  it('rechaza términos con caracteres no alfanuméricos', () => {
    // Entran por longitud pero no son códigos: mandarlos sería gastar ~1,2 s
    // de red para nada. El backend los rechaza igual.
    for (const term of ['US.', 'a b', 'U-C', 'CI..', 'US*']) {
      expect(shouldQueryFdsn(term), term).toBe(false);
    }
  });

  it('ignora espacios alrededor', () => {
    expect(shouldQueryFdsn('  usc  ')).toBe(true);
  });
});

describe('groupByCity', () => {
  it('agrupa las estaciones por ciudad', () => {
    const groups = groupByCity(CATALOG);
    const tokyo = groups.find((g) => g.cityId === 'tokyo');

    expect(tokyo?.stations).toHaveLength(2);
  });

  it('pone la primaria primero dentro de cada ciudad', () => {
    // La primaria es la que el muro eligió como representante: es la que el
    // usuario espera ver arriba.
    const groups = groupByCity(CATALOG);
    const tokyo = groups.find((g) => g.cityId === 'tokyo');

    expect(tokyo?.stations[0].station).toBe('JYT');
    expect(tokyo?.stations[0].is_primary).toBe(true);
  });

  it('ordena las ciudades alfabéticamente', () => {
    const groups = groupByCity(CATALOG);
    expect(groups.map((g) => g.cityId)).toEqual(['losangeles', 'santiago', 'tokyo']);
  });

  it('con lista vacía devuelve lista vacía', () => {
    expect(groupByCity([])).toEqual([]);
  });
});
