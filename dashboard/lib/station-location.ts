/**
 * Orientación geográfica del detalle de estación.
 *
 * El catálogo no trae coordenadas (verificado: station_catalog devuelve
 * channel/city_id/network/station/is_live/is_primary) — se resuelven vía
 * ciudad: channel → catálogo → city_id → seismic-cities. La precisión es a
 * nivel CIUDAD: alcanza para orientar al operador ("esto es Los Ángeles"),
 * no para geolocalizar el sensor.
 *
 * Una estación fuera del catálogo (llegada por el buscador FDSN) devuelve
 * null y la UI no muestra nada: mejor ausencia honesta que un mapa apuntando
 * a cualquier lado.
 */

import { getCityById } from './seismic-cities';
import type { CatalogStation } from './station-search';

export interface StationLocation {
  name: string;
  country: string;
  latitude: number;
  longitude: number;
}

export function resolveStationLocation(
  catalog: CatalogStation[] | undefined,
  channel: string,
): StationLocation | null {
  const entry = catalog?.find((c) => c.channel === channel);
  if (!entry) return null;
  const city = getCityById(entry.city_id);
  if (!city) return null;
  return {
    name: city.name,
    country: city.country,
    latitude: city.lat,
    longitude: city.lon,
  };
}
