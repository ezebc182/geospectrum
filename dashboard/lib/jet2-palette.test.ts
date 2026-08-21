import { describe, expect, it } from 'vitest';
import { JET2_PALETTE, jet2 } from './jet2-palette';

// Valores de referencia tomados del fuente de SWARM (dominio público, CC0):
// gov.usgs.volcanoes.core.legacy.plot.color.Jet2 — el array paletteBytes de
// 256 entradas RGB. Si estos tests fallan, la paleta dejó de ser la de SWARM.
describe('jet2', () => {
  it('tiene las 256 entradas del paletteBytes original', () => {
    expect(JET2_PALETTE).toHaveLength(256);
  });

  it('arranca en el azul marino #000083 de SWARM', () => {
    expect(jet2(0)).toBe('rgb(0,0,131)');
  });

  it('pasa por el verde central en t=0.5', () => {
    // round(0.5 * 255) = 128 → la entrada 128 del paletteBytes original
    expect(jet2(0.5)).toBe('rgb(131,255,123)');
  });

  it('termina en el rojo oscuro #7f0000 de SWARM', () => {
    expect(jet2(1)).toBe('rgb(127,0,0)');
  });

  it('clampea valores fuera de [0,1] a los extremos', () => {
    expect(jet2(-0.5)).toBe(jet2(0));
    expect(jet2(1.5)).toBe(jet2(1));
  });

  it('clampea NaN al extremo inferior en vez de romper el lookup', () => {
    expect(jet2(NaN)).toBe(jet2(0));
  });
});
