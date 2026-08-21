import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SpectronetWall } from './SpectronetWall';

vi.mock('./SpectronetStrip', () => ({
  SpectronetStrip: ({
    channel,
    label,
    metricsLine,
  }: {
    channel: string;
    label: string;
    metricsLine?: string | null;
  }) => (
    <div data-testid="strip" data-channel={channel} data-metrics-line={metricsLine ?? ''}>
      {label}
    </div>
  ),
}));

const METRICS = {
  'IU.LCO..BHZ': {
    channel: 'IU.LCO..BHZ',
    endtime: '2026-08-21T14:32:10.000000Z',
    rsam: 123.4,
    freq_hz: 2.4,
    fi: -0.12,
    peak_db: 87.3,
    events_hour: 3,
  },
};

/** Fijo para que la latencía del formateo sea determinista (8 s). */
const NOW_MS = Date.parse('2026-08-21T14:32:18.000Z');

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

/** El mismo muro con el flag showMetrics parametrizado. */
const makeWall = (showMetrics: boolean) => ({
  ...wall,
  layout: { ...wall.layout, showMetrics },
});

describe('SpectronetWall — banda de métricas', () => {
  it('con showMetrics pasa la banda formateada a la tira que tiene métricas', () => {
    render(
      <SpectronetWall
        wall={makeWall(true)}
        stripWidth={240}
        stripHeight={28}
        metrics={METRICS}
        nowMs={NOW_MS}
      />
    );

    const strips = screen.getAllByTestId('strip');
    const lco = strips.find((s) => s.getAttribute('data-channel') === 'IU.LCO..BHZ');
    expect(lco?.getAttribute('data-metrics-line')).toBe('RSAM 123 · FI -0.12 · 8s');
  });

  it('los canales sin métricas quedan sin banda, no rompen el muro', () => {
    render(
      <SpectronetWall
        wall={makeWall(true)}
        stripWidth={240}
        stripHeight={28}
        metrics={METRICS}
        nowMs={NOW_MS}
      />
    );

    const strips = screen.getAllByTestId('strip');
    const lima = strips.find((s) => s.getAttribute('data-channel') === 'II.NNA.00.BHZ');
    expect(lima?.getAttribute('data-metrics-line')).toBe('');
  });

  it('sin showMetrics no pasa banda aunque haya métricas', () => {
    render(
      <SpectronetWall
        wall={makeWall(false)}
        stripWidth={240}
        stripHeight={28}
        metrics={METRICS}
        nowMs={NOW_MS}
      />
    );

    const strips = screen.getAllByTestId('strip');
    const lco = strips.find((s) => s.getAttribute('data-channel') === 'IU.LCO..BHZ');
    expect(lco?.getAttribute('data-metrics-line')).toBe('');
  });
});

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
