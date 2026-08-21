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
});
