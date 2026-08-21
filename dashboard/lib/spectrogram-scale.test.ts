import { describe, it, expect } from 'vitest';
import {
  SWARM_MAX_POWER_DB,
  SWARM_MIN_POWER_DB,
  powerDbToT,
  sliceToWidth,
  historyMinutesForWidth,
} from './spectrogram-scale';

describe('escala fija SWARM', () => {
  it('usa el rango 20-120 dB de WaveDefaults.config de SWARM', () => {
    // Paridad con el backend (src/services/swarm_spectra.py): el rojo del
    // colormap significa 120 dB reales, no "el 5% más alto de la imagen".
    expect(SWARM_MIN_POWER_DB).toBe(20);
    expect(SWARM_MAX_POWER_DB).toBe(120);
  });

  it('mapea dB al [0,1] de la paleta linealmente', () => {
    expect(powerDbToT(20)).toBe(0);
    expect(powerDbToT(70)).toBe(0.5);
    expect(powerDbToT(120)).toBe(1);
  });

  it('fuera de rango satura en los extremos de la paleta', () => {
    // El piso de ruido de un canal calmo (< 20 dB) queda plano en el azul
    // marino; un evento saturado (> 120 dB) queda plano en el rojo oscuro.
    expect(powerDbToT(-40)).toBe(0);
    expect(powerDbToT(150)).toBe(1);
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

describe('historyMinutesForWidth', () => {
  it('pide los minutos que el ancho del canvas puede mostrar', () => {
    // Peor caso: una columna cada 8s, 1px por columna. Un canvas de 400px
    // muestra ~54 min; pedir 60 fijos para una tira de 240px tiraba 3/4
    // del payload (importa con ~74 tiras montadas en el muro).
    expect(historyMinutesForWidth(400)).toBe(54);
    expect(historyMinutesForWidth(240)).toBe(32);
  });

  it('nunca pide menos de 1 minuto', () => {
    expect(historyMinutesForWidth(4)).toBe(1);
  });
});
