/**
 * Recorte del waveform ya cargado para el preview del hover del helicorder.
 *
 * Sin red a propósito: el hover se mueve decenas de veces por segundo y un
 * fetch por movimiento spamearía la API. Se reusan los pares min/max de las
 * 24 h en memoria — resolución de orientación; el análisis fino es el clic.
 */

import type { TimeWindow } from './waveform-scale';

export interface WaveformSlice {
  mins: number[];
  maxs: number[];
}

export function sliceWaveformWindow(
  waveform: { starttime: string; endtime: string; mins: number[]; maxs: number[] },
  window: TimeWindow,
): WaveformSlice | null {
  const dataStartMs = Date.parse(waveform.starttime);
  const dataEndMs = Date.parse(waveform.endtime);
  if (!Number.isFinite(dataStartMs) || !Number.isFinite(dataEndMs)) return null;

  const totalMs = dataEndMs - dataStartMs;
  const pairs = Math.min(waveform.mins.length, waveform.maxs.length);
  if (totalMs <= 0 || pairs === 0) return null;

  const from = Math.max(
    0,
    Math.floor(((window.startMs - dataStartMs) / totalMs) * pairs),
  );
  const to = Math.min(
    pairs,
    Math.ceil(((window.endMs - dataStartMs) / totalMs) * pairs),
  );
  // Con menos de dos pares no hay onda que dibujar: mejor nada que un punto.
  if (to - from < 2) return null;

  return {
    mins: waveform.mins.slice(from, to),
    maxs: waveform.maxs.slice(from, to),
  };
}
