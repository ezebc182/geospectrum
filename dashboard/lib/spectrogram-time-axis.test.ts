/**
 * Eje de tiempo y colorbar del espectrograma grande (PR B).
 *
 * Las columnas llegan con `endtime` ISO y NO están garantizadas ni parejas ni
 * contiguas: el ingestor puede haber tenido huecos. El eje se arma sobre el
 * tiempo real de las columnas, no sobre su índice.
 */

import { describe, expect, it } from 'vitest';
import {
  colorbarStops,
  niceTimeTicks,
  timeAxis,
  timeToFraction,
} from './spectrogram-time-axis';

const T0 = Date.parse('2026-08-21T04:00:00Z');
const MIN = 60_000;

function cols(...offsetsMin: number[]) {
  return offsetsMin.map((m) => new Date(T0 + m * MIN).toISOString());
}

describe('timeAxis', () => {
  it('toma el rango real de las columnas, no su cantidad', () => {
    const axis = timeAxis(cols(0, 10, 30));
    expect(axis.startMs).toBe(T0);
    expect(axis.endMs).toBe(T0 + 30 * MIN);
  });

  it('no asume que vengan ordenadas', () => {
    const axis = timeAxis(cols(30, 0, 10));
    expect(axis.startMs).toBe(T0);
    expect(axis.endMs).toBe(T0 + 30 * MIN);
  });

  it('descarta timestamps inválidos en vez de propagar NaN al eje', () => {
    const axis = timeAxis([...cols(0, 10), 'no-es-fecha', '']);
    expect(Number.isFinite(axis.startMs)).toBe(true);
    expect(axis.endMs).toBe(T0 + 10 * MIN);
  });

  it('una sola columna no produce un eje de ancho cero', () => {
    // startMs === endMs haría una división por cero al mapear a píxeles.
    const axis = timeAxis(cols(5));
    expect(axis.endMs).toBeGreaterThan(axis.startMs);
  });

  it('sin columnas devuelve un eje válido', () => {
    const axis = timeAxis([]);
    expect(Number.isFinite(axis.startMs)).toBe(true);
    expect(axis.endMs).toBeGreaterThan(axis.startMs);
  });
});

describe('timeToFraction', () => {
  const axis = { startMs: T0, endMs: T0 + 60 * MIN };

  it('el inicio va a la izquierda (0) y el final a la derecha (1)', () => {
    expect(timeToFraction(T0, axis)).toBeCloseTo(0);
    expect(timeToFraction(T0 + 60 * MIN, axis)).toBeCloseTo(1);
  });

  it('el punto medio cae en la mitad', () => {
    expect(timeToFraction(T0 + 30 * MIN, axis)).toBeCloseTo(0.5);
  });

  it('clampea fuera de rango en vez de dibujar afuera del recuadro', () => {
    expect(timeToFraction(T0 - 1e9, axis)).toBe(0);
    expect(timeToFraction(T0 + 1e9, axis)).toBe(1);
  });
});

describe('niceTimeTicks', () => {
  it('las marcas caen en minutos redondos dentro del rango', () => {
    const ticks = niceTimeTicks(T0, T0 + 60 * MIN);
    expect(ticks.length).toBeGreaterThan(1);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(T0);
      expect(t).toBeLessThanOrEqual(T0 + 60 * MIN);
      // Nada de 04:07:23 en el eje: los segundos tienen que ser 0.
      expect(new Date(t).getUTCSeconds(), `tick ${new Date(t).toISOString()}`).toBe(0);
    }
  });

  it('el paso se adapta al span: una ventana corta no usa marcas de una hora', () => {
    const cortas = niceTimeTicks(T0, T0 + 5 * MIN);
    const largas = niceTimeTicks(T0, T0 + 24 * 60 * MIN);
    expect(cortas.length).toBeGreaterThanOrEqual(2);
    expect(largas.length).toBeGreaterThanOrEqual(2);
    // Ninguna ventana debe saturar el eje de etiquetas ilegibles.
    expect(cortas.length).toBeLessThanOrEqual(12);
    expect(largas.length).toBeLessThanOrEqual(12);
  });

  it('un rango degenerado no cuelga el render', () => {
    expect(() => niceTimeTicks(T0, T0)).not.toThrow();
    expect(niceTimeTicks(T0, T0).length).toBeGreaterThan(0);
  });
});

describe('colorbarStops', () => {
  it('cubre la escala SWARM de 20 a 120 dB de punta a punta', () => {
    const stops = colorbarStops(6);
    expect(stops[0].db).toBe(20);
    expect(stops[stops.length - 1].db).toBe(120);
  });

  it('cada parada trae el color que le corresponde en la paleta', () => {
    for (const s of colorbarStops(8)) {
      expect(s.color, `db ${s.db}`).toMatch(/^rgb\(/);
    }
  });

  it('los dB suben de forma monótona — una colorbar desordenada miente', () => {
    const dbs = colorbarStops(10).map((s) => s.db);
    expect(dbs).toEqual([...dbs].sort((a, b) => a - b));
  });

  it('los extremos NO comparten color: si lo hicieran la escala sería plana', () => {
    const stops = colorbarStops(6);
    expect(stops[0].color).not.toBe(stops[stops.length - 1].color);
  });
});
