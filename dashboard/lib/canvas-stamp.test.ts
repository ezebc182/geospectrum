/**
 * Sello de marca en las imágenes compartidas: la imagen que termina en un
 * chat es la cara pública del producto y lleva "geospectrum.org" estampado.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stampCanvas } from './canvas-stamp';

afterEach(() => vi.restoreAllMocks());

function fakeCtx() {
  return {
    drawImage: vi.fn(),
    fillText: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
  };
}

describe('stampCanvas', () => {
  it('copia la señal y estampa geospectrum.org SIN tocar el canvas original', () => {
    const ctx = fakeCtx();
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    const source = document.createElement('canvas');
    source.width = 960;
    source.height = 280;
    const stamped = stampCanvas(source);

    // Es una COPIA (el canvas del wave view no puede quedar sellado en pantalla).
    expect(stamped).not.toBe(source);
    expect(stamped.width).toBe(960);
    expect(ctx.drawImage).toHaveBeenCalledWith(source, 0, 0);
    const textos = ctx.fillText.mock.calls.map((c) => c[0]);
    expect(textos).toContain('geospectrum.org');
    spy.mockRestore();
  });

  it('sin contexto 2D devuelve el original: imagen sin sello antes que ninguna', () => {
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(null);
    const source = document.createElement('canvas');
    expect(stampCanvas(source)).toBe(source);
    spy.mockRestore();
  });
});
