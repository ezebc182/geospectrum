/**
 * Panel de tremor (analytics-professional-panels, 5.6; spec dashboard-ui
 * "Panel de tremor volcánico", design Decision 4 y 8, [R4]/[R25]).
 *
 * Lo que se PROTEGE: los sombreados son EXACTAMENTE `episodes[i].start/end`
 * de la respuesta y la línea de umbral es `threshold_rsam` TAL CUAL (el
 * fixture trae un `threshold_rsam` que NO es `baseline × factor`, para que
 * un recálculo en el cliente muera); `episodes: []` es un estado explícito;
 * el 404 es un estado, no un crash; `tremor_fraction` y `parameters` salen
 * de la respuesta; la etiqueta dice "episodio sostenido", nunca "tremor
 * detectado". Recharts mockeado capturando `ReferenceArea`/`ReferenceLine`.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import { getTremor, type TremorEpisode, type TremorResponse } from '@/lib/analytics';
import { signalWindowFromHours } from '@/lib/rsam-trend';
import { IntlTestProvider } from '@/lib/test-intl';
import { TremorPanel } from './TremorPanel';

vi.mock('@/lib/analytics', () => ({
  getTremor: vi.fn(),
}));

const composedChartProps: Array<Record<string, unknown>> = [];
const referenceAreaProps: Array<Record<string, unknown>> = [];
const referenceLineProps: Array<Record<string, unknown>> = [];

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ComposedChart: (props: Record<string, unknown> & { children?: ReactNode }) => {
    composedChartProps.push(props);
    return <div data-testid="composed-chart">{props.children}</div>;
  },
  ReferenceArea: (props: Record<string, unknown>) => {
    referenceAreaProps.push(props);
    return null;
  },
  ReferenceLine: (props: Record<string, unknown>) => {
    referenceLineProps.push(props);
    return null;
  },
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
const WINDOW = signalWindowFromHours(6, NOW);
const CHANNEL = 'GE.KBU..BHZ';

function episode(start: string, end: string, over: Partial<TremorEpisode> = {}): TremorEpisode {
  return {
    start,
    end,
    samples: 5,
    duration_s: 3000,
    mean_ratio: 2.4,
    peak_rsam: 130,
    peak_ratio: 3.2,
    onset_ratio: 0.4,
    mean_dominant_hz: 1.5,
    mean_fi: -0.3,
    band: 'low',
    fi_sign: 'lp_like',
    ...over,
  };
}

function respuesta(over: Partial<TremorResponse> = {}): TremorResponse {
  const samples = [0, 1, 2, 3].map((i) => ({
    t: `2026-09-06T${String(8 + i).padStart(2, '0')}:05:00.000000Z`,
    rsam: 40 + i,
    dominant_hz: 1.2,
    fi: -0.1,
  }));
  return {
    channel: CHANNEL,
    sampling_rate: 100,
    period_seconds: 600,
    baseline_rsam: 40,
    // A PROPÓSITO distinto de baseline × factor (40 × 2.5 = 100): la línea
    // tiene que dibujarse en ESTE valor, no en uno recalculado.
    threshold_rsam: 123,
    tremor_fraction: 0.19,
    parameters: { baseline_factor: 2.5, min_duration_periods: 4 },
    samples,
    episodes: [],
    ...over,
  };
}

const TWO_EPISODES = [
  episode('2026-09-06T10:00:00Z', '2026-09-06T10:40:00Z'),
  episode('2026-09-06T11:20:00Z', '2026-09-06T11:50:00Z', { band: 'high', fi_sign: 'vt_like' }),
];

function renderPanel(channel: string | null) {
  return render(
    <IntlTestProvider>
      <TremorPanel channel={channel} window={WINDOW} />
    </IntlTestProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(getTremor).mockReset();
  composedChartProps.length = 0;
  referenceAreaProps.length = 0;
  referenceLineProps.length = 0;
});

describe('TremorPanel', () => {
  it('sin canal muestra "elegí un canal" y no pide nada', () => {
    renderPanel(null);
    expect(screen.getByText(es.analytics.picker.chooseChannel)).toBeInTheDocument();
    expect(getTremor).not.toHaveBeenCalled();
  });

  it('pide el tremor del canal con la ventana y muestra el loader mientras vuela', () => {
    vi.mocked(getTremor).mockReturnValue(new Promise(() => {}));
    renderPanel(CHANNEL);
    expect(getTremor).toHaveBeenCalledWith(CHANNEL, WINDOW);
    expect(screen.getByRole('status').textContent).toContain(es.analytics.tremor.loading);
  });

  it('episodes: [] ⇒ estado "sin episodios", cero filas y cero ReferenceArea', async () => {
    vi.mocked(getTremor).mockResolvedValue({ kind: 'data', data: respuesta({ tremor_fraction: 0 }) });
    renderPanel(CHANNEL);

    expect(await screen.findByText(es.analytics.tremor.noEpisodes)).toBeInTheDocument();
    expect(screen.queryAllByTestId('tremor-episode')).toHaveLength(0);
    expect(referenceAreaProps).toHaveLength(0);
    // El gráfico RSAM se muestra igual, con sus muestras.
    expect(composedChartProps.length).toBeGreaterThan(0);
    const rows = composedChartProps[composedChartProps.length - 1].data as Array<{ t: number; rsam: number }>;
    expect(rows.map((r) => r.rsam)).toEqual([40, 41, 42, 43]);
  });

  it('dos episodios ⇒ 2 filas con start/end en UTC y 2 ReferenceArea con esos bordes', async () => {
    vi.mocked(getTremor).mockResolvedValue({ kind: 'data', data: respuesta({ episodes: TWO_EPISODES }) });
    renderPanel(CHANNEL);

    const rows = await screen.findAllByTestId('tremor-episode');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('10:00');
    expect(rows[0].textContent).toContain('10:40');
    expect(rows[1].textContent).toContain('11:20');
    expect(rows[1].textContent).toContain('11:50');
    // Banda y signo de FI traducidos, del episodio (no de un default).
    expect(rows[0].textContent).toContain(es.analytics.tremor.band.low);
    expect(rows[0].textContent).toContain(es.analytics.tremor.fiSign.lp_like);
    expect(rows[1].textContent).toContain(es.analytics.tremor.band.high);
    expect(rows[1].textContent).toContain(es.analytics.tremor.fiSign.vt_like);
    expect(screen.queryByText(es.analytics.tremor.noEpisodes)).toBeNull();

    await waitFor(() => expect(referenceAreaProps).toHaveLength(2));
    expect(referenceAreaProps.map((p) => [p.x1, p.x2])).toEqual([
      [Date.parse('2026-09-06T10:00:00Z'), Date.parse('2026-09-06T10:40:00Z')],
      [Date.parse('2026-09-06T11:20:00Z'), Date.parse('2026-09-06T11:50:00Z')],
    ]);
  });

  it('la línea de umbral se dibuja en threshold_rsam TAL CUAL (123, no 40 × 2.5)', async () => {
    vi.mocked(getTremor).mockResolvedValue({ kind: 'data', data: respuesta() });
    renderPanel(CHANNEL);

    await waitFor(() => expect(referenceLineProps.length).toBeGreaterThan(0));
    const thresholds = referenceLineProps.filter((p) => p.y !== undefined).map((p) => p.y);
    expect(thresholds).toContain(123);
    expect(thresholds).not.toContain(100);
  });

  it('tremor_fraction y parameters salen de la respuesta', async () => {
    vi.mocked(getTremor).mockResolvedValue({ kind: 'data', data: respuesta() });
    renderPanel(CHANNEL);

    expect(await screen.findByText(es.analytics.tremor.fraction.replace('{percent}', '19.0 %'))).toBeInTheDocument();
    expect(
      screen.getByText(es.analytics.tremor.parameters.replace('{factor}', '2.5').replace('{periods}', '4')),
    ).toBeInTheDocument();
  });

  it('404 (no-data) ⇒ estado "sin datos para este canal", sin alert y sin crash', async () => {
    vi.mocked(getTremor).mockResolvedValue({ kind: 'no-data', detail: 'Sin datos FDSN para GE.KBU..BHZ' });
    renderPanel(CHANNEL);

    expect(await screen.findByText(es.analytics.tremor.noDataForChannel)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(composedChartProps).toHaveLength(0);
  });

  it('un rechazo (503) ⇒ role=alert del panel', async () => {
    vi.mocked(getTremor).mockRejectedValue(new Error('503'));
    renderPanel(CHANNEL);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(es.analytics.tremor.error);
  });

  it('la etiqueta dice "episodio sostenido (candidato a tremor)", nunca "tremor detectado"', async () => {
    vi.mocked(getTremor).mockResolvedValue({ kind: 'data', data: respuesta({ episodes: TWO_EPISODES }) });
    const { container } = renderPanel(CHANNEL);

    expect(await screen.findByText(es.analytics.tremor.sustainedEpisode)).toBeInTheDocument();
    expect(container.textContent?.toLowerCase()).not.toContain('tremor detectado');
    expect(container.textContent?.toLowerCase()).not.toContain('tremor detected');
  });
});
