import { describe, expect, it } from 'vitest';
import {
  HELICORDER_BLUES,
  autoClipValue,
  clampToClip,
  majorTickMinutes,
  rowBias,
  rowColor,
  rowCount,
  rowForOffset,
  splitClippedSegment,
  xFractionForOffset,
} from './helicorder-layout';

describe('geometría de filas', () => {
  it('24h en franjas de 30min son 48 filas', () => {
    expect(rowCount(1440, 30)).toBe(48);
  });

  it('el offset mapea a fila y posición con wrap modular', () => {
    // A los 45 min con franjas de 30: fila 1, mitad de la fila.
    expect(rowForOffset(45 * 60, 30 * 60)).toBe(1);
    expect(xFractionForOffset(45 * 60, 30 * 60)).toBeCloseTo(0.5);
    // Justo al empezar una franja: x vuelve a 0 (el wrap de SWARM).
    expect(xFractionForOffset(60 * 60, 30 * 60)).toBeCloseTo(0);
  });
});

describe('colores SWARM', () => {
  it('usa los 4 azules exactos del HelicorderRenderer y cicla', () => {
    expect(HELICORDER_BLUES).toEqual([
      'rgb(0,0,255)',
      'rgb(0,0,205)',
      'rgb(0,0,155)',
      'rgb(0,0,105)',
    ]);
    expect(rowColor(0)).toBe('rgb(0,0,255)');
    expect(rowColor(5)).toBe('rgb(0,0,205)');
  });
});

describe('ticks por densidad (heurística SWARM)', () => {
  it('escala con el tamaño de franja', () => {
    expect(majorTickMinutes(15)).toBe(1);
    expect(majorTickMinutes(30)).toBe(1);
    expect(majorTickMinutes(60)).toBe(5);
    expect(majorTickMinutes(240)).toBe(10);
    expect(majorTickMinutes(720)).toBe(20);
  });
});

describe('clipping', () => {
  it('clampea y marca el clip como SWARM', () => {
    expect(clampToClip(50, 100)).toEqual({ v: 50, clipped: false });
    expect(clampToClip(250, 100)).toEqual({ v: 100, clipped: true });
    expect(clampToClip(-250, 100)).toEqual({ v: -100, clipped: true });
  });
});

/**
 * Los tests de arriba son los del plan: verifican puntos sueltos. Estos
 * verifican INVARIANTES sobre todo el recorrido de un día, que es donde vive
 * el bug de un helicorder: una fila mal calculada no rompe nada visible en un
 * caso puntual, pero desalinea la grilla entera.
 */
describe('invariantes sobre un día completo', () => {
  const CHUNK_MIN = 30;
  const CHUNK_SEC = CHUNK_MIN * 60;
  const DAY_SEC = 24 * 3600;

  it('todo offset de 24h cae dentro de las filas que rowCount promete', () => {
    const filas = rowCount(1440, CHUNK_MIN);
    // El último segundo del día tiene que entrar: si rowForOffset se pasa,
    // el canvas dibuja fuera del área y la última franja se pierde.
    for (let s = 0; s < DAY_SEC; s += 137) {
      const fila = rowForOffset(s, CHUNK_SEC);
      expect(fila, `offset ${s}s`).toBeGreaterThanOrEqual(0);
      expect(fila, `offset ${s}s`).toBeLessThan(filas);
    }
    expect(rowForOffset(DAY_SEC - 1, CHUNK_SEC)).toBe(filas - 1);
  });

  it('la fracción x siempre queda en [0,1) — nunca 1, que dibujaría en la fila siguiente', () => {
    for (let s = 0; s < DAY_SEC; s += 97) {
      const x = xFractionForOffset(s, CHUNK_SEC);
      expect(x, `offset ${s}s`).toBeGreaterThanOrEqual(0);
      expect(x, `offset ${s}s`).toBeLessThan(1);
    }
  });

  it('(fila, x) reconstruye el offset original — el mapeo no pierde información', () => {
    for (let s = 0; s < DAY_SEC; s += 211) {
      const reconstruido =
        rowForOffset(s, CHUNK_SEC) * CHUNK_SEC + xFractionForOffset(s, CHUNK_SEC) * CHUNK_SEC;
      expect(reconstruido, `offset ${s}s`).toBeCloseTo(s, 6);
    }
  });

  it('filas contiguas nunca comparten color — el ojo tiene que poder separarlas', () => {
    for (let f = 0; f < 48; f++) {
      expect(rowColor(f), `fila ${f}`).not.toBe(rowColor(f + 1));
    }
  });

  it('clampToClip nunca devuelve un valor fuera de ±clip', () => {
    for (const v of [-1e6, -100.001, -100, -1, 0, 1, 100, 100.001, 1e6]) {
      const { v: out } = clampToClip(v, 100);
      expect(Math.abs(out), `valor ${v}`).toBeLessThanOrEqual(100);
    }
  });
});

describe('autoClipValue', () => {
  it('un transitorio aislado NO define la escala del día', () => {
    // 1000 muestras de ruido ±10 y un solo sismo de 5000: si el clip fuera el
    // máximo, el ruido de fondo quedaría aplastado contra la línea de base.
    const mins = Array.from({ length: 1000 }, () => -10);
    const maxs = Array.from({ length: 1000 }, () => 10);
    maxs[500] = 5000;

    const clip = autoClipValue(mins, maxs);

    expect(clip).toBeLessThan(100);
    expect(clip).toBeGreaterThan(0);
  });

  it('sigue la escala real cuando la señal es homogénea', () => {
    const mins = Array.from({ length: 500 }, () => -250);
    const maxs = Array.from({ length: 500 }, () => 250);
    expect(autoClipValue(mins, maxs)).toBeCloseTo(250);
  });

  it('nunca devuelve 0 — sería una división por cero al escalar', () => {
    expect(autoClipValue([0, 0, 0], [0, 0, 0])).toBe(1);
    expect(autoClipValue([], [])).toBe(1);
  });
});

/**
 * Bug de QA: el trazo se pintaba entero de rojo si CUALQUIER extremo tocaba el
 * clip, así que la parte fuerte de un sismo salía como bloque rojo sólido que
 * tapaba la forma de onda. En SWARM el rojo marca sólo el tramo que se
 * desborda; el cuerpo queda azul.
 */
describe('splitClippedSegment', () => {
  const CLIP = 100;

  it('un trazo que entra entero es un solo segmento sin clip', () => {
    expect(splitClippedSegment(-50, 50, CLIP)).toEqual([{ lo: -50, hi: 50, clipped: false }]);
  });

  it('un trazo que se pasa arriba se parte: cuerpo azul + punta roja', () => {
    const segs = splitClippedSegment(-50, 250, CLIP);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ lo: -50, hi: CLIP, clipped: false });
    // La punta roja llega al clip y tiene grosor: con altura 0 sería invisible
    // y la saturación dejaría de señalizarse.
    expect(segs[1].clipped).toBe(true);
    expect(segs[1].hi).toBe(CLIP);
    expect(segs[1].hi - segs[1].lo).toBeGreaterThan(0);
  });

  it('un trazo que se pasa de los dos lados deja el cuerpo azul entre las dos puntas', () => {
    const segs = splitClippedSegment(-250, 250, CLIP);
    expect(segs).toContainEqual({ lo: -CLIP, hi: CLIP, clipped: false });
    expect(segs.filter((s) => s.clipped)).toHaveLength(2);
  });

  it('el cuerpo azul NUNCA desaparece cuando hay clip — es el bug que tapaba el sismo', () => {
    for (const [lo, hi] of [
      [-250, 250],
      [-50, 300],
      [-300, 50],
      [-1e6, 1e6],
    ]) {
      const segs = splitClippedSegment(lo, hi, CLIP);
      const cuerpo = segs.find((s) => !s.clipped);
      expect(cuerpo, `trazo ${lo}..${hi}`).toBeDefined();
      // El cuerpo tiene que tener altura real, no ser un punto.
      expect(cuerpo!.hi - cuerpo!.lo, `trazo ${lo}..${hi}`).toBeGreaterThan(0);
    }
  });

  it('ningún segmento se sale de ±clip', () => {
    for (const [lo, hi] of [
      [-250, 250],
      [-50, 300],
      [-1e6, 1e6],
    ]) {
      for (const s of splitClippedSegment(lo, hi, CLIP)) {
        expect(Math.abs(s.lo)).toBeLessThanOrEqual(CLIP);
        expect(Math.abs(s.hi)).toBeLessThanOrEqual(CLIP);
        expect(s.hi).toBeGreaterThanOrEqual(s.lo);
      }
    }
  });
});

describe('rowBias', () => {
  it('devuelve la línea de base del tramo, no la del día entero', () => {
    // Fila 0 centrada en 0, fila 1 centrada en 100 (deriva del instrumento).
    const mins = [-10, -10, 90, 90];
    const maxs = [10, 10, 110, 110];

    expect(rowBias(mins, maxs, 0, 2)).toBeCloseTo(0);
    expect(rowBias(mins, maxs, 2, 4)).toBeCloseTo(100);
  });

  it('un tramo vacío o fuera de rango da 0 y no NaN', () => {
    expect(rowBias([1], [2], 5, 9)).toBe(0);
    expect(rowBias([], [], 0, 10)).toBe(0);
  });
});
