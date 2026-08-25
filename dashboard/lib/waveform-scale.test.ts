import { describe, expect, it } from 'vitest';
import {
  MAX_WINDOW_MS,
  MIN_DRAG_PX,
  MIN_WINDOW_MS,
  clampWindow,
  dragSelection,
  timeToX,
  windowDurationMs,
  windowToQuery,
  xToTime,
  zoomWindow,
} from './waveform-scale';

/** Ventana de referencia: 10 minutos arrancando en un instante redondo. */
const T0 = Date.UTC(2026, 7, 24, 12, 0, 0);
const WINDOW = { startMs: T0, endMs: T0 + 600_000 };
const PLOT_WIDTH = 1000;

describe('timeToX / xToTime', () => {
  it('mapea los extremos a 0 y a plotWidth', () => {
    expect(timeToX(WINDOW.startMs, WINDOW, PLOT_WIDTH)).toBe(0);
    expect(timeToX(WINDOW.endMs, WINDOW, PLOT_WIDTH)).toBe(PLOT_WIDTH);
  });

  it('mapea el centro al centro', () => {
    expect(timeToX(T0 + 300_000, WINDOW, PLOT_WIDTH)).toBe(500);
  });

  // Cinco valores, no uno: con un solo punto una fórmula con el signo invertido
  // podría coincidir por casualidad (el centro es punto fijo de varias
  // transformaciones incorrectas).
  it.each([0, 1, 250, 733, 1000])('ida y vuelta xToTime(timeToX) para x=%i', (x) => {
    const t = xToTime(x, WINDOW, PLOT_WIDTH);
    expect(timeToX(t, WINDOW, PLOT_WIDTH)).toBeCloseTo(x, 6);
  });

  it('xToTime crece con x (el signo no está invertido)', () => {
    expect(xToTime(100, WINDOW, PLOT_WIDTH)).toBeLessThan(
      xToTime(900, WINDOW, PLOT_WIDTH),
    );
  });

  it('devuelve valores neutros en vez de NaN con ancho o duración cero', () => {
    // El punto de MIN_WINDOW_MS es evitar esto aguas arriba, pero las funciones
    // no deben propagar NaN si igual les llega una ventana degenerada.
    expect(timeToX(T0, { startMs: T0, endMs: T0 }, PLOT_WIDTH)).toBe(0);
    expect(xToTime(500, WINDOW, 0)).toBe(WINDOW.startMs);
  });
});

describe('clampWindow', () => {
  it('deja intacta una ventana ya válida', () => {
    expect(clampWindow(WINDOW)).toEqual(WINDOW);
  });

  it('ordena los extremos invertidos', () => {
    expect(clampWindow({ startMs: WINDOW.endMs, endMs: WINDOW.startMs })).toEqual(WINDOW);
  });

  it('una ventana degenerada (start === end) queda con duración MIN_WINDOW_MS', () => {
    const clamped = clampWindow({ startMs: T0, endMs: T0 });
    // El aserto va contra el valor LITERAL, no contra `MIN_WINDOW_MS`: si
    // comparara con la constante, bajarla a 0 dejaría el test en verde
    // midiendo 0 === 0 — un test que no puede fallar por el motivo que dice
    // estar cubriendo.
    expect(windowDurationMs(clamped)).toBe(1_000);
    // Y la razón de fondo: una ventana de duración 0 hace que `timeToX`
    // devuelva siempre lo mismo y el canvas no dibuje nada, en silencio.
    expect(windowDurationMs(clamped)).toBeGreaterThan(0);
  });

  it('expande SIMÉTRICO: el centro no se mueve', () => {
    const clamped = clampWindow({ startMs: T0, endMs: T0 });
    // Valores a mano: MIN_WINDOW_MS = 1000 ⇒ ±500 alrededor de T0.
    expect(clamped.startMs).toBe(T0 - 500);
    expect(clamped.endMs).toBe(T0 + 500);
    expect((clamped.startMs + clamped.endMs) / 2).toBe(T0);
  });

  it('recorta simétrico una ventana por encima del máximo', () => {
    const huge = { startMs: T0, endMs: T0 + MAX_WINDOW_MS * 3 };
    const center = (huge.startMs + huge.endMs) / 2;
    const clamped = clampWindow(huge);
    expect(windowDurationMs(clamped)).toBe(MAX_WINDOW_MS);
    expect((clamped.startMs + clamped.endMs) / 2).toBe(center);
  });

  it('no propaga valores no finitos', () => {
    const clamped = clampWindow({ startMs: Number.NaN, endMs: T0 });
    expect(Number.isFinite(clamped.startMs)).toBe(true);
    expect(Number.isFinite(clamped.endMs)).toBe(true);
  });
});

describe('zoomWindow', () => {
  /**
   * El caso del diseño, con números elegidos para que un zoom CENTRADO dé un
   * resultado distinto: ancla al 25% del ancho con factor 0.5 da [12.5%, 62.5%]
   * de la ventana original; centrar daría [25%, 75%]. Un test que sólo
   * verificara "la duración se redujo a la mitad" no distinguiría ambas
   * implementaciones.
   *
   * El diseño escribe el caso como [0,100] → [12.5, 62.5]. Acá va ×1000
   * porque en milisegundos literales esa ventana dura 100 ms, cae por debajo
   * de MIN_WINDOW_MS y `clampWindow` la reescribe: se estaría midiendo el
   * clamp en vez del anclaje. Las proporciones son las mismas.
   */
  it('deja el instante del ancla en el mismo píxel', () => {
    const w = { startMs: 0, endMs: 100_000 };
    const zoomed = zoomWindow(w, 25, 100, 0.5);
    expect(zoomed.startMs).toBeCloseTo(12_500, 6);
    expect(zoomed.endMs).toBeCloseTo(62_500, 6);
    // Explícito: un zoom centrado daría [25_000, 75_000]. Si algún día alguien
    // "simplifica" ignorando anchorX, este aserto es el que se pone rojo.
    expect(zoomed.startMs).not.toBeCloseTo(25_000, 6);
  });

  it('el instante bajo el cursor no se mueve de píxel (propiedad general)', () => {
    const anchorX = 300;
    const before = xToTime(anchorX, WINDOW, PLOT_WIDTH);
    const zoomed = zoomWindow(WINDOW, anchorX, PLOT_WIDTH, 0.4);
    const after = xToTime(anchorX, zoomed, PLOT_WIDTH);
    expect(after).toBeCloseTo(before, 6);
  });

  it('factor < 1 acerca y factor > 1 aleja', () => {
    expect(windowDurationMs(zoomWindow(WINDOW, 500, PLOT_WIDTH, 0.5))).toBe(300_000);
    expect(windowDurationMs(zoomWindow(WINDOW, 500, PLOT_WIDTH, 2))).toBe(1_200_000);
  });

  it('el resultado ya viene clampeado: un zoom extremo no baja de MIN_WINDOW_MS', () => {
    const zoomed = zoomWindow(WINDOW, 500, PLOT_WIDTH, 0.000001);
    expect(windowDurationMs(zoomed)).toBe(MIN_WINDOW_MS);
  });

  it('un factor inválido devuelve la ventana clampeada, no NaN', () => {
    expect(zoomWindow(WINDOW, 500, PLOT_WIDTH, 0)).toEqual(WINDOW);
    expect(zoomWindow(WINDOW, 500, PLOT_WIDTH, Number.NaN)).toEqual(WINDOW);
  });
});

describe('dragSelection', () => {
  it('el arrastre invertido da la MISMA ventana', () => {
    expect(dragSelection(800, 200, PLOT_WIDTH, WINDOW)).toEqual(
      dragSelection(200, 800, PLOT_WIDTH, WINDOW),
    );
  });

  it('traduce el arrastre a la ventana esperada (valores a mano)', () => {
    // 200..800 sobre 1000 px de una ventana de 600 s ⇒ 120 s .. 480 s.
    const selected = dragSelection(200, 800, PLOT_WIDTH, WINDOW);
    expect(selected).not.toBeNull();
    expect(selected!.startMs).toBeCloseTo(T0 + 120_000, 6);
    expect(selected!.endMs).toBeCloseTo(T0 + 480_000, 6);
  });

  it('un arrastre de 1 px es un clic: devuelve null', () => {
    expect(dragSelection(500, 501, PLOT_WIDTH, WINDOW)).toBeNull();
  });

  it('justo por debajo del umbral es null y justo por encima no lo es', () => {
    // El par es obligatorio: con un solo lado, mover MIN_DRAG_PX a 0 o al
    // infinito dejaría el test en verde.
    expect(dragSelection(500, 500 + MIN_DRAG_PX - 0.001, PLOT_WIDTH, WINDOW)).toBeNull();
    expect(dragSelection(500, 500 + MIN_DRAG_PX, PLOT_WIDTH, WINDOW)).not.toBeNull();
  });

  it('un arrastre válido pero angosto no baja de MIN_WINDOW_MS', () => {
    // 5 px de 1000 sobre 600 s son 3 s: por encima del mínimo. Con una ventana
    // corta el mismo arrastre caería por debajo y hay que clampear.
    const shortWindow = { startMs: T0, endMs: T0 + 2_000 };
    const selected = dragSelection(500, 510, PLOT_WIDTH, shortWindow);
    expect(selected).not.toBeNull();
    expect(windowDurationMs(selected!)).toBe(MIN_WINDOW_MS);
  });

  it('ancho de trazado cero devuelve null en vez de dividir por cero', () => {
    expect(dragSelection(0, 100, 0, WINDOW)).toBeNull();
  });
});

describe('windowToQuery', () => {
  it('serializa los extremos en ISO-8601 UTC, que es lo que el backend espera', () => {
    expect(windowToQuery(WINDOW)).toEqual({
      start: '2026-08-24T12:00:00.000Z',
      end: '2026-08-24T12:10:00.000Z',
    });
  });
});
