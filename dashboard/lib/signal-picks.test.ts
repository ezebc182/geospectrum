/**
 * Espejo EXACTO de tests/unit/test_signal_picks_formulas.py: mismos valores
 * esperados calculados a mano. Si las dos implementaciones divergen, los dos
 * tests no pueden estar verdes a la vez.
 */

import { describe, expect, it } from 'vitest';

import {
  CODA_A,
  CODA_B,
  P_VELOCITY_KM_S,
  S_VELOCITY_KM_S,
  VP_VS_RATIO,
  codaMagnitude,
  spDistanceKm,
} from '@/lib/signal-picks';

describe('constantes desde el JSON compartido', () => {
  it('expone las cuatro constantes del JSON', () => {
    expect(P_VELOCITY_KM_S).toBe(6.0);
    expect(VP_VS_RATIO).toBe(1.73);
    expect(CODA_A).toBe(1.86);
    expect(CODA_B).toBe(-0.85);
  });

  it('deriva vs de vp y el ratio, no la declara', () => {
    expect(S_VELOCITY_KM_S).toBeCloseTo(P_VELOCITY_KM_S / VP_VS_RATIO, 10);
  });
});

describe('spDistanceKm — d = sp·(vp·vs)/(vp-vs)', () => {
  it('S-P de 10.0 s ⇒ 82.1918 km', () => {
    expect(spDistanceKm(10.0)).toBeCloseTo(82.1918, 3);
  });

  it('S-P de 5.0 s ⇒ 41.0959 km', () => {
    expect(spDistanceKm(5.0)).toBeCloseTo(41.0959, 3);
  });

  it('S-P de 1.0 s ⇒ 8.2192 km', () => {
    expect(spDistanceKm(1.0)).toBeCloseTo(8.2192, 3);
  });

  it('S-P de 0 ⇒ null', () => {
    expect(spDistanceKm(0)).toBeNull();
  });

  it('S-P negativo ⇒ null (sin la guarda daría -24.657, serializable)', () => {
    expect(spDistanceKm(-3.0)).toBeNull();
  });

  it('S-P NaN ⇒ null', () => {
    expect(spDistanceKm(Number.NaN)).toBeNull();
  });

  it('S-P Infinity ⇒ null', () => {
    expect(spDistanceKm(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('codaMagnitude — Mc = 1.86·log10(t) - 0.85', () => {
  it('coda de 100 s ⇒ 2.87', () => {
    expect(codaMagnitude(100.0)).toBeCloseTo(2.87, 6);
  });

  it('coda de 10 s ⇒ 1.01', () => {
    expect(codaMagnitude(10.0)).toBeCloseTo(1.01, 6);
  });

  it('coda de 1 s ⇒ -0.85 (negativo y correcto, no se recorta a cero)', () => {
    expect(codaMagnitude(1.0)).toBeCloseTo(-0.85, 6);
  });

  it('coda de 60 s ⇒ 2.4574 (detecta log natural o atajo por dígitos)', () => {
    expect(codaMagnitude(60.0)).toBeCloseTo(2.4574, 4);
  });

  it('coda de 0 ⇒ null (sin la guarda propaga -Infinity)', () => {
    expect(codaMagnitude(0)).toBeNull();
  });

  it('coda negativa ⇒ null (sin la guarda propaga NaN)', () => {
    expect(codaMagnitude(-5.0)).toBeNull();
  });

  it('coda NaN ⇒ null', () => {
    expect(codaMagnitude(Number.NaN)).toBeNull();
  });

  it('coda Infinity ⇒ null', () => {
    expect(codaMagnitude(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
