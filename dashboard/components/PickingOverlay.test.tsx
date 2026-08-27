/**
 * Escenarios de la tarea 5.28: marcar P sin submenú, la distancia con P+S,
 * el orden inválido SIN NaN ni negativos, la coda de 100 s ⇒ 2.87, y que
 * borrar la S hace desaparecer la distancia dejando la magnitud visible.
 *
 * Las mediciones entran por computeMeasurements (la copia TS de las
 * fórmulas): así el test cubre lib + componente juntos, con los mismos
 * valores a mano del espejo de Python.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import { computeMeasurements, type SignalPick } from '@/lib/signal-picks';
import { PickingOverlay, PickingPanel } from './PickingOverlay';

const T0 = Date.UTC(2026, 7, 23, 14, 0, 0);
// Ventana de 888 s en un plot de 888 px (960 - 56 - 16): 1 px = 1 s, así los
// valores esperados del clic se calculan de cabeza y no repiten la fórmula.
const WINDOW = { startMs: T0, endMs: T0 + 888_000 };

function pick(id: string, phase: SignalPick['phase'], offsetMs: number, note: string | null = null): SignalPick {
  return {
    id,
    channel: 'AK.FIRE..BHZ',
    phase,
    pickTime: new Date(T0 + offsetMs).toISOString(),
    note,
  };
}

const MEASUREMENTS_EMPTY = computeMeasurements([]);

function renderPanel(props: Partial<Parameters<typeof PickingPanel>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="es-AR" messages={es} timeZone="UTC">
      <PickingPanel
        picks={[]}
        measurements={MEASUREMENTS_EMPTY}
        status="ready"
        armedPhase={null}
        onArmPhase={() => {}}
        onRemovePick={() => {}}
        note=""
        onNoteChange={() => {}}
        exportVisible={false}
        onExport={() => {}}
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

function renderOverlay(props: Partial<Parameters<typeof PickingOverlay>[0]> = {}) {
  return render(
    <PickingOverlay
      window={WINDOW}
      picks={[]}
      armedPhase={null}
      onPickAt={() => {}}
      width={960}
      height={280}
      {...props}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PickingPanel — armado de un solo nivel', () => {
  it('marcar P es UNA acción: un clic en el botón arma la fase, sin submenús', () => {
    const onArmPhase = vi.fn();
    renderPanel({ onArmPhase });

    fireEvent.click(screen.getByRole('button', { name: 'Marcar P' }));

    expect(onArmPhase).toHaveBeenCalledTimes(1);
    expect(onArmPhase).toHaveBeenCalledWith('P');
  });

  it('con P y S marcadas muestra la distancia calculada, no un placeholder', () => {
    // S-P = 11.4 s ⇒ 11.4 × 8.219178 = 93.699 km (mismo valor del test de Python)
    const picks = [pick('a', 'P', 0), pick('b', 'S', 11_400)];
    renderPanel({ picks, measurements: computeMeasurements(picks) });

    const distance = screen.getByTestId('picking-distance');
    expect(distance.textContent).toContain('11.4');
    expect(distance.textContent).toContain('93.7');
  });

  it('con S ANTES que P indica orden inválido, sin NaN ni números negativos', () => {
    const picks = [pick('a', 'S', 0), pick('b', 'P', 11_400)];
    const { container } = renderPanel({ picks, measurements: computeMeasurements(picks) });

    expect(screen.getByTestId('picking-invalid-order')).toBeTruthy();
    expect(screen.queryByTestId('picking-distance')).toBeNull();
    expect(container.textContent).not.toContain('NaN');
    expect(container.textContent).not.toMatch(/-\d+(\.\d+)?\s*km/);
  });

  it('con coda de 100 s muestra Mc 2.87', () => {
    const picks = [pick('a', 'P', 0), pick('b', 'coda', 100_000)];
    renderPanel({ picks, measurements: computeMeasurements(picks) });

    const magnitude = screen.getByTestId('picking-magnitude');
    expect(magnitude.textContent).toContain('2.87');
  });

  it('sin el pick S la distancia desaparece y la magnitud de coda sigue visible', () => {
    // El "borrar S" del escenario: el estado resultante es picks = [P, coda].
    const picks = [pick('a', 'P', 0), pick('c', 'coda', 100_000)];
    renderPanel({ picks, measurements: computeMeasurements(picks) });

    expect(screen.queryByTestId('picking-distance')).toBeNull();
    expect(screen.getByTestId('picking-magnitude').textContent).toContain('2.87');
  });

  it('el botón de borrar llama al callback con el id del pick', () => {
    const onRemovePick = vi.fn();
    const picks = [pick('pick-s', 'S', 11_400)];
    renderPanel({ picks, measurements: computeMeasurements(picks), onRemovePick });

    fireEvent.click(screen.getByRole('button', { name: 'Borrar el pick S' }));

    expect(onRemovePick).toHaveBeenCalledWith('pick-s');
  });

  it('el export sólo aparece con la herramienta visible Y picks hechos', () => {
    const picks = [pick('a', 'P', 0)];
    renderPanel({ picks, measurements: computeMeasurements(picks), exportVisible: false });
    expect(screen.queryByRole('button', { name: 'Exportar CSV' })).toBeNull();
    cleanup();

    renderPanel({ picks, measurements: computeMeasurements(picks), exportVisible: true });
    expect(screen.getByRole('button', { name: 'Exportar CSV' })).toBeTruthy();
  });
});

describe('PickingOverlay — la capa sobre el canvas', () => {
  it('el pick se dibuja en el instante marcado, con la misma geometría del zoom', () => {
    // P a 500 s del inicio: con 1 px = 1 s, la línea cae en 56 + 500 - 1 px.
    renderOverlay({ picks: [pick('a', 'P', 500_000)] });

    const line = screen.getByTestId('pick-line-P');
    expect(line.style.left).toBe('555px');
  });

  it('con una fase armada, el clic traduce el píxel al instante y lo entrega', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 960, height: 280, right: 960, bottom: 280, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const onPickAt = vi.fn();
    renderOverlay({ armedPhase: 'P', onPickAt });

    // clientX 556 ⇒ x del plot = 500 ⇒ instante T0 + 500 s (1 px = 1 s).
    fireEvent.click(screen.getByTestId('picking-overlay'), { clientX: 556 });

    expect(onPickAt).toHaveBeenCalledTimes(1);
    expect(onPickAt).toHaveBeenCalledWith(T0 + 500_000);
  });

  it('sin fase armada la capa no captura gestos: el zoom del canvas sigue vivo', () => {
    const onPickAt = vi.fn();
    renderOverlay({ armedPhase: null, onPickAt });

    const layer = screen.getByTestId('picking-overlay');
    expect(layer.style.pointerEvents).toBe('none');
    fireEvent.click(layer, { clientX: 556 });
    expect(onPickAt).not.toHaveBeenCalled();
  });

  it('un pick fuera de la ventana visible no se dibuja', () => {
    renderOverlay({ picks: [pick('a', 'P', 900_000_000)] });

    expect(screen.queryByTestId('pick-line-P')).toBeNull();
  });
});

describe('PickingOverlay — apuntes anclados a la onda', () => {
  const NOTES = [
    { id: 'n1', timeMs: WINDOW.startMs + 444_000, label: 'acá arranca el evento' },
    { id: 'n2', timeMs: WINDOW.startMs - 60_000, label: 'fuera de la ventana' },
  ];

  it('dibuja una bandera por apunte DENTRO de la ventana visible', () => {
    renderOverlay({ annotations: NOTES });
    const flags = screen.getAllByTestId('annotation-flag');
    expect(flags).toHaveLength(1);
    expect(flags[0].getAttribute('title')).toBe('acá arranca el evento');
  });

  it('con el modo apunte armado, el clic entrega el instante señalado', () => {
    const onAnnotateAt = vi.fn();
    renderOverlay({ annotateArmed: true, onAnnotateAt });

    const overlay = screen.getByTestId('picking-overlay');
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 960, height: 280, right: 960, bottom: 280, x: 0, y: 0 }) as DOMRect;
    // Mismo cálculo que el test del pick: 1 px = 1 s en este harness
    // (ventana de 888 s sobre 888 px de plot). clientX 500 ⇒ T0 + 444 s.
    fireEvent.click(overlay, { clientX: 500, clientY: 140 });

    expect(onAnnotateAt).toHaveBeenCalledTimes(1);
    expect(onAnnotateAt).toHaveBeenCalledWith(WINDOW.startMs + 444_000);
  });

  it('sin modo apunte ni fase armada, la capa sigue transparente al zoom', () => {
    renderOverlay({ annotations: NOTES });
    expect(screen.getByTestId('picking-overlay').style.pointerEvents).toBe('none');
  });
});
