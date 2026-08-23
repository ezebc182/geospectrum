/**
 * Búsqueda de estaciones: filtrado del catálogo local y decisión de cuándo
 * consultar FDSN.
 *
 * El buscador es híbrido y a propósito no tiene selector de modo:
 *
 * - El CATÁLOGO (75 candidatas de las 27 ciudades del muro) se filtra en el
 *   cliente. Es instantáneo y —esto es lo importante— permite buscar por
 *   NOMBRE DE CIUDAD ("tokyo", "santiago"), que es justo lo que FDSN no
 *   puede hacer.
 * - FDSN llega a cualquier estación del mundo, pero SÓLO por código de
 *   estación. Verificado contra IRIS el 2026-08-23: `*USC*` devuelve 3
 *   estaciones, `NEV*` devuelve 204. El nombre del sitio viaja en la
 *   respuesta pero no es filtrable.
 *
 * Por eso las dos fuentes se muestran juntas: cada una cubre el agujero de la
 * otra.
 */

/** Entrada de `GET /spectrograms/station-catalog`. */
export interface CatalogStation {
  channel: string;
  city_id: string;
  network: string;
  station: string;
  is_live: boolean;
  is_primary: boolean;
}

/** Entrada de `GET /stations/search` (FDSN). */
export interface FdsnStation {
  channel: string;
  network: string;
  station: string;
  site_name: string | null;
  latitude: number | null;
  longitude: number | null;
  source_server: string | null;
}

export interface CityGroup {
  cityId: string;
  stations: CatalogStation[];
}

/**
 * Espeja `is_searchable_code` de `src/services/station_search.py`.
 *
 * Se duplica la regla en vez de preguntarle al backend porque la respuesta
 * tiene que ser inmediata en cada tecla: una ida y vuelta para saber si vale
 * la pena hacer una ida y vuelta no tiene sentido. Si la regla cambia allá,
 * hay que cambiarla acá — los tests de ambos lados usan los mismos casos.
 */
export function shouldQueryFdsn(term: string): boolean {
  const cleaned = term.trim();
  if (cleaned.length < 2 || cleaned.length > 5) return false;
  return /^[a-zA-Z0-9]+$/.test(cleaned);
}

/**
 * Filtra el catálogo por código de red, de estación, SCNL o nombre de ciudad.
 *
 * Un término vacío devuelve todo: el estado inicial del buscador muestra el
 * catálogo entero, no una pantalla en blanco.
 */
export function filterCatalog(catalog: CatalogStation[], term: string): CatalogStation[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return catalog;

  return catalog.filter((s) => {
    const haystack = `${s.channel} ${s.network} ${s.station} ${s.city_id}`.toLowerCase();
    return haystack.includes(needle);
  });
}

/**
 * Agrupa por ciudad, con la primaria arriba de cada grupo y las ciudades en
 * orden alfabético.
 *
 * La primaria es la que el muro eligió como representante de esa ciudad, así
 * que es la que el usuario espera encontrar primero.
 */
export function groupByCity(stations: CatalogStation[]): CityGroup[] {
  const byCity = new Map<string, CatalogStation[]>();

  for (const station of stations) {
    const bucket = byCity.get(station.city_id);
    if (bucket) {
      bucket.push(station);
    } else {
      byCity.set(station.city_id, [station]);
    }
  }

  return Array.from(byCity.entries())
    .map(([cityId, group]) => ({
      cityId,
      stations: [...group].sort((a, b) => {
        if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
        return a.station.localeCompare(b.station);
      }),
    }))
    .sort((a, b) => a.cityId.localeCompare(b.cityId));
}
