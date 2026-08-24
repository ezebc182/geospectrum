import { describe, expect, it } from 'vitest';
import { fullViewport, zoomTime, type Viewport } from './spectrogram-viewport';

const LIMITS: Viewport = { fMin: 0, fMax: 20, startMs: 1_000_000, endMs: 2_000_000 };

describe('fullViewport', () => {
  it('arranca mostrando todo el dominio del dato', () => {
    const v = fullViewport({ fMin: 0, fMax: 20, mixedGrid: false }, { startMs: 1_000_000, endMs: 2_000_000 });
    expect(v).toEqual({ fMin: 0, fMax: 20, startMs: 1_000_000, endMs: 2_000_000 });
  });
});

describe('zoomTime', () => {
  it('acerca reduciendo el span a la mitad con factor 0.5', () => {
    const v = zoomTime(LIMITS, 0.5, 0.5, LIMITS);
    expect(v.endMs - v.startMs).toBe(500_000);
  });

  it('mantiene bajo el cursor el instante que estaba bajo el cursor', () => {
    // El punto al 25% del ancho es 1_250_000. Tras el zoom debe seguir al 25%.
    const v = zoomTime(LIMITS, 0.5, 0.25, LIMITS);
    const instanteAl25 = v.startMs + (v.endMs - v.startMs) * 0.25;
    expect(instanteAl25).toBeCloseTo(1_250_000, 0);
  });

  it('no deja alejarse más allá del dominio del dato', () => {
    const v = zoomTime(LIMITS, 4, 0.5, LIMITS);
    expect(v.startMs).toBe(LIMITS.startMs);
    expect(v.endMs).toBe(LIMITS.endMs);
  });

  it('no deja acercarse por debajo del span mínimo', () => {
    let v: Viewport = LIMITS;
    // 20 zooms de 0.5 llevarían el span a menos de 1 ms sin el piso.
    for (let i = 0; i < 20; i++) v = zoomTime(v, 0.5, 0.5, LIMITS);
    expect(v.endMs - v.startMs).toBeGreaterThanOrEqual(1000);
  });

  it('al llegar al borde derecho no se corre fuera del dominio', () => {
    const v = zoomTime(LIMITS, 0.5, 1, LIMITS);
    expect(v.endMs).toBeLessThanOrEqual(LIMITS.endMs);
    expect(v.startMs).toBeGreaterThanOrEqual(LIMITS.startMs);
  });
});
