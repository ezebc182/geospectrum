/**
 * Panel de b-value (analytics-professional-panels, 5.5; spec dashboard-ui
 * "Panel de b-value con estado de datos no estimables", design Decision 1 y
 * 8, [R8]/[R9]).
 *
 * La regla que este test PROTEGE (criterio de éxito literal del proposal):
 * con `status !== "ok"` NO existe ningún número de b en pantalla — ni el
 * `data-testid="b-value-number"`, ni la etiqueta i18n del valor, ni la recta
 * de ajuste — aunque el body traiga un `b` (malformado). Se busca por la
 * etiqueta i18n y por el testid, NUNCA por la ausencia de "0.99": un stub que
 * mostrara `b = 0` pasaría un test escrito al revés. Mutación: design M8.
 *
 * Recharts se mockea capturando props (`ComposedChart.data`, cada `Line`);
 * el SVG no se asserta.
 */

import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { BValueResponse, MagnitudeBin } from '@/lib/analytics';
import { IntlTestProvider } from '@/lib/test-intl';
import { BValueChart } from './BValueChart';

const composedChartProps: Array<Record<string, unknown>> = [];
const lineProps: Array<Record<string, unknown>> = [];

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ComposedChart: (props: Record<string, unknown> & { children?: ReactNode }) => {
    composedChartProps.push(props);
    return <div data-testid="composed-chart">{props.children}</div>;
  },
  Line: (props: Record<string, unknown>) => {
    lineProps.push(props);
    return null;
  },
  Bar: () => null,
  Scatter: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

const BINS: MagnitudeBin[] = [
  { m: 2.0, count: 100, cumulative: 111 },
  { m: 2.5, count: 10, cumulative: 11 },
  { m: 3.0, count: 1, cumulative: 1 },
];

function base() {
  return {
    method: 'aki-utsu-mle' as const,
    n_total: 200,
    n_above_mc: 48617,
    min_events: 50,
    mc: 2.0,
    mc_at_catalog_floor: false,
    bins: BINS,
    mag_type_counts: { mww: 120, ml: 80 },
    window_start: '2026-08-07T00:00:00Z',
    window_end: '2026-09-06T00:00:00Z',
    area_slug: 'andes',
  };
}

const OK: BValueResponse = { ...base(), status: 'ok', b: 0.9963, sigma_b: 0.0047, a: 6.0 };
const INSUFFICIENT: BValueResponse = { ...base(), status: 'insufficient', n_above_mc: 23 };
const DEGENERATE: BValueResponse = { ...base(), status: 'degenerate', n_above_mc: 60, mc: 3.0 };

function renderChart(data: BValueResponse | undefined, extra: { error?: unknown; isLoading?: boolean } = {}) {
  return render(
    <IntlTestProvider>
      <BValueChart data={data} error={extra.error} isLoading={extra.isLoading ?? false} />
    </IntlTestProvider>,
  );
}

afterEach(() => {
  cleanup();
  composedChartProps.length = 0;
  lineProps.length = 0;
});

/** `data` del `ComposedChart` capturado (última pintada). */
function chartRows(): Array<{ m: number }> {
  const last = composedChartProps[composedChartProps.length - 1];
  return last.data as Array<{ m: number }>;
}

function fitLines() {
  return lineProps.filter((p) => p.dataKey === 'log10N');
}

describe('BValueChart', () => {
  it('status ok: muestra 1.00 ± 0.00 asociado a la etiqueta de b-value, Mc, N sobre Mc y la recta', () => {
    renderChart(OK);

    const number = screen.getByTestId('b-value-number');
    expect(number.textContent).toContain('1.00');
    expect(number.textContent).toContain('± 0.00');
    expect(screen.getByText(es.analytics.bValue.bValueLabel)).toBeInTheDocument();
    expect(screen.getByText(es.analytics.bValue.nAboveMc.replace('{n}', '48617'))).toBeInTheDocument();
    expect(screen.getByText(es.analytics.bValue.mc.replace('{mc}', '2.0'))).toBeInTheDocument();
    expect(screen.queryByText(es.analytics.bValue.mcAtFloor)).toBeNull();

    // Histograma con tantas filas como bins y UNA recta de ajuste.
    expect(chartRows().map((r) => r.m)).toEqual([2.0, 2.5, 3.0]);
    expect(fitLines()).toHaveLength(1);
    const fit = fitLines()[0].data as Array<{ m: number; log10N: number }>;
    // Pasa por (mc, a − b·mc) = (2.0, 6.0 − 0.9963·2.0)
    expect(fit[0].m).toBe(2.0);
    expect(fit[0].log10N).toBeCloseTo(6.0 - 0.9963 * 2.0, 6);
  });

  it('mc_at_catalog_floor ⇒ aviso visible', () => {
    renderChart({ ...OK, mc_at_catalog_floor: true });
    expect(screen.getByText(es.analytics.bValue.mcAtFloor)).toBeInTheDocument();
  });

  it('insufficient: tarjeta con 23 y 50, SIN número, SIN etiqueta de b-value y SIN recta', () => {
    renderChart(INSUFFICIENT);

    const card = screen.getByTestId('b-value-insufficient');
    expect(card.textContent).toBe(
      es.analytics.bValue.insufficient.replace('{n}', '23').replace('{min}', '50'),
    );
    expect(screen.queryByTestId('b-value-number')).toBeNull();
    expect(screen.queryByText(es.analytics.bValue.bValueLabel)).toBeNull();
    expect(fitLines()).toHaveLength(0);
    // El histograma se muestra igual (dato honesto).
    expect(chartRows()).toHaveLength(BINS.length);
  });

  it('body malformado {status: insufficient, b: 1.2} ⇒ el 1.2 NO aparece', () => {
    const malformed = { ...INSUFFICIENT, n_above_mc: 5, bins: [], b: 1.2 } as unknown as BValueResponse;
    const { container } = renderChart(malformed);

    expect(screen.getByTestId('b-value-insufficient')).toBeInTheDocument();
    expect(screen.queryByTestId('b-value-number')).toBeNull();
    expect(container.textContent).not.toContain('1.2');
    expect(container.textContent).not.toContain('1,2');
    expect(fitLines()).toHaveLength(0);
  });

  it('degenerate: su propio texto, NO el de insuficiente, sin número', () => {
    renderChart(DEGENERATE);

    const card = screen.getByTestId('b-value-degenerate');
    expect(card.textContent).toBe(
      es.analytics.bValue.degenerate.replace('{n}', '60').replace('{min}', '50'),
    );
    expect(screen.queryByTestId('b-value-insufficient')).toBeNull();
    expect(screen.queryByTestId('b-value-number')).toBeNull();
    expect(screen.queryByText(es.analytics.bValue.bValueLabel)).toBeNull();
    expect(chartRows()).toHaveLength(BINS.length);
  });

  it('lista mag_type_counts y el método', () => {
    renderChart(OK);
    const types = screen.getByTestId('b-value-mag-types');
    expect(types.textContent).toContain('mww');
    expect(types.textContent).toContain('120');
    expect(types.textContent).toContain('ml');
    expect(types.textContent).toContain('80');
    expect(screen.getByText(es.analytics.bValue.method.replace('{method}', 'aki-utsu-mle'))).toBeInTheDocument();
  });

  it('el estado no estimable sale de en.json con la UI en inglés', () => {
    render(
      <IntlTestProvider locale="en-US" messages={en}>
        <BValueChart data={INSUFFICIENT} isLoading={false} />
      </IntlTestProvider>,
    );
    expect(screen.getByTestId('b-value-insufficient').textContent).toBe(
      en.analytics.bValue.insufficient.replace('{n}', '23').replace('{min}', '50'),
    );
    expect(screen.queryByText(/Datos insuficientes/)).toBeNull();
  });

  it('cargando sin datos ⇒ role=status; error sin datos ⇒ role=alert con el texto del panel', () => {
    renderChart(undefined, { isLoading: true });
    expect(screen.getByRole('status').textContent).toContain(es.analytics.bValue.loading);
    cleanup();

    renderChart(undefined, { error: new Error('503') });
    expect(screen.getByRole('alert').textContent).toContain(es.analytics.bValue.error);
    expect(screen.queryByTestId('b-value-number')).toBeNull();
  });
});
