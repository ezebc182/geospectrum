/**
 * Magnitud vs tiempo (analytics-redesign, Fase 1).
 *
 * Recharts se mockea capturando props, igual que `DepthSectionChart.test.tsx`:
 * `ResponsiveContainer` mide 0×0 en jsdom y el SVG no se assertea nunca. Lo
 * verificable es la transformación de eventos a puntos y las props que llegan
 * al gráfico.
 *
 * Lo que este archivo NO puede probar, y por eso no lo intenta: contraste
 * efectivo, recortes, tamaños ni visibilidad. jsdom no hace layout y no
 * resuelve `hsl(var(--token))` contra la cascada, así que cualquier assert de
 * ese tipo sería verde falso. El contraste real lo confirma el QA visual.
 */

import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHART_AXIS_STROKE, CHART_GRID_STROKE } from '@/lib/chart-theme';
import { IntlTestProvider } from '@/lib/test-intl';
import type { SeismicEvent } from '@/lib/types';
import { getMagnitudeColor } from '@/lib/utils';

import { MagnitudeTimeChart } from './MagnitudeTimeChart';

const scatterProps: Array<Record<string, unknown>> = [];
const cellProps: Array<Record<string, unknown>> = [];
const gridProps: Array<Record<string, unknown>> = [];
const xAxisProps: Array<Record<string, unknown>> = [];
const yAxisProps: Array<Record<string, unknown>> = [];
const tooltipProps: Array<Record<string, unknown>> = [];
const referenceLineProps: Array<Record<string, unknown>> = [];

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScatterChart: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Scatter: (props: Record<string, unknown> & { children?: ReactNode }) => {
    scatterProps.push(props);
    return <div>{props.children}</div>;
  },
  Cell: (props: Record<string, unknown>) => {
    cellProps.push(props);
    return null;
  },
  XAxis: (props: Record<string, unknown>) => {
    xAxisProps.push(props);
    return null;
  },
  YAxis: (props: Record<string, unknown>) => {
    yAxisProps.push(props);
    return null;
  },
  CartesianGrid: (props: Record<string, unknown>) => {
    gridProps.push(props);
    return null;
  },
  Tooltip: (props: Record<string, unknown>) => {
    tooltipProps.push(props);
    return null;
  },
  ReferenceLine: (props: Record<string, unknown>) => {
    referenceLineProps.push(props);
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
      <MagnitudeTimeChart eventos={eventos} />
    </IntlTestProvider>,
  );
}

afterEach(() => {
  cleanup();
  scatterProps.length = 0;
  cellProps.length = 0;
  gridProps.length = 0;
  xAxisProps.length = 0;
  yAxisProps.length = 0;
  tooltipProps.length = 0;
  referenceLineProps.length = 0;
});

describe('MagnitudeTimeChart', () => {
  it('convierte cada evento en un punto con tiempo, magnitud, lugar y color', () => {
    renderChart([
      evento({ id: 'a', hora_utc: '2026-09-06T12:00:00Z', mag: 2, lugar: 'Mendoza' }),
      evento({ id: 'b', hora_utc: '2026-09-06T18:30:00Z', mag: 6.5, lugar: 'San Juan' }),
    ]);

    const data = scatterProps[0].data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(2);
    expect(data[0]).toEqual({
      timestamp: Date.parse('2026-09-06T12:00:00Z'),
      mag: 2,
      lugar: 'Mendoza',
      color: getMagnitudeColor(2),
    });
    expect(data[1].timestamp).toBe(Date.parse('2026-09-06T18:30:00Z'));
    expect(data[1].lugar).toBe('San Juan');
  });

  it('el cromo del gráfico sale de los tokens del tema, no de hex fijos', () => {
    renderChart([evento()]);

    // Contra la CONSTANTE importada, no contra el string literal: si mañana
    // cambia el token, el test sigue siendo correcto sin tocarlo.
    expect(gridProps[0].stroke).toBe(CHART_GRID_STROKE);
    expect(xAxisProps[0].stroke).toBe(CHART_AXIS_STROKE);
    expect(yAxisProps[0].stroke).toBe(CHART_AXIS_STROKE);
  });

  /**
   * Este panel dibuja el tooltip con `content` propio (markup nuestro con
   * clases de Tailwind tematizadas), así que las tres props del renderer por
   * defecto de Recharts NO le aplican: pasárselas sería código muerto.
   */
  it('no adopta el renderer de tooltip por defecto', () => {
    renderChart([evento()]);

    expect(tooltipProps[0].contentStyle).toBeUndefined();
    expect(tooltipProps[0].labelStyle).toBeUndefined();
    expect(tooltipProps[0].itemStyle).toBeUndefined();
    expect(tooltipProps[0].content).toBeTypeOf('function');
  });

  it('cada punto conserva el color de SU magnitud y los umbrales su severidad', () => {
    renderChart([evento({ id: 'micro', mag: 2 }), evento({ id: 'mayor', mag: 6.5 })]);

    // El color de magnitud es DATO: no se tematiza, sale de getMagnitudeColor.
    expect(cellProps.map((c) => c.fill)).toEqual([getMagnitudeColor(2), getMagnitudeColor(6.5)]);

    // Las dos ReferenceLine son la escala de severidad M5.0 / M4.0, también dato.
    const porUmbral = Object.fromEntries(referenceLineProps.map((p) => [p.y as number, p.stroke]));
    expect(porUmbral[5]).toBe('#ef4444');
    expect(porUmbral[4]).toBe('#f59e0b');
  });

  it('con una lista vacía renderiza sin lanzar', () => {
    expect(() => renderChart([])).not.toThrow();

    expect(scatterProps[0].data).toEqual([]);
  });
});
