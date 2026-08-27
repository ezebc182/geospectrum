/**
 * Recorte del waveform de 24 h ya cargado para el preview del hover.
 *
 * El preview NO va a la red: reusa los pares min/max que el helicorder ya
 * tiene en memoria. La resolución es la del helicorder (~50 pares para
 * 120 s) — orientación, no análisis; el análisis fino es el clic.
 */

import { describe, expect, it } from 'vitest';

import { sliceWaveformWindow } from './waveform-slice';

const T0 = Date.parse('2026-08-26T00:00:00Z');
const HOUR = 3_600_000;

// 24 pares para 24 h: un par por hora, valores = índice (verificable a ojo).
const WAVEFORM = {
  starttime: '2026-08-26T00:00:00Z',
  endtime: '2026-08-27T00:00:00Z',
  mins: Array.from({ length: 24 }, (_, i) => -i),
  maxs: Array.from({ length: 24 }, (_, i) => i),
};

describe('sliceWaveformWindow', () => {
  it('recorta los pares que caen dentro de la ventana', () => {
    const slice = sliceWaveformWindow(WAVEFORM, {
      startMs: T0 + 4 * HOUR,
      endMs: T0 + 8 * HOUR,
    });
    expect(slice).not.toBeNull();
    expect(slice?.mins).toEqual([-4, -5, -6, -7]);
    expect(slice?.maxs).toEqual([4, 5, 6, 7]);
  });

  it('recorta contra los bordes del dato en vez de inventar pares', () => {
    const slice = sliceWaveformWindow(WAVEFORM, {
      startMs: T0 - 2 * HOUR,
      endMs: T0 + 2 * HOUR,
    });
    expect(slice?.maxs).toEqual([0, 1]);
  });

  it('ventana disjunta del dato: null', () => {
    expect(
      sliceWaveformWindow(WAVEFORM, { startMs: T0 + 30 * HOUR, endMs: T0 + 32 * HOUR }),
    ).toBeNull();
  });

  it('menos de dos pares no dibujan una onda: null', () => {
    expect(
      sliceWaveformWindow(WAVEFORM, {
        startMs: T0 + 4 * HOUR,
        endMs: T0 + 4 * HOUR + 60_000,
      }),
    ).toBeNull();
  });

  it('timestamps que no parsean: null, no NaN silencioso', () => {
    expect(
      sliceWaveformWindow(
        { ...WAVEFORM, starttime: 'ayer' },
        { startMs: T0, endMs: T0 + HOUR },
      ),
    ).toBeNull();
  });
});
