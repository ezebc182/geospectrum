/**
 * Share de rango: "imagen si se puede, link SIEMPRE" (decisión 2026-08-26).
 * El deep link es /stations/{channel}?start=...&end=... — posible gracias a
 * la ventana absoluta de la Fase 1. Estas son las piezas puras.
 */

import { describe, expect, it } from 'vitest';

import { buildRangeShareText, parseWindowParams, rangeUrl } from './share-range';

const START = '2026-08-26T10:59:28.000Z';
const END = '2026-08-26T11:01:28.000Z';

describe('parseWindowParams — el deep link de entrada', () => {
  it('parsea una ventana válida a milisegundos', () => {
    const w = parseWindowParams(START, END);
    expect(w).toEqual({ startMs: Date.parse(START), endMs: Date.parse(END) });
  });

  it('normaliza offsets: 11:00-03:00 y 14:00Z son el mismo instante', () => {
    const w = parseWindowParams('2026-08-26T11:00:00-03:00', '2026-08-26T14:10:00Z');
    expect(w?.startMs).toBe(Date.parse('2026-08-26T14:00:00Z'));
  });

  it('sin alguno de los dos parámetros: null', () => {
    expect(parseWindowParams(START, null)).toBeNull();
    expect(parseWindowParams(null, END)).toBeNull();
    expect(parseWindowParams(null, null)).toBeNull();
  });

  it('fechas que no parsean o ventana degenerada: null', () => {
    expect(parseWindowParams('ayer', END)).toBeNull();
    expect(parseWindowParams(END, START)).toBeNull();
    expect(parseWindowParams(START, START)).toBeNull();
  });

  it('más de 24 h: null (mismo techo que el endpoint)', () => {
    expect(parseWindowParams(START, '2026-08-27T10:59:29Z')).toBeNull();
    // Exactamente 24 h pasa: el borde es del endpoint y es inclusivo.
    expect(parseWindowParams(START, '2026-08-27T10:59:28Z')).not.toBeNull();
  });
});

describe('rangeUrl — el deep link de salida', () => {
  it('agrega start/end en ISO UTC preservando la ruta', () => {
    const url = rangeUrl(
      { startMs: Date.parse(START), endMs: Date.parse(END) },
      'https://geo.example/es/stations/IU.MAJO..BHZ',
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/es/stations/IU.MAJO..BHZ');
    expect(parsed.searchParams.get('start')).toBe(START);
    expect(parsed.searchParams.get('end')).toBe(END);
  });

  it('pisa una ventana previa en la URL en vez de duplicar parámetros', () => {
    const url = rangeUrl(
      { startMs: Date.parse(START), endMs: Date.parse(END) },
      'https://geo.example/es/stations/X?start=2020-01-01T00:00:00Z&end=2020-01-01T01:00:00Z',
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.getAll('start')).toEqual([START]);
  });
});

describe('buildRangeShareText', () => {
  it('canal + rango UTC + duración, listo para un chat', () => {
    const text = buildRangeShareText(
      'IU.MAJO..BHZ',
      { startMs: Date.parse(START), endMs: Date.parse(END) },
      { title: 'x', headline: (ch) => `Señal de ${ch}` },
    );
    expect(text).toContain('Señal de IU.MAJO..BHZ');
    expect(text).toContain('2026-08-26 10:59:28–11:01:28 UTC');
    expect(text).toContain('120 s');
  });
});
