import { describe, expect, it } from 'vitest';

import { haversineKm, stationDistanceKm } from './station-distance';

describe('haversineKm', () => {
  it('la distancia de un punto a sí mismo es cero', () => {
    expect(haversineKm(-33.4489, -70.6693, -33.4489, -70.6693)).toBe(0);
  });

  it('calcula una distancia conocida (Santiago–Valparaíso ≈ 100 km)', () => {
    const km = haversineKm(-33.4489, -70.6693, -33.0472, -71.6127);
    expect(km).toBeGreaterThan(90);
    expect(km).toBeLessThan(110);
  });

  it('es simétrica', () => {
    const ida = haversineKm(35.6762, 139.6503, -33.4489, -70.6693);
    const vuelta = haversineKm(-33.4489, -70.6693, 35.6762, 139.6503);
    expect(Math.abs(ida - vuelta)).toBeLessThan(0.001);
  });

  it('cruza el antimeridiano por el lado corto', () => {
    // 179.9E a 179.9W son 0.2 grados de longitud, ~22 km en el ecuador,
    // NO 359.8 grados. Es el bug clásico de restar longitudes a lo bruto.
    const km = haversineKm(0, 179.9, 0, -179.9);
    expect(km).toBeLessThan(50);
  });
});

describe('stationDistanceKm', () => {
  const entry = {
    channel: 'C1.VA01..BHZ',
    city_id: 'valparaiso',
    network: 'C1',
    station: 'VA01',
    is_live: true,
    is_primary: true,
  };

  it('devuelve los km entre la estación y su ciudad', () => {
    const km = stationDistanceKm(entry);
    expect(km).not.toBeNull();
    expect(km!).toBeLessThan(20); // VA01 está a ~4 km de Valparaíso
  });

  it('sin coordenada de la estación devuelve null (nunca un número inventado)', () => {
    expect(stationDistanceKm({ ...entry, channel: 'XX.NADA..HHZ', station: 'NADA' })).toBeNull();
  });

  it('sin ciudad conocida devuelve null', () => {
    expect(stationDistanceKm({ ...entry, city_id: 'atlantis' })).toBeNull();
  });
});
