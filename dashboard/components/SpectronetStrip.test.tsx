import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SpectronetStrip } from './SpectronetStrip';

vi.mock('./LiveSpectrogramCanvas', () => ({
  LiveSpectrogramCanvas: ({ channel, variant }: { channel: string; variant: string }) => (
    <div data-testid="canvas-mock" data-channel={channel} data-variant={variant} />
  ),
}));

describe('SpectronetStrip', () => {
  it('pone la etiqueta a la IZQUIERDA de la tira, en mayúsculas', () => {
    render(<SpectronetStrip channel="IU.MAJO.00.BHZ" label="Tokyo" width={240} height={28} />);
    const label = screen.getByText('TOKYO');
    const canvas = screen.getByTestId('canvas-mock');
    // La etiqueta precede al canvas en el DOM (flex row)
    expect(label.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(canvas.getAttribute('data-variant')).toBe('bare');
    expect(canvas.getAttribute('data-channel')).toBe('IU.MAJO.00.BHZ');
  });

  it('renderiza la banda de métricas cuando llega metricsLine', () => {
    render(
      <SpectronetStrip
        channel="JP.JYT..BHZ"
        label="Tokyo"
        width={300}
        height={40}
        metricsLine="RSAM 123 · FI -0.12 · 8s"
      />
    );
    expect(screen.getByTestId('strip-metrics-band').textContent).toBe(
      'RSAM 123 · FI -0.12 · 8s'
    );
  });

  it('sin metricsLine no hay banda', () => {
    render(<SpectronetStrip channel="JP.JYT..BHZ" label="Tokyo" width={300} height={40} />);
    expect(screen.queryByTestId('strip-metrics-band')).toBeNull();
  });

  it('la banda no cambia la altura de la tira (overlay absoluto)', () => {
    // El muro de la cartelera está dimensionado para entrar sin scroll: si
    // la banda empujara el layout, 74 tiras desbordarían la pantalla.
    render(
      <SpectronetStrip
        channel="JP.JYT..BHZ"
        label="Tokyo"
        width={300}
        height={40}
        metricsLine="RSAM 123"
      />
    );
    expect(screen.getByTestId('strip-metrics-band').className).toContain('absolute');
  });
});
