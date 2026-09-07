/**
 * Panel de uptime histórico (analytics-professional-panels, 5.4; spec
 * dashboard-ui "Panel de uptime histórico", design Decision 2 y 8, [R12]).
 *
 * La regla que este test PROTEGE es `null ≠ 0`: un bucket `null` ("nadie
 * miró") lleva la etiqueta "sin observación" y NUNCA "0 %"; `overall: null`
 * ⇒ "sin observaciones", nunca `0 %`/`NaN %`. Recharts se mockea (no se
 * asserta SVG): lo que se afirma son las etiquetas del DOM y el orden del
 * ranking, que salen de las libs puras de 4.3.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import { getStationUptime, type StationUptimeResponse, type UptimeBucket } from '@/lib/analytics';
import { IntlTestProvider } from '@/lib/test-intl';
import { StationUptimeChart } from './StationUptimeChart';

vi.mock('@/lib/analytics', () => ({
  getStationUptime: vi.fn(),
}));

const barChartProps: Array<Record<string, unknown>> = [];

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: (props: Record<string, unknown> & { children?: ReactNode }) => {
    barChartProps.push(props);
    return <div data-testid="bar-chart">{props.children}</div>;
  },
  Bar: () => null,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

const START = Date.UTC(2026, 8, 6, 0, 0, 0);

function bucket(i: number, ratio: number | null, over: Partial<UptimeBucket> = {}): UptimeBucket {
  return {
    bucket_start: new Date(START + i * 3_600_000).toISOString(),
    columns_count: ratio === null ? 0 : Math.round(ratio * 900),
    observed_hours: ratio === null ? 0 : 1,
    expected: ratio === null ? 0 : 900,
    ratio,
    in_progress: false,
    ...over,
  };
}

function respuesta(over: Partial<StationUptimeResponse> = {}): StationUptimeResponse {
  return {
    bucket: 'hour',
    window_start: new Date(START).toISOString(),
    window_end: new Date(START + 4 * 3_600_000).toISOString(),
    expected_columns_per_hour: 900,
    stations: {
      A: [bucket(0, 1.0), bucket(1, 0.0), bucket(2, null), bucket(3, 1.0, { in_progress: true })],
    },
    overall: { A: 0.75 },
    ...over,
  };
}

function renderChart(days = 7) {
  return render(
    <IntlTestProvider>
      <StationUptimeChart days={days} />
    </IntlTestProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(getStationUptime).mockReset();
  barChartProps.length = 0;
});

describe('StationUptimeChart', () => {
  it('pide el uptime con los días de catálogo (bucket hour; el backend fuerza day si > 14)', async () => {
    vi.mocked(getStationUptime).mockResolvedValue(respuesta());
    renderChart(7);
    await waitFor(() => expect(getStationUptime).toHaveBeenCalledWith(7, 'hour'));
  });

  it('muestra el loader i18n mientras la respuesta está en vuelo', () => {
    vi.mocked(getStationUptime).mockReturnValue(new Promise(() => {}));
    renderChart();
    expect(screen.getByRole('status').textContent).toContain(es.analytics.uptime.loading);
  });

  it('un error muestra role="alert" con el texto i18n', async () => {
    vi.mocked(getStationUptime).mockRejectedValue(new Error('503'));
    renderChart();
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(es.analytics.uptime.error);
    });
  });

  it('stations: {} ⇒ "sin historial todavía"', async () => {
    vi.mocked(getStationUptime).mockResolvedValue(respuesta({ stations: {}, overall: {} }));
    renderChart();
    expect(await screen.findByText(es.analytics.uptime.noHistoryYet)).toBeInTheDocument();
  });

  it('null y 0 se distinguen: el 2.º bucket dice "0 %" y el 3.º "sin observación" (nunca "0 %")', async () => {
    vi.mocked(getStationUptime).mockResolvedValue(respuesta());
    renderChart();
    const cells = await screen.findAllByTestId('uptime-bucket');
    expect(cells).toHaveLength(4);
    expect(cells[0].textContent).toContain('100 %');
    expect(cells[1].textContent).toContain(es.analytics.uptime.zeroPercent);
    expect(cells[2].textContent).toContain(es.analytics.uptime.noObservation);
    expect(cells[2].textContent).not.toContain('0 %');
    expect(cells[2].textContent).not.toContain('NaN');
  });

  it('el bucket in_progress se marca "en curso"', async () => {
    vi.mocked(getStationUptime).mockResolvedValue(respuesta());
    renderChart();
    const cells = await screen.findAllByTestId('uptime-bucket');
    expect(cells[3].textContent).toContain(es.analytics.uptime.inProgress);
    expect(cells[0].textContent).not.toContain(es.analytics.uptime.inProgress);
  });

  it('overall null ⇒ "sin observaciones" en el ranking, nunca 0 % ni NaN %', async () => {
    vi.mocked(getStationUptime).mockResolvedValue(
      respuesta({
        stations: { A: [bucket(0, 0.9)], C: [bucket(0, null)] },
        overall: { A: 0.9, C: null },
      }),
    );
    renderChart();
    const rows = await screen.findAllByTestId('uptime-rank-row');
    const c = rows.find((r) => r.textContent?.includes('C'));
    expect(c).toBeDefined();
    expect(c!.textContent).toContain(es.analytics.uptime.noObservations);
    expect(c!.textContent).not.toMatch(/\d+ %/);
    expect(c!.textContent).not.toContain('NaN');
  });

  it('el ranking ordena peor primero y los null al final: B, D, A, C', async () => {
    vi.mocked(getStationUptime).mockResolvedValue(
      respuesta({
        stations: { A: [bucket(0, 0.9)], B: [bucket(0, 0.3)], C: [bucket(0, null)], D: [bucket(0, 0.6)] },
        overall: { A: 0.9, B: 0.3, C: null, D: 0.6 },
      }),
    );
    renderChart();
    const rows = await screen.findAllByTestId('uptime-rank-row');
    expect(rows.map((r) => r.getAttribute('data-channel'))).toEqual(['B', 'D', 'A', 'C']);
    // El BarChart del ranking recibe SOLO las observadas, en ese orden.
    const ranking = barChartProps.find((p) => (p['data-chart'] as string) === 'ranking');
    expect(ranking).toBeDefined();
    expect((ranking!.data as Array<{ channel: string }>).map((r) => r.channel)).toEqual(['B', 'D', 'A']);
  });

  it('el timeline muestra el canal peor por defecto y cambia al elegir otro', async () => {
    vi.mocked(getStationUptime).mockResolvedValue(
      respuesta({
        stations: { A: [bucket(0, 1.0), bucket(1, 1.0)], B: [bucket(0, 0.3), bucket(1, null)] },
        overall: { A: 1.0, B: 0.3 },
      }),
    );
    renderChart();
    expect(await screen.findByText(es.analytics.uptime.timeline.replace('{channel}', 'B'))).toBeInTheDocument();
    let cells = screen.getAllByTestId('uptime-bucket');
    expect(cells[1].textContent).toContain(es.analytics.uptime.noObservation);

    fireEvent.click(screen.getByRole('button', { name: es.analytics.uptime.selectStation.replace('{channel}', 'A') }));
    expect(screen.getByText(es.analytics.uptime.timeline.replace('{channel}', 'A'))).toBeInTheDocument();
    cells = screen.getAllByTestId('uptime-bucket');
    expect(cells[1].textContent).toContain('100 %');
  });
});
