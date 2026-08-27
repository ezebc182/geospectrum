import { describe, expect, it } from 'vitest';

import { helicorderHitToWindow, type HelicorderHit } from './helicorder-hit';

// Layout real del HelicorderCanvas: MARGIN_LEFT/RIGHT = 56, 24 h en franjas.
// Con timeChunkMinutes=60 y rows=24 cada franja es una hora exacta, así que
// todos los valores esperados salen de una cuenta a mano y no de correr el
// código y copiar lo que dio.
const T0 = Date.UTC(2026, 7, 23, 0, 0, 0); // 2026-08-23T00:00:00Z

const BASE: HelicorderHit = {
  x: 0,
  y: 0,
  width: 1112, // 56 + 1000 de plot + 56
  height: 480, // 24 filas de 20 px
  marginLeft: 56,
  marginRight: 56,
  rows: 24,
  timeChunkMinutes: 60,
  startMs: T0,
  windowSeconds: 120,
};

describe('helicorderHitToWindow', () => {
  it('centra la ventana en el instante clickeado', () => {
    // Fila 3 (4ta), mitad exacta del plot: T0 + 3 h + 30 min.
    // El plot va de x=56 a x=1056, su mitad es x=556.
    // Fila 3 ocupa y de 60 a 80; y=70 cae dentro.
    const w = helicorderHitToWindow({ ...BASE, x: 556, y: 70 });

    const esperado = T0 + 3 * 3_600_000 + 30 * 60_000;
    expect(w).not.toBeNull();
    expect(w!.startMs).toBe(esperado - 60_000);
    expect(w!.endMs).toBe(esperado + 60_000);
  });

  it('el borde izquierdo de la primera fila es exactamente T0', () => {
    const w = helicorderHitToWindow({ ...BASE, x: 56, y: 0 });

    // Clic en T0: la mitad izquierda de la ventana queda fuera del rango y se
    // recorta, así que arranca en T0 exacto y dura sólo 60 s.
    expect(w).not.toBeNull();
    expect(w!.startMs).toBe(T0);
    expect(w!.endMs).toBe(T0 + 60_000);
  });

  it('el borde derecho de la última fila no se pasa de las 24 h', () => {
    const finDelRango = T0 + 24 * 3_600_000;
    const w = helicorderHitToWindow({ ...BASE, x: 1056, y: 479 });

    expect(w).not.toBeNull();
    expect(w!.endMs).toBeLessThanOrEqual(finDelRango);
    expect(w!.endMs).toBe(finDelRango);
  });

  it('devuelve null en el margen izquierdo', () => {
    // x=30 cae sobre las etiquetas de hora local, no sobre señal.
    expect(helicorderHitToWindow({ ...BASE, x: 30, y: 70 })).toBeNull();
  });

  it('devuelve null en el margen derecho', () => {
    expect(helicorderHitToWindow({ ...BASE, x: 1090, y: 70 })).toBeNull();
  });

  it('la fila se calcula por y, no se ignora', () => {
    // El mismo x en dos filas distintas debe dar instantes separados por
    // exactamente una hora. Un mapeo que ignorara `y` daría lo mismo en ambas.
    const fila0 = helicorderHitToWindow({ ...BASE, x: 556, y: 10 });
    const fila1 = helicorderHitToWindow({ ...BASE, x: 556, y: 30 });

    expect(fila1!.startMs - fila0!.startMs).toBe(3_600_000);
  });

  it('el offset horizontal se calcula sobre el plot, no sobre el canvas', () => {
    // OJO con el punto elegido: en x=556 (la mitad) `x/width` y
    // `(x-marginLeft)/plotWidth` dan AMBOS 0.5, así que ahí el test no puede
    // distinguir la fórmula correcta de la equivocada. Verificado por mutación:
    // con x=556 el test quedaba verde con `x/width`.
    //
    // x=306 sí las separa:
    //   correcto:   (306-56)/1000 = 0.25  -> 15 min
    //   equivocado:  306/1112     ≈ 0.275 -> ~16.5 min
    const w = helicorderHitToWindow({ ...BASE, x: 306, y: 10 });
    const cuartoDeLaPrimeraHora = T0 + 15 * 60_000;

    expect(w!.startMs).toBe(cuartoDeLaPrimeraHora - 60_000);
    expect(w!.endMs).toBe(cuartoDeLaPrimeraHora + 60_000);
  });

  it('respeta windowSeconds', () => {
    const w = helicorderHitToWindow({ ...BASE, x: 556, y: 70, windowSeconds: 600 });

    expect(w!.endMs - w!.startMs).toBe(600_000);
  });

  it('devuelve null con parámetros degenerados', () => {
    expect(helicorderHitToWindow({ ...BASE, x: 556, y: 70, rows: 0 })).toBeNull();
    expect(
      helicorderHitToWindow({ ...BASE, x: 556, y: 70, timeChunkMinutes: 0 }),
    ).toBeNull();
    expect(
      helicorderHitToWindow({ ...BASE, x: 556, y: 70, windowSeconds: 0 }),
    ).toBeNull();
    // Canvas sin ancho útil: los márgenes se comen todo.
    expect(helicorderHitToWindow({ ...BASE, x: 56, y: 70, width: 100 })).toBeNull();
  });

  it('el clic en el borde inferior exacto no se sale del rango de filas', () => {
    // y === height daría `rows` con un floor pelado, saliéndose del arreglo.
    const w = helicorderHitToWindow({ ...BASE, x: 556, y: 480 });

    expect(w).not.toBeNull();
    expect(w!.endMs).toBeLessThanOrEqual(T0 + 24 * 3_600_000);
  });
});

// =============================================================================
// windowToRowSegments — el highlight del hover (contraparte de hitToWindow)
// =============================================================================

import { windowToRowSegments } from './helicorder-hit';

describe('windowToRowSegments', () => {
  // Franjas de 30 min (1800 s) arrancando en T0.
  const T0 = Date.parse('2026-08-26T00:00:00Z');
  const LAYOUT = { startMs: T0, timeChunkMinutes: 30, rows: 48 };
  const sec = (s: number) => s * 1000;

  it('una ventana dentro de una franja produce UN segmento con fracciones exactas', () => {
    const segs = windowToRowSegments(
      { startMs: T0 + sec(600), endMs: T0 + sec(720) },
      LAYOUT,
    );
    expect(segs).toEqual([{ row: 0, fromFraction: 600 / 1800, toFraction: 720 / 1800 }]);
  });

  it('una ventana que cruza el borde de franja produce DOS segmentos', () => {
    // 120 s centrados justo en el borde de la primera franja.
    const segs = windowToRowSegments(
      { startMs: T0 + sec(1740), endMs: T0 + sec(1860) },
      LAYOUT,
    );
    expect(segs).toEqual([
      { row: 0, fromFraction: 1740 / 1800, toFraction: 1 },
      { row: 1, fromFraction: 0, toFraction: 60 / 1800 },
    ]);
  });

  it('recorta contra los bordes del dato: nada antes de la primera franja', () => {
    const segs = windowToRowSegments(
      { startMs: T0 - sec(60), endMs: T0 + sec(60) },
      LAYOUT,
    );
    expect(segs).toEqual([{ row: 0, fromFraction: 0, toFraction: 60 / 1800 }]);
  });

  it('ventana totalmente fuera del dato o degenerada: sin segmentos', () => {
    expect(
      windowToRowSegments({ startMs: T0 - sec(600), endMs: T0 - sec(300) }, LAYOUT),
    ).toEqual([]);
    expect(
      windowToRowSegments({ startMs: T0 + sec(60), endMs: T0 + sec(60) }, LAYOUT),
    ).toEqual([]);
  });
});
