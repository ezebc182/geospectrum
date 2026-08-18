import { describe, it, expect } from 'vitest';
import {
  percentile,
  scaleFromHistory,
  updateScale,
  sliceToWidth,
} from './spectrogram-scale';

describe('percentile', () => {
  it('interpola linealmente sobre un array ordenado', () => {
    expect(percentile([0, 10], 0.5)).toBe(5);
    expect(percentile([0, 10, 20, 30, 40], 0.25)).toBe(10);
  });

  it('en los extremos devuelve min y max', () => {
    expect(percentile([3, 7, 9], 0)).toBe(3);
    expect(percentile([3, 7, 9], 1)).toBe(9);
  });
});

describe('scaleFromHistory', () => {
  it('sin columnas devuelve null', () => {
    expect(scaleFromHistory([])).toBeNull();
    expect(scaleFromHistory([[]])).toBeNull();
  });

  it('calcula percentiles GLOBALES, no por columna', () => {
    // Una columna calma (todo -100) y una fuerte (todo 0): la escala global
    // abarca ambas. Normalizando por columna, las dos darían el mismo rango
    // y se verían idénticas — que es el bug que motivó este módulo.
    const scale = scaleFromHistory([Array(100).fill(-100), Array(100).fill(0)]);
    expect(scale).not.toBeNull();
    expect(scale!.vmin).toBeCloseTo(-100, 0);
    expect(scale!.vmax).toBeCloseTo(0, 0);
  });

  it('con la escala global, la columna calma queda oscura y la fuerte brillante', () => {
    const quiet = Array(100).fill(-100);
    const loud = Array(100).fill(0);
    const scale = scaleFromHistory([quiet, loud])!;
    const range = scale.vmax - scale.vmin;
    const tQuiet = (quiet[0] - scale.vmin) / range;
    const tLoud = (loud[0] - scale.vmin) / range;
    expect(tQuiet).toBeLessThan(0.1);
    expect(tLoud).toBeGreaterThan(0.9);
  });
});

describe('updateScale', () => {
  it('deriva lento hacia la columna nueva sin saltar', () => {
    const scale = { vmin: -100, vmax: -50 };
    const updated = updateScale(scale, Array(100).fill(0), 0.02);
    // Con alpha 0.02 el techo se mueve apenas 2% del salto: un sismo no se
    // come su propio contraste recalibrando la escala de golpe.
    expect(updated.vmax).toBeCloseTo(-49, 0);
    expect(updated.vmax).toBeLessThan(-45);
  });

  it('no muta la escala original', () => {
    const scale = { vmin: -100, vmax: -50 };
    updateScale(scale, [0, 0, 0]);
    expect(scale).toEqual({ vmin: -100, vmax: -50 });
  });

  it('columna vacía deja la escala como estaba', () => {
    const scale = { vmin: -100, vmax: -50 };
    expect(updateScale(scale, [])).toEqual(scale);
  });

  it('tras muchas columnas converge al rango nuevo', () => {
    let scale = { vmin: -100, vmax: -50 };
    for (let i = 0; i < 500; i++) {
      scale = updateScale(scale, [-80, -70, -60, -50, -40, -30, -20, -10]);
    }
    expect(scale.vmin).toBeGreaterThan(-90);
    expect(scale.vmax).toBeGreaterThan(-20);
  });
});

describe('sliceToWidth', () => {
  it('devuelve todo si entra en el ancho', () => {
    expect(sliceToWidth([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it('recorta quedándose con las ÚLTIMAS columnas (las más recientes)', () => {
    expect(sliceToWidth([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
  });
});
