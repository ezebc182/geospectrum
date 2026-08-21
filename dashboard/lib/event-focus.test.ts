import { describe, expect, it } from 'vitest';
import { FOCUS_POOL_SIZE, pickSpotlight, readFocusMode } from './event-focus';
import type { SeismicEvent } from './types';

const ev = (id: string, horaUtc: string, mag = 4): SeismicEvent => ({
  id,
  fuentes: ['usgs'],
  hora_utc: horaUtc,
  lat: 0,
  lon: 0,
  prof_km: 10,
  mag,
  mag_tipo: 'mb',
  lugar: null,
  sentido: false,
  revisado: false,
});

describe('pickSpotlight modo random', () => {
  it('elige entre los MÁS RECIENTES (no por magnitud) sin repetir el anterior', () => {
    // 30 eventos: los 20 más nuevos son el pool aunque los viejos tengan más magnitud
    const eventos = Array.from({ length: 30 }, (_, i) =>
      ev(`e${i}`, `2026-08-20T${String(i % 24).padStart(2, '0')}:00:00Z`, i < 10 ? 8 : 4)
    ).sort((a, b) => (a.hora_utc < b.hora_utc ? 1 : -1));
    const pool = eventos.slice(0, FOCUS_POOL_SIZE).map((e) => e.id);

    const picked = pickSpotlight('random', eventos, 'e5', () => 0.99);
    expect(picked).not.toBeNull();
    expect(pool).toContain(picked!.id);
    expect(picked!.id).not.toBe('e5');
  });

  it('con un solo evento lo devuelve aunque sea el anterior', () => {
    const only = [ev('solo', '2026-08-20T10:00:00Z')];
    expect(pickSpotlight('random', only, 'solo', () => 0)!.id).toBe('solo');
  });

  it('mata mutación: filtra lastId aunque rand() lo seleccione directamente', () => {
    // Pool de 3 eventos, si rand retorna 0.33 (índice 0 sin filtro)
    // y e0 es lastId, el filtro lo saca y quedan 2 candidatos
    // esperamos que NO devuelva e0
    const eventos = [
      ev('e0', '2026-08-20T03:00:00Z'),
      ev('e1', '2026-08-20T02:00:00Z'),
      ev('e2', '2026-08-20T01:00:00Z'),
    ].sort((a, b) => (a.hora_utc < b.hora_utc ? 1 : -1));

    const picked = pickSpotlight('random', eventos, 'e0', () => 0.33);
    expect(picked).not.toBeNull();
    expect(picked!.id).not.toBe('e0');
  });

  it('rand() = 1 no causa out-of-bounds', () => {
    const eventos = [
      ev('e0', '2026-08-20T02:00:00Z'),
      ev('e1', '2026-08-20T01:00:00Z'),
    ];
    const picked = pickSpotlight('random', eventos, null, () => 1);
    expect(picked).not.toBeNull();
    expect([eventos[0]!.id, eventos[1]!.id]).toContain(picked!.id);
  });
});

describe('pickSpotlight modo latest', () => {
  it('devuelve el más nuevo por hora_utc', () => {
    const eventos = [
      ev('viejo', '2026-08-20T01:00:00Z', 8),
      ev('nuevo', '2026-08-20T23:00:00Z', 3),
    ];
    expect(pickSpotlight('latest', eventos, null, () => 0)!.id).toBe('nuevo');
  });

  it('si el más nuevo ya es el enfocado, devuelve null (la cámara NO se mueve)', () => {
    const eventos = [ev('nuevo', '2026-08-20T23:00:00Z')];
    expect(pickSpotlight('latest', eventos, 'nuevo', () => 0)).toBeNull();
  });

  it('descarta eventos sin coordenadas finitas aunque sean los más nuevos', () => {
    const sinCoords = { ...ev('sin-coords', '2026-08-20T23:00:00Z'), lat: NaN };
    const eventos = [ev('viejo', '2026-08-20T01:00:00Z'), sinCoords];
    expect(pickSpotlight('latest', eventos, null, () => 0)!.id).toBe('viejo');
  });
});

describe('readFocusMode', () => {
  it('el query param gana sobre lo guardado', () => {
    expect(readFocusMode('?focus=latest', 'random')).toBe('latest');
  });
  it('sin query usa lo guardado; sin nada, random', () => {
    expect(readFocusMode('', 'latest')).toBe('latest');
    expect(readFocusMode('', null)).toBe('random');
    expect(readFocusMode('?focus=cualquiercosa', null)).toBe('random');
  });
});
