/**
 * Distribución de profundidades (analytics-redesign, Fase 1).
 *
 * Recharts se mockea capturando props, igual que `DepthSectionChart.test.tsx`:
 * `ResponsiveContainer` mide 0×0 en jsdom y el SVG no se assertea nunca. Lo
 * verificable es el binning y las props que llegan al gráfico.
 *
 * Lo que este archivo NO puede probar, y por eso no lo intenta: contraste
 * efectivo, recortes ni visibilidad. jsdom no hace layout y no resuelve
 * `hsl(var(--token))` contra la cascada. El contraste real lo confirma el QA
 * visual — sobre todo el del tooltip, que es el defecto que arregla `itemStyle`.
 */

import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHART_AXIS_STROKE,
  CHART_GRID_STROKE,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_ITEM_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
} from '@/lib/chart-theme';
import { IntlTestProvider } from '@/lib/test-intl';
import type { SeismicEvent } from '@/lib/types';
import { getDepthColor } from '@/lib/utils';

import { DepthDistributionChart } from './DepthDistributionChart';

const barChartProps: Array<Record<string, unknown>> = [];
const cellProps: Array<Record<string, unknown>> = [];
const gridProps: Array<Record<string, unknown>> = [];
const xAxisProps: Array<Record<string, unknown>> = [];
const yAxisProps: Array<Record<string, unknown>> = [];
const tooltipProps: Array<Record<string, unknown>> = [];

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: (props: Record<string, unknown> & { children?: ReactNode }) => {
    barChartProps.push(props);
    return <div>{props.children}</div>;
  },
  Bar: (props: { children?: ReactNode }) => <div>{props.children}</div>,
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
      <DepthDistributionChart eventos={eventos} />
    </IntlTestProvider>,
  );
}

/** Los `count` de los cuatro bins, en orden de profundidad creciente. */
function counts(): number[] {
  const bins = barChartProps[0].data as Array<{ count: number }>;
  return bins.map((b) => b.count);
}

afterEach(() => {
  cleanup();
  barChartProps.length = 0;
  cellProps.length = 0;
  gridProps.length = 0;
  xAxisProps.length = 0;
  yAxisProps.length = 0;
  tooltipProps.length = 0;
});

describe('DepthDistributionChart', () => {
  it('reparte los eventos en los cuatro rangos de profundidad', () => {
    renderChart([
      evento({ id: 'a', prof_km: 10 }), // <70
      evento({ id: 'b', prof_km: 69.9 }), // <70
      evento({ id: 'c', prof_km: 70 }), // 70-150, borde inferior inclusivo
      evento({ id: 'd', prof_km: 200 }), // 150-300
      evento({ id: 'e', prof_km: 300 }), // >300, borde inferior inclusivo
      evento({ id: 'f', prof_km: 5000 }), // >300
    ]);

    expect(counts()).toEqual([2, 1, 1, 2]);

    // El orden de los bins coincide con los cortes de getDepthColor.
    const bins = barChartProps[0].data as Array<{ name: string }>;
    expect(bins.map((b) => b.name)).toEqual(['<70 km', '70-150 km', '150-300 km', '>300 km']);
  });

  it('el cromo del gráfico sale de los tokens del tema, no de hex fijos', () => {
    renderChart([evento()]);

    expect(gridProps[0].stroke).toBe(CHART_GRID_STROKE);
    expect(xAxisProps[0].stroke).toBe(CHART_AXIS_STROKE);
    expect(yAxisProps[0].stroke).toBe(CHART_AXIS_STROKE);
  });

  /**
   * Recharts estila el tooltip por defecto en TRES tramos independientes y el
   * `color` de `contentStyle` NO cascadea a las filas: sin `itemStyle`, cada
   * fila hereda el color de SU serie. Ese era el bug de oscuro.
   *
   * Se comparan por IDENTIDAD referencial (`toBe` contra la constante
   * importada), no con un objeto inline: con `toEqual` una copia a mano con los
   * mismos valores pasaría el test, y el objeto inline es justamente el defecto
   * original que esta fase vino a eliminar.
   */
  it('pasa las tres props del tooltip apuntando a las constantes del tema', () => {
    renderChart([evento()]);

    expect(tooltipProps[0].contentStyle).toBe(CHART_TOOLTIP_CONTENT_STYLE);
    expect(tooltipProps[0].labelStyle).toBe(CHART_TOOLTIP_LABEL_STYLE);
    expect(tooltipProps[0].itemStyle, 'sin itemStyle cada fila hereda el color de la serie').toBe(
      CHART_TOOLTIP_ITEM_STYLE,
    );
  });

  it('cada barra conserva el hex de su bin de profundidad', () => {
    renderChart([evento()]);

    // Los colores de profundidad son DATO: no se tematizan. Se comparan contra
    // getDepthColor, la fuente de verdad de la escala.
    expect(cellProps.map((c) => c.fill)).toEqual([
      getDepthColor(0),
      getDepthColor(70),
      getDepthColor(150),
      getDepthColor(300),
    ]);
  });

  /**
   * El componente filtra con `if (ev.prof_km)`, que es TRUTHINESS: descarta
   * `null` y también `prof_km: 0` (un evento superficial, dato legítimo).
   *
   * Este test DOCUMENTA el comportamiento actual tal cual es — no lo arregla.
   * Cambiar el binning es comportamiento de producto y esta fase declara
   * "MODIFIED Requirements: Ninguno". Si `0 km` tiene que contar, es otro change
   * y este assert es el que hay que actualizar a propósito.
   */
  it('un evento sin profundidad no entra en ningún bin (y hoy 0 km tampoco)', () => {
    renderChart([
      evento({ id: 'sin-dato', prof_km: null }),
      evento({ id: 'superficial', prof_km: 0 }),
      evento({ id: 'con-dato', prof_km: 10 }),
    ]);

    // Solo cuenta el de 10 km: el null y el 0 quedan afuera por truthiness.
    expect(counts()).toEqual([1, 0, 0, 0]);
  });

  it('con una lista vacía renderiza sin lanzar y deja los cuatro bins en cero', () => {
    expect(() => renderChart([])).not.toThrow();

    expect(counts()).toEqual([0, 0, 0, 0]);
  });
});
