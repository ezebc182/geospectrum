/**
 * Corte de profundidad de /analytics (analytics-professional-panels, 5.9).
 *
 * Recharts se mockea capturando props (patrón de los otros paneles de la fase):
 * `ResponsiveContainer` mide 0×0 en jsdom y el SVG no se assertea nunca. Lo
 * verificable es la transformación y las props que llegan al gráfico — sobre
 * todo `YAxis reversed`, que es lo que hace que la profundidad crezca hacia
 * ABAJO; sin eso el corte estaría dado vuelta y no se vería en el DOM.
 */

import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import { IntlTestProvider } from '@/lib/test-intl';
import type { SeismicEvent } from '@/lib/types';

import { DepthSectionChart } from './DepthSectionChart';

const A = es.analytics;

const scatterChartProps: Array<Record<string, unknown>> = [];
const yAxisProps: Array<Record<string, unknown>> = [];
const scatterProps: Array<Record<string, unknown>> = [];
const cellProps: Array<Record<string, unknown>> = [];
const gridProps: Array<Record<string, unknown>> = [];
const tooltipProps: Array<Record<string, unknown>> = [];

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScatterChart: (props: Record<string, unknown> & { children?: ReactNode }) => {
    scatterChartProps.push(props);
    return <div data-testid="scatter-chart">{props.children}</div>;
  },
  Scatter: (props: Record<string, unknown> & { children?: ReactNode }) => {
    scatterProps.push(props);
    return <div>{props.children}</div>;
  },
  Cell: (props: Record<string, unknown>) => {
    cellProps.push(props);
    return null;
  },
  XAxis: () => null,
  YAxis: (props: Record<string, unknown>) => {
    yAxisProps.push(props);
    return null;
  },
  ZAxis: () => null,
  CartesianGrid: (props: Record<string, unknown>) => {
    gridProps.push(props);
    return null;
  },
  Tooltip: (props: Record<string, unknown>) => {
    tooltipProps.push(props);
    return null;
  },
}));

function evento(over: Partial<SeismicEvent> = {}): SeismicEvent {
  return {
    id: 'ev',
    fuentes: ['USGS'],
    hora_utc: '2026-09-06T12:00:00Z',
    lat: -33,
    lon: -70,
    prof_km: 50,
    mag: 4.2,
    mag_tipo: 'mb',
    lugar: 'Lugar',
    sentido: false,
    revisado: true,
    ...over,
  };
}

function renderChart(eventos: SeismicEvent[]) {
  render(
    <IntlTestProvider>
      <DepthSectionChart eventos={eventos} />
    </IntlTestProvider>,
  );
}

afterEach(() => {
  cleanup();
  scatterChartProps.length = 0;
  yAxisProps.length = 0;
  scatterProps.length = 0;
  cellProps.length = 0;
  gridProps.length = 0;
  tooltipProps.length = 0;
});

describe('DepthSectionChart', () => {
  it('pinta un punto por evento con profundidad y avisa de los omitidos', () => {
    renderChart([
      evento({ id: 'a', prof_km: 10 }),
      evento({ id: 'b', prof_km: null }),
      evento({ id: 'c', prof_km: 200 }),
    ]);

    expect(screen.getByText(A.depthSection.title)).toBeInTheDocument();
    const data = scatterChartProps[0].data as Array<{ id: string }>;
    expect(data.map((p) => p.id)).toEqual(['a', 'c']);
    expect(screen.getByText(A.depthSection.omittedNoDepth.replace('{count}', '1'))).toBeInTheDocument();
  });

  it('sin omitidos no muestra el aviso', () => {
    renderChart([evento({ id: 'a', prof_km: 10 })]);

    expect(screen.queryByText(/omitidos/)).toBeNull();
  });

  it('el eje de profundidad va invertido (hacia abajo)', () => {
    renderChart([evento({ prof_km: 10 })]);

    expect(yAxisProps[0].reversed).toBe(true);
  });

  it('el dominio del eje arranca en 0 y crece hacia abajo, sin negativos inventados', () => {
    // El bug: sin `domain` explicito Recharts "redondeaba" el eje hacia el
    // otro lado y dibujaba 0 arriba y -105 subiendo. La profundidad es
    // positiva hacia ABAJO, asi que el dominio tiene que arrancar en 0.
    renderChart([evento({ id: 'a', prof_km: 105 })]);

    const [min] = yAxisProps[0].domain as [number, unknown];
    expect(min).toBe(0);
  });

  it('los ticks del eje se muestran como profundidad POSITIVA', () => {
    renderChart([evento({ prof_km: 105 })]);

    const formatter = yAxisProps[0].tickFormatter as (v: number) => string;
    expect(formatter(105)).toBe('105');
    expect(formatter(0)).toBe('0');
  });

  it('un evento SOBRE el nivel del mar mantiene su signo negativo', () => {
    // Dato real de prod (EMSC/USGS): hipocentro sobre el nivel del mar. Se
    // dibuja ARRIBA de la linea de 0 y el tick conserva el signo — decir "35"
    // donde el dato es -35 seria mentir sobre la ubicacion del evento.
    renderChart([evento({ id: 'aereo', prof_km: -35 })]);

    const data = scatterChartProps[0].data as Array<{ depthKm: number }>;
    expect(data[0].depthKm).toBe(-35);

    const [min] = yAxisProps[0].domain as [number, unknown];
    expect(min, 'con un evento sobre el nivel del mar el eje tiene que abrirse').toBe(-35);

    const formatter = yAxisProps[0].tickFormatter as (v: number) => string;
    expect(formatter(-35)).toBe('-35');
  });

  it('el cromo del grafico sale de tokens del tema, no de hex fijos', () => {
    renderChart([evento({ prof_km: 10 })]);

    expect(gridProps[0].stroke).toMatch(/^hsl\(var\(--/);
    expect(yAxisProps[0].stroke).toMatch(/^hsl\(var\(--/);
    const contentStyle = tooltipProps[0].contentStyle as Record<string, string>;
    expect(contentStyle.backgroundColor).toMatch(/^hsl\(var\(--/);
    expect(contentStyle.color).toMatch(/^hsl\(var\(--/);
  });

  it('cada punto lleva el color de SU magnitud', () => {
    renderChart([evento({ id: 'micro', mag: 2, prof_km: 10 }), evento({ id: 'mayor', mag: 6.5, prof_km: 40 })]);

    expect(cellProps.map((c) => c.fill)).toEqual(['#14b8a6', '#dc2626']);
  });

  it('sin eventos con profundidad no dibuja el gráfico', () => {
    renderChart([evento({ prof_km: null })]);

    expect(screen.queryByTestId('scatter-chart')).toBeNull();
    expect(screen.getByText(A.depthSection.omittedNoDepth.replace('{count}', '1'))).toBeInTheDocument();
  });
});
