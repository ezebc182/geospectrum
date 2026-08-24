/**
 * Eje de frecuencia del espectrograma grande (PR B).
 *
 * Los casos de acá NO son inventados: salen de consultar la tabla
 * `spectrogram_columns` en local (2026-08-22). El eje cambia por canal y hasta
 * dentro del mismo canal:
 *
 *   AK.FIRE..BHZ  | 65 bins | f_min 0    | paso 0.39 | f_max 25
 *   AK.FIRE..BHZ  | 80 bins | f_min 0.25 | paso 0.25 | f_max 20
 *   BK.CMB.00.BHZ | 65 bins | f_min 0    | paso 0.31 | f_max 20
 *   CN.BOIB..HHZ  | 40 bins | f_min 0.25 | paso 0.25 | f_max 10
 *
 * Por eso el eje se deriva del array `freqs` recibido y no de una constante:
 * un eje fijo a 20 Hz dibujaría el DOBLE de rango del que hay en BOIB. Ya pasó
 * una vez en este proyecto (ver el docstring de `spectrogram-axis.ts`, donde
 * las marcas mentían hasta 25 puntos porcentuales).
 */

import { describe, expect, it } from 'vitest';
import {
  frequencyAxis,
  freqToFraction,
  niceFrequencyTicks,
} from './spectrogram-frequency-axis';

/** Grilla como la arma el backend: lineal, de f_min a f_max. */
function grid(nbins: number, fMin: number, fMax: number): number[] {
  if (nbins === 1) return [fMin];
  const paso = (fMax - fMin) / (nbins - 1);
  return Array.from({ length: nbins }, (_, i) => fMin + i * paso);
}

describe('frequencyAxis', () => {
  it('deriva el rango del dato, no de una constante — caso BOIB (10 Hz)', () => {
    const axis = frequencyAxis([grid(40, 0.25, 10)]);
    expect(axis.fMin).toBeCloseTo(0.25);
    expect(axis.fMax).toBeCloseTo(10);
  });

  it('el mismo código da 25 Hz en un canal que llega a 25 — caso AK.FIRE', () => {
    const axis = frequencyAxis([grid(65, 0, 25)]);
    expect(axis.fMax).toBeCloseTo(25);
    expect(axis.fMin).toBeCloseTo(0);
  });

  it('con grillas mixtas cubre el rango de TODAS las columnas', () => {
    // AK.FIRE tiene columnas de 65 bins (0..25) y de 80 (0.25..20): el eje
    // tiene que abarcar 0..25 o alguna columna se dibujaría fuera del recuadro.
    const axis = frequencyAxis([grid(65, 0, 25), grid(80, 0.25, 20)]);
    expect(axis.fMin).toBeCloseTo(0);
    expect(axis.fMax).toBeCloseTo(25);
    expect(axis.mixedGrid).toBe(true);
  });

  it('marca mixedGrid en false cuando todas las columnas comparten grilla', () => {
    const g = grid(40, 0.25, 10);
    expect(frequencyAxis([g, [...g], [...g]]).mixedGrid).toBe(false);
  });

  it('sin columnas devuelve un eje válido en vez de NaN', () => {
    const axis = frequencyAxis([]);
    expect(Number.isFinite(axis.fMin)).toBe(true);
    expect(Number.isFinite(axis.fMax)).toBe(true);
    expect(axis.fMax).toBeGreaterThan(axis.fMin);
  });

  it('una columna de un solo bin no produce un eje de altura cero', () => {
    // fMax === fMin haría una división por cero al mapear a píxeles.
    const axis = frequencyAxis([[5]]);
    expect(axis.fMax).toBeGreaterThan(axis.fMin);
  });

  it('ignora valores no finitos en vez de propagarlos al eje', () => {
    const axis = frequencyAxis([[0.25, NaN, 5, Infinity, 10]]);
    expect(axis.fMin).toBeCloseTo(0.25);
    expect(axis.fMax).toBeCloseTo(10);
  });
});

describe('freqToFraction', () => {
  const axis = { fMin: 0.25, fMax: 10, mixedGrid: false };

  it('el tope del eje va arriba (0) y el piso abajo (1) — el eje crece hacia arriba', () => {
    expect(freqToFraction(10, axis)).toBeCloseTo(0);
    expect(freqToFraction(0.25, axis)).toBeCloseTo(1);
  });

  it('es lineal: el punto medio en Hz cae en la mitad del alto', () => {
    // El backend NO usa escala log en estas columnas (grilla equiespaciada).
    expect(freqToFraction((0.25 + 10) / 2, axis)).toBeCloseTo(0.5);
  });

  it('clampea fuera de rango en vez de dibujar afuera del recuadro', () => {
    expect(freqToFraction(999, axis)).toBe(0);
    expect(freqToFraction(-5, axis)).toBe(1);
  });
});

describe('niceFrequencyTicks', () => {
  it('todas las marcas caen dentro del rango real del eje', () => {
    for (const [lo, hi] of [
      [0.25, 10],
      [0, 25],
      [0.25, 20],
    ]) {
      const ticks = niceFrequencyTicks(lo, hi);
      expect(ticks.length).toBeGreaterThan(1);
      for (const t of ticks) {
        expect(t, `eje ${lo}..${hi}`).toBeGreaterThanOrEqual(lo);
        expect(t, `eje ${lo}..${hi}`).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('las marcas son valores redondos y van de menor a mayor', () => {
    const ticks = niceFrequencyTicks(0, 25);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
    // Nada de 3.7142857 en un eje que mira un humano.
    for (const t of ticks) {
      expect(Number(t.toFixed(2)), `tick ${t}`).toBe(t);
    }
  });

  it('un eje chico no devuelve una sola marca ni cientos', () => {
    const ticks = niceFrequencyTicks(0.25, 10);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks.length).toBeLessThanOrEqual(12);
  });

  it('un rango degenerado no cuelga el render', () => {
    expect(() => niceFrequencyTicks(5, 5)).not.toThrow();
    expect(niceFrequencyTicks(5, 5).length).toBeGreaterThan(0);
  });
});
