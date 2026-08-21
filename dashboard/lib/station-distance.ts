/**
 * Distancia estación ↔ ciudad para el armador (PR-W3, "la más cercana" de
 * SWARM).
 *
 * Tabla estática y no una consulta FDSN a propósito: el catálogo son 75
 * canales fijos verificados a mano (ver los comentarios de
 * spectrogram_service.py, que ya anotan varias de estas distancias), y
 * meterle una llamada de red al armador para un dato inmutable no se paga.
 * Una estación sin coordenada devuelve null: se muestra sin km, nunca con
 * un número inventado.
 */

import { HIGH_RISK_SEISMIC_CITIES } from './seismic-cities';
import type { StationCatalogEntry } from './types';

const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export function haversineKm(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const dLat = toRadians(bLat - aLat);
  // Normalizar la diferencia de longitud a [-180, 180]: sin esto, cruzar
  // el antimeridiano da 359.8° en vez de 0.2°.
  let dLonDeg = bLon - aLon;
  if (dLonDeg > 180) dLonDeg -= 360;
  if (dLonDeg < -180) dLonDeg += 360;
  const dLon = toRadians(dLonDeg);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(aLat)) * Math.cos(toRadians(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Coordenadas de las estaciones del catálogo, por código de estación.
 *
 * Resueltas UNA vez contra el FDSN station service de IRIS/EarthScope
 * (`get_stations(level="station")`) el 2026-08-21 para las 73 estaciones
 * distintas de LIVE_CANDIDATES_BY_CITY — ninguna es inventada ni derivada
 * de los comentarios del catálogo. Una estación ausente de esta tabla
 * devuelve null y se muestra sin km.
 *
 * Nota: INU aparece en el catálogo bajo dos redes (PS.INU y G.INU); es la
 * misma estación física, por eso una sola entrada.
 */
export const STATION_COORDS: Record<string, { lat: number; lon: number }> = {
  AF01: { lat: -22.952, lon: -68.1788 },
  AF02: { lat: -25.4188, lon: -70.4554 },
  ALN: { lat: 40.8957, lon: 26.0497 },
  ANTS: { lat: -0.4973, lon: -78.1704 },
  AP01: { lat: -18.3708, lon: -70.342 },
  BAR: { lat: 32.6801, lon: -116.6722 },
  BFZ: { lat: -40.6796, lon: 176.2462 },
  BOAB: { lat: 12.4493, lon: -85.6659 },
  BOIB: { lat: 49.3903, lon: -123.3788 },
  CMB: { lat: 38.0346, lon: -120.3865 },
  COOPR: { lat: 45.4573, lon: -122.869 },
  DJJ: { lat: 34.1062, lon: -118.455 },
  EVN: { lat: 27.9587, lon: 86.8117 },
  FIRE: { lat: 61.1426, lon: -150.2164 },
  FLX: { lat: 15.2339, lon: 145.7917 },
  GO02: { lat: -25.1626, lon: -69.5904 },
  GOBB: { lat: 48.9493, lon: -123.5105 },
  GRESH: { lat: 45.4753, lon: -122.4376 },
  GUMO: { lat: 13.5893, lon: 144.8684 },
  HDC: { lat: 10.002, lon: -84.1114 },
  HEL: { lat: 6.1909, lon: -75.529 },
  HIZ: { lat: -38.5129, lon: 174.8557 },
  INU: { lat: 35.35, lon: 137.029 },
  JIDR: { lat: 18.4914, lon: -71.8642 },
  JSG: { lat: 34.6777, lon: 138.183 },
  JWT: { lat: 35.2857, lon: 135.3987 },
  JYT: { lat: 36.2308, lon: 140.1907 },
  KHZ: { lat: -42.416, lon: 173.539 },
  KKN: { lat: 27.8, lon: 85.279 },
  LON: { lat: 46.7506, lon: -121.8096 },
  MAJO: { lat: 36.5457, lon: 138.2041 },
  MCCM: { lat: 38.1448, lon: -122.8802 },
  MORSE: { lat: 47.689, lon: -122.5145 },
  MT02: { lat: -33.2591, lon: -71.1377 },
  MT05: { lat: -33.3919, lon: -70.7381 },
  MT14: { lat: -33.3957, lon: -70.5362 },
  MT16: { lat: -33.4285, lon: -70.5234 },
  MT18: { lat: -33.4631, lon: -70.6644 },
  MUR: { lat: 33.6, lon: -117.1954 },
  NACB: { lat: 24.1738, lon: 121.5947 },
  NANN: { lat: 11.939, lon: -86.1213 },
  NNA: { lat: -11.9875, lon: -76.8422 },
  ODZ: { lat: -45.044, lon: 170.6446 },
  OUZ: { lat: -35.2197, lon: 173.5961 },
  PAPH1: { lat: 18.5622, lon: -72.2969 },
  PASC: { lat: 34.1714, lon: -118.1852 },
  PF27: { lat: 45.5447, lon: -122.76 },
  PLM: { lat: 33.3536, lon: -116.8627 },
  PMR: { lat: 61.5922, lon: -149.1308 },
  PULU: { lat: 0.0218, lon: -78.5022 },
  QEPB: { lat: 49.2419, lon: -123.1141 },
  RC01: { lat: 61.0889, lon: -149.739 },
  RDO: { lat: 41.145, lon: 25.5355 },
  RPZ: { lat: -43.7146, lon: 171.0539 },
  RUS: { lat: 5.8925, lon: -73.0832 },
  SAO: { lat: 36.764, lon: -121.4472 },
  SDDR: { lat: 18.9821, lon: -71.2878 },
  SLOR: { lat: -0.7298, lon: -78.4967 },
  SNZO: { lat: -41.3087, lon: 174.7043 },
  SP2: { lat: 47.5563, lon: -122.2492 },
  TATO: { lat: 24.9735, lon: 121.4971 },
  TCS1: { lat: 10.0421, lon: -84.2998 },
  TIRR: { lat: 44.4581, lon: 28.4128 },
  TLIG: { lat: 17.5627, lon: -98.5665 },
  TXMV: { lat: 20.6112, lon: -99.9309 },
  UNM: { lat: 19.3297, lon: -99.1781 },
  URZ: { lat: -38.2592, lon: 177.1109 },
  USC: { lat: 34.0192, lon: -118.2863 },
  VA01: { lat: -33.0228, lon: -71.6475 },
  VA06: { lat: -32.5612, lon: -71.2977 },
  VPCC: { lat: 10.2681, lon: -84.2046 },
  VRBA: { lat: 10.8664, lon: -85.326 },
  YHNB: { lat: 24.6695, lon: 121.3757 },
};

const CITY_BY_ID = new Map(HIGH_RISK_SEISMIC_CITIES.map((c) => [c.id, c]));

export function stationDistanceKm(entry: StationCatalogEntry): number | null {
  const station = STATION_COORDS[entry.station];
  const city = CITY_BY_ID.get(entry.city_id);
  if (!station || !city) return null;
  return Math.round(haversineKm(city.lat, city.lon, station.lat, station.lon));
}
