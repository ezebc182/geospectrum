import { describe, expect, it } from 'vitest';

import {
  SPECTROGRAM_FREQ_MAX,
  SPECTROGRAM_FREQ_MIN,
  SPECTROGRAM_FREQ_TICKS,
  freqTickOffset,
} from '@/lib/spectrogram-axis';

describe('freqTickOffset', () => {
  it('pone los extremos del eje en los bordes', () => {
    expect(freqTickOffset(SPECTROGRAM_FREQ_MAX)).toBe(0);
    expect(freqTickOffset(SPECTROGRAM_FREQ_MIN)).toBe(100);
  });

  it('posiciona 10 Hz a mitad de altura, como manda un eje lineal', () => {
    // (10 - 0.1) / (20 - 0.1) = 0.497 desde abajo → 50.25% desde arriba.
    expect(freqTickOffset(10)).toBeCloseTo(50.25, 1);
  });

  it('posiciona 5 Hz a tres cuartos y no a la mitad', () => {
    // LA aserción que separa el eje lineal del logarítmico: con el
    // `justify-between` viejo esta marca caía al 50%, 25 puntos más arriba de
    // donde la dibuja matplotlib.
    expect(freqTickOffset(5)).toBeCloseTo(75.38, 1);
    expect(freqTickOffset(5)).toBeGreaterThan(freqTickOffset(10));
  });

  it('mantiene el orden: más frecuencia, más arriba', () => {
    const offsets = SPECTROGRAM_FREQ_TICKS.map(freqTickOffset);

    for (let i = 1; i < offsets.length; i += 1) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    }
  });

  it('clampea las marcas fuera de rango al recuadro', () => {
    // Una marca mal configurada no debe dibujarse fuera del contenedor.
    expect(freqTickOffset(50)).toBe(0);
    expect(freqTickOffset(0)).toBe(100);
  });

  it('no amontona dos marcas en el mismo punto', () => {
    // El motivo de cambiar la escala 20/10/5/1/0.1: en un eje lineal 1 Hz cae
    // al 95.5% y 0.1 Hz al 100%, ilegibles una encima de la otra.
    const offsets = SPECTROGRAM_FREQ_TICKS.map(freqTickOffset);

    for (let i = 1; i < offsets.length; i += 1) {
      expect(offsets[i] - offsets[i - 1]).toBeGreaterThan(3);
    }
  });
});
