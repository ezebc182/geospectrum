import { describe, expect, it } from 'vitest';
import { MIN_MARKER_RADIUS, markerRadius, markerStyle, popupArgs, truncationNotice } from './hypocenter-markers';
import type { SeismicEvent } from './types';
import { getDepthColor } from './utils';

function event(overrides: Partial<SeismicEvent>): SeismicEvent {
  return {
    id: 'us1',
    fuentes: ['USGS'],
    hora_utc: '2026-09-06T10:00:00Z',
    lat: -31.9,
    lon: -68.3,
    prof_km: 50,
    mag: 4.2,
    mag_tipo: 'ml',
    lugar: 'San Juan',
    sentido: false,
    revisado: false,
    ...overrides,
  };
}

describe('markerRadius', () => {
  it('es monótona creciente con la magnitud', () => {
    const radii = [1, 2, 3, 4, 5, 6, 7, 8].map(markerRadius);
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeGreaterThan(radii[i - 1]);
  });

  it('tiene un mínimo visible: M0, magnitud negativa y NaN nunca bajan de MIN_MARKER_RADIUS', () => {
    expect(MIN_MARKER_RADIUS).toBeGreaterThan(0);
    expect(markerRadius(0)).toBeGreaterThanOrEqual(MIN_MARKER_RADIUS);
    expect(markerRadius(-1)).toBe(MIN_MARKER_RADIUS);
    expect(markerRadius(NaN)).toBe(MIN_MARKER_RADIUS);
  });
});

describe('markerStyle', () => {
  it('con prof_km 50 el relleno es getDepthColor(50) y kind "depth"', () => {
    const style = markerStyle(event({ prof_km: 50 }));
    expect(style.kind).toBe('depth');
    expect(style.fillColor).toBe(getDepthColor(50));
    expect(style.fillOpacity).toBeGreaterThan(0);
    expect(style.radius).toBe(markerRadius(4.2));
  });

  it('con prof_km 200 usa el corte de 150-300 (los mismos que DepthDistributionChart)', () => {
    expect(markerStyle(event({ prof_km: 200 })).fillColor).toBe(getDepthColor(200));
    expect(markerStyle(event({ prof_km: 200 })).fillColor).not.toBe(getDepthColor(50));
  });

  it('prof_km null ⇒ kind "no-depth", relleno transparente, borde punteado y NO el color de <70 km (R26/M14)', () => {
    const style = markerStyle(event({ prof_km: null }));
    expect(style.kind).toBe('no-depth');
    expect(style.fillOpacity).toBe(0);
    expect(style.dashArray).toBeDefined();
    expect(style.fillColor).not.toBe(getDepthColor(0));
    expect(style.color).not.toBe(getDepthColor(0));
    expect(style.radius).toBe(markerRadius(4.2));
  });

  it('prof_km negativo (EMSC/USGS sobre el nivel del mar, real en prod) es superficial: color de <70 km', () => {
    const style = markerStyle(event({ prof_km: -35 }));
    expect(style.kind).toBe('depth');
    expect(style.fillColor).toBe(getDepthColor(0));
  });

  it('prof_km NaN se trata como sin profundidad, no como 0', () => {
    expect(markerStyle(event({ prof_km: NaN })).kind).toBe('no-depth');
  });
});

describe('truncationNotice', () => {
  it('total > shown ⇒ {total, shown}', () => {
    expect(truncationNotice(5000, 2000)).toEqual({ total: 5000, shown: 2000 });
  });

  it('total === shown ⇒ null (nada que avisar)', () => {
    expect(truncationNotice(10, 10)).toBeNull();
  });

  it('total < shown (respuesta incoherente) ⇒ null, no un aviso negativo', () => {
    expect(truncationNotice(5, 10)).toBeNull();
  });
});

describe('popupArgs', () => {
  it('lleva magnitud, profundidad, hora UTC y lugar', () => {
    expect(popupArgs(event({ prof_km: 108, mag: 4.2 }))).toEqual({
      id: 'us1',
      mag: 4.2,
      depth: 108,
      timeUtc: '2026-09-06T10:00:00Z',
      place: 'San Juan',
      magType: 'ml',
    });
  });

  it('prof_km null ⇒ depth null (el componente escribe "sin profundidad")', () => {
    expect(popupArgs(event({ prof_km: null })).depth).toBeNull();
  });

  it('lugar y mag_tipo null se conservan como null', () => {
    const args = popupArgs(event({ lugar: null, mag_tipo: null }));
    expect(args.place).toBeNull();
    expect(args.magType).toBeNull();
  });
});
