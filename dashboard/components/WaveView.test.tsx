/**
 * Tests de `WaveView`.
 *
 * El canvas no se puede leer en jsdom, así que lo que se verifica es lo
 * observable: qué controles hay, y sobre todo QUÉ LLAMADAS produce un gesto.
 * Un re-render sin petición se ve casi igual que un zoom real y es incorrecto:
 * por eso los asertos del arrastre son sobre el callback, no sobre píxeles.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import type { WaveformResponse } from '@/hooks/use-wave-window';
import { MIN_DRAG_PX, type TimeWindow } from '@/lib/waveform-scale';
import { WaveView } from './WaveView';

const T0 = Date.UTC(2026, 7, 24, 12, 0, 0);
const WINDOW: TimeWindow = { startMs: T0, endMs: T0 + 600_000 };
const WIDTH = 960;
const HEIGHT = 280;
const MARGIN_LEFT = 56;

function waveform(): WaveformResponse {
  return {
    channel: 'AK.FIRE..BHZ',
    sampling_rate: 40,
    starttime: new Date(T0).toISOString(),
    endtime: new Date(T0 + 600_000).toISOString(),
    mins: [-3, -1, -4, -2],
    maxs: [3, 1, 4, 2],
  };
}

interface Overrides {
  window?: TimeWindow | null;
  data?: WaveformResponse | null;
  status?: 'idle' | 'loading' | 'ready' | 'error';
  canGoBack?: boolean;
  filter?: 'none' | 'bp';
}

function renderWave(over: Overrides = {}) {
  const onSelectWindow = vi.fn();
  const onGoBack = vi.fn();
  const onReset = vi.fn();
  const onFilterChange = vi.fn();

  render(
    <NextIntlClientProvider locale="es-AR" messages={es} timeZone="UTC">
      <WaveView
        window={over.window === undefined ? WINDOW : over.window}
        data={over.data === undefined ? waveform() : over.data}
        status={over.status ?? 'ready'}
        canGoBack={over.canGoBack ?? false}
        onSelectWindow={onSelectWindow}
        onGoBack={onGoBack}
        onReset={onReset}
        filter={over.filter ?? 'none'}
        onFilterChange={onFilterChange}
        width={WIDTH}
        height={HEIGHT}
      />
    </NextIntlClientProvider>,
  );

  return { onSelectWindow, onGoBack, onReset, onFilterChange };
}

/**
 * jsdom no hace layout: `getBoundingClientRect` devuelve todo en 0 y la
 * conversión CSS→canvas dividiría por cero. Se le da un rect del tamaño real
 * del canvas, que es el caso sin escalado.
 */
function stubRect(canvas: HTMLElement) {
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: WIDTH,
    height: HEIGHT,
    right: WIDTH,
    bottom: HEIGHT,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

function drag(canvas: HTMLElement, from: number, to: number) {
  fireEvent.mouseDown(canvas, { clientX: from, clientY: 100 });
  fireEvent.mouseMove(canvas, { clientX: to, clientY: 100 });
  fireEvent.mouseUp(canvas, { clientX: to, clientY: 100 });
}

afterEach(cleanup);

describe('WaveView', () => {
  it('la vista de onda NO dice "próximamente"', () => {
    renderWave();
    expect(screen.getByTestId('wave-view')).toBeTruthy();
    expect(screen.queryByText(/próximamente/i)).toBeNull();
  });

  it('un arrastre dispara UNA petición nueva con la ventana seleccionada', () => {
    // El aserto va sobre el callback, no sobre el canvas: un repintado sin
    // petición se ve parecido en pantalla y sería un bug silencioso.
    const { onSelectWindow } = renderWave();
    const canvas = screen.getByTestId('wave-canvas');
    stubRect(canvas);

    drag(canvas, MARGIN_LEFT + 200, MARGIN_LEFT + 500);

    expect(onSelectWindow).toHaveBeenCalledTimes(1);
    const selected: TimeWindow = onSelectWindow.mock.calls[0][0];
    // Valores a mano: plotWidth = 960 - 56 - 16 = 888. El arrastre 200..500
    // sobre una ventana de 600 s ⇒ 135,1 s .. 337,8 s desde el inicio.
    expect(selected.startMs).toBeCloseTo(T0 + (200 / 888) * 600_000, 0);
    expect(selected.endMs).toBeCloseTo(T0 + (500 / 888) * 600_000, 0);
    expect(selected.endMs).toBeGreaterThan(selected.startMs);
  });

  it('el arrastre mapea sobre la ventana del DATO mostrado, no sobre la pedida', () => {
    // El caso real de prod: el fetch de la ventana nueva falló y el canvas
    // conserva la onda anterior. La geometría tiene que corresponder a lo que
    // el usuario VE: mapear con la ventana pedida (que falló) daría un zoom
    // corrido sobre una onda que no es.
    const staleData = {
      ...waveform(),
      // El dato en pantalla cubre 100 s; la ventana pedida (prop) cubre 600 s.
      endtime: new Date(T0 + 100_000).toISOString(),
    };
    const { onSelectWindow } = renderWave({ data: staleData, status: 'error' });
    const canvas = screen.getByTestId('wave-canvas');
    stubRect(canvas);

    drag(canvas, MARGIN_LEFT + 0, MARGIN_LEFT + 444);

    expect(onSelectWindow).toHaveBeenCalledTimes(1);
    const selected: TimeWindow = onSelectWindow.mock.calls[0][0];
    // Media pantalla sobre los 100 s del DATO ⇒ 50 s, no 300 s de la pedida.
    // Un mapeo con la ventana pedida daría T0+300_000 y este aserto lo caza.
    expect(selected.startMs).toBeCloseTo(T0, 0);
    expect(selected.endMs).toBeCloseTo(T0 + 50_000, 0);
  });

  it('el arrastre invertido selecciona el mismo tramo', () => {
    const { onSelectWindow } = renderWave();
    const canvas = screen.getByTestId('wave-canvas');
    stubRect(canvas);

    drag(canvas, MARGIN_LEFT + 500, MARGIN_LEFT + 200);

    expect(onSelectWindow).toHaveBeenCalledTimes(1);
    const selected: TimeWindow = onSelectWindow.mock.calls[0][0];
    expect(selected.startMs).toBeCloseTo(T0 + (200 / 888) * 600_000, 0);
    expect(selected.endMs).toBeCloseTo(T0 + (500 / 888) * 600_000, 0);
  });

  it('un clic (arrastre por debajo del umbral) NO pide nada', () => {
    // Sin este corte, cada clic accidental dispararía un fetch de una ventana
    // de un píxel de ancho.
    const { onSelectWindow } = renderWave();
    const canvas = screen.getByTestId('wave-canvas');
    stubRect(canvas);

    drag(canvas, MARGIN_LEFT + 300, MARGIN_LEFT + 300 + MIN_DRAG_PX - 1);

    expect(onSelectWindow).not.toHaveBeenCalled();
  });

  it('soltar el mouse fuera del canvas cancela el arrastre', () => {
    const { onSelectWindow } = renderWave();
    const canvas = screen.getByTestId('wave-canvas');
    stubRect(canvas);

    fireEvent.mouseDown(canvas, { clientX: MARGIN_LEFT + 100, clientY: 100 });
    fireEvent.mouseLeave(canvas);
    fireEvent.mouseUp(canvas, { clientX: MARGIN_LEFT + 600, clientY: 100 });

    expect(onSelectWindow).not.toHaveBeenCalled();
  });

  describe('controles', () => {
    it('"volver atrás" está deshabilitado sin pila y habilitado con pila', () => {
      const { onGoBack } = renderWave({ canGoBack: false });
      const back = screen.getByRole('button', { name: es.station.waveBack });
      expect((back as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(back);
      expect(onGoBack).not.toHaveBeenCalled();

      cleanup();
      const second = renderWave({ canGoBack: true });
      const enabled = screen.getByRole('button', { name: es.station.waveBack });
      expect((enabled as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(enabled);
      expect(second.onGoBack).toHaveBeenCalledTimes(1);
    });

    it('"ventana inicial" llama a reset', () => {
      const { onReset } = renderWave();
      fireEvent.click(screen.getByRole('button', { name: es.station.waveReset }));
      expect(onReset).toHaveBeenCalledTimes(1);
    });

    it('el toggle del filtro propaga bp y none', () => {
      const { onFilterChange } = renderWave({ filter: 'none' });
      const toggle = screen.getByLabelText(es.station.filter);
      expect((toggle as HTMLInputElement).checked).toBe(false);

      fireEvent.click(toggle);
      expect(onFilterChange).toHaveBeenCalledWith('bp');

      cleanup();
      const second = renderWave({ filter: 'bp' });
      const checked = screen.getByLabelText(es.station.filter);
      expect((checked as HTMLInputElement).checked).toBe(true);
      fireEvent.click(checked);
      expect(second.onFilterChange).toHaveBeenCalledWith('none');
    });
  });

  describe('estados', () => {
    it('muestra el cartel de carga mientras se pide el dato', () => {
      renderWave({ status: 'loading' });
      expect(screen.getByTestId('wave-loading')).toBeTruthy();
    });

    it('muestra el error sin tirar abajo la vista', () => {
      renderWave({ status: 'error' });
      expect(screen.getByTestId('wave-error')).toBeTruthy();
      // El canvas sigue montado: perder una ventana no debe desmontar la vista.
      expect(screen.getByTestId('wave-canvas')).toBeTruthy();
    });

    it('sin dato todavía no rompe el render', () => {
      renderWave({ data: null, status: 'loading' });
      expect(screen.getByTestId('wave-canvas')).toBeTruthy();
    });

    it('sin ventana no dispara selecciones', () => {
      const { onSelectWindow } = renderWave({ window: null, data: null, status: 'idle' });
      const canvas = screen.getByTestId('wave-canvas');
      stubRect(canvas);
      drag(canvas, MARGIN_LEFT + 100, MARGIN_LEFT + 600);
      expect(onSelectWindow).not.toHaveBeenCalled();
    });
  });
});
