import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SpectronetWall } from './SpectronetWall';

vi.mock('./SpectronetStrip', () => ({
  SpectronetStrip: ({ channel, label }: { channel: string; label: string }) => (
    <div data-testid="strip" data-channel={channel}>{label}</div>
  ),
}));

const wall = {
  id: 'global',
  name: 'Global',
  layout: {
    columns: [
      {
        groups: [
          {
            title: 'SUDAMÉRICA',
            channels: [
              { channel: 'IU.LCO..BHZ', label: 'Santiago' },
              { channel: 'II.NNA.00.BHZ', label: 'Lima' },
            ],
          },
        ],
      },
      { groups: [{ title: 'OCEANÍA', channels: [{ channel: 'NZ.BKZ.10.HHZ', label: 'Auckland' }] }] },
    ],
    showMetrics: false,
  },
};

describe('SpectronetWall', () => {
  it('renderiza columnas con encabezados de grupo y una tira por canal', () => {
    render(<SpectronetWall wall={wall} stripWidth={240} stripHeight={28} />);
    expect(screen.getByText('SUDAMÉRICA')).toBeTruthy();
    expect(screen.getByText('OCEANÍA')).toBeTruthy();
    expect(screen.getAllByTestId('strip')).toHaveLength(3);
  });

  it('las tiras de un grupo van apiladas sin gap (contenedor gap-0)', () => {
    render(<SpectronetWall wall={wall} stripWidth={240} stripHeight={28} />);
    const group = screen.getByTestId('wall-group-SUDAMÉRICA');
    expect(group.className).toContain('gap-0');
  });
});
