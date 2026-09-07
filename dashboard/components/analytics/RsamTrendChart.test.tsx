/**
 * Tendencia RSAM multi-canal (analytics-professional-panels, 5.3; spec
 * dashboard-ui "Panel de tendencia RSAM", design Decision 3 y 8).
 *
 * Recharts NO se asserta por SVG (`ResponsiveContainer` mide 0×0 en jsdom):
 * se mockea `recharts` capturando las props de `LineChart` y de cada `Line`.
 * Lo verificable es la ADAPTACIÓN: la fila fusionada entrega `null` (no `0`)
 * al `<Line>` del canal donde falta la muestra ([R27], `connectNulls={false}`),
 * y un canal rechazado degrada SOLO su serie (error POR SERIE, Decisión 2).
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import { seismicAPI } from '@/lib/api';
import type { RsamResponse } from '@/lib/api';
import { signalWindowFromHours } from '@/lib/rsam-trend';
import { IntlTestProvider } from '@/lib/test-intl';
import { RSAM_TREND_PERIOD_SECONDS, RsamTrendChart } from './RsamTrendChart';

vi.mock('@/lib/api', () => ({
  seismicAPI: { getStationRsam: vi.fn() },
}));

const lineChartProps: Array<Record<string, unknown>> = [];
const lineProps: Array<Record<string, unknown>> = [];

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: (props: Record<string, unknown> & { children?: ReactNode }) => {
    lineChartProps.push(props);
    return <div data-testid="line-chart">{props.children}</div>;
  },
  Line: (props: Record<string, unknown>) => {
    lineProps.push(props);
    return null;
  },
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
const WINDOW = signalWindowFromHours(6, NOW);
const T = [0, 1, 2, 3].map((i) => new Date(NOW - (4 - i) * 600_000).toISOString());

function respuesta(channel: string, samples: { t: string; value: number }[]): RsamResponse {
  return {
    channel,
    sampling_rate: 100,
    period_seconds: 600,
    starttime: WINDOW.start,
    endtime: WINDOW.end,
    samples,
  };
}

function renderChart(channels: string[]) {
  return render(
    <IntlTestProvider>
      <RsamTrendChart channels={channels} window={WINDOW} />
    </IntlTestProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(seismicAPI.getStationRsam).mockReset();
  lineChartProps.length = 0;
  lineProps.length = 0;
});

describe('RsamTrendChart', () => {
  it('sin canales muestra el estado "elegí un canal" y no pide nada', () => {
    renderChart([]);
    expect(screen.getByText(es.analytics.picker.chooseChannel)).toBeInTheDocument();
    expect(seismicAPI.getStationRsam).not.toHaveBeenCalled();
  });

  it('pide una serie por canal con la ventana y el período de SWARM (600 s)', async () => {
    vi.mocked(seismicAPI.getStationRsam).mockImplementation(async (channel) => respuesta(channel, []));
    renderChart(['A', 'B']);
    await waitFor(() => expect(seismicAPI.getStationRsam).toHaveBeenCalledTimes(2));
    expect(RSAM_TREND_PERIOD_SECONDS).toBe(600);
    expect(seismicAPI.getStationRsam).toHaveBeenCalledWith('A', WINDOW, 600);
    expect(seismicAPI.getStationRsam).toHaveBeenCalledWith('B', WINDOW, 600);
  });

  it('muestra un loader POR SERIE mientras cada canal está en vuelo', () => {
    vi.mocked(seismicAPI.getStationRsam).mockReturnValue(new Promise(() => {}));
    renderChart(['A', 'B']);
    const loaders = screen.getAllByRole('status');
    expect(loaders).toHaveLength(2);
    expect(loaders[0].textContent).toContain(es.analytics.rsam.loading.replace('{channel}', 'A'));
    expect(loaders[1].textContent).toContain(es.analytics.rsam.loading.replace('{channel}', 'B'));
  });

  it('un canal rechazado muestra SU error etiquetado y no tumba la serie que resolvió', async () => {
    vi.mocked(seismicAPI.getStationRsam).mockImplementation(async (channel) => {
      if (channel === 'B') throw new Error('404 sin datos FDSN');
      return respuesta(channel, [
        { t: T[0], value: 10 },
        { t: T[1], value: 20 },
        { t: T[3], value: 40 },
      ]);
    });
    renderChart(['A', 'B']);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('B');
    expect(alert.textContent).toContain('404 sin datos FDSN');
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    // Leyenda de A presente; B no tiene <Line>.
    const legend = screen.getByTestId('rsam-trend-legend');
    expect(legend.textContent).toContain('A');
    expect(legend.textContent).not.toContain('B');
    await waitFor(() => expect(lineProps.length).toBeGreaterThan(0));
    expect(lineProps.map((p) => p.dataKey)).toEqual(['A']);
  });

  it('la fila fusionada pasa null (no 0) al <Line> de A donde falta la muestra, con connectNulls=false', async () => {
    vi.mocked(seismicAPI.getStationRsam).mockImplementation(async (channel) => {
      if (channel === 'A') {
        // A no tiene muestra en T[2]
        return respuesta(channel, [
          { t: T[0], value: 10 },
          { t: T[1], value: 20 },
          { t: T[3], value: 40 },
        ]);
      }
      return respuesta(channel, T.map((t, i) => ({ t, value: 100 + i })));
    });
    renderChart(['A', 'C']);

    await waitFor(() => expect(lineProps.length).toBe(2));
    const last = lineChartProps[lineChartProps.length - 1];
    const rows = last.data as Array<{ t: number; A: number | null; C: number | null }>;
    expect(rows).toHaveLength(4);
    const gap = rows.find((r) => r.t === Date.parse(T[2]));
    expect(gap).toBeDefined();
    expect(gap!.A).toBeNull();
    expect(gap!.C).toBe(102);
    for (const line of lineProps) {
      expect(line.connectNulls).toBe(false);
    }
  });

  it('un canal que resolvió sin muestras muestra "sin muestras" para ese canal', async () => {
    vi.mocked(seismicAPI.getStationRsam).mockImplementation(async (channel) => respuesta(channel, []));
    renderChart(['A']);
    expect(await screen.findByText(es.analytics.rsam.noData.replace('{channel}', 'A'))).toBeInTheDocument();
  });
});
