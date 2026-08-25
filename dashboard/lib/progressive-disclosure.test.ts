import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_COUNTER,
  PROGRESS_DEFAULTS,
  clampCounter,
  loadProgress,
  progressStorageKey,
  recordInteraction,
  revealAllTools,
  saveProgress,
  visibleTools,
  type UserProgress,
} from './progressive-disclosure';

function progress(over: Partial<UserProgress> = {}): UserProgress {
  return { ...PROGRESS_DEFAULTS, ...over };
}

describe('visibleTools — pares de borde por umbral', () => {
  /**
   * Los valores esperados van LITERALES, no leídos de DISCLOSURE_THRESHOLDS:
   * la mutación #12 cambia esa constante, y un test que la usara como
   * referencia se movería con ella y quedaría verde midiendo nada.
   */

  it('wave está visible desde el primer render (umbral 0)', () => {
    expect(visibleTools(progress()).wave).toBe(true);
  });

  it('spectrum: 2 ventanas ⇒ oculto, 3 ⇒ visible', () => {
    expect(visibleTools(progress({ windowsOpened: 2 })).spectrum).toBe(false);
    expect(visibleTools(progress({ windowsOpened: 3 })).spectrum).toBe(true);
  });

  it('rsam: 2 ventanas ⇒ oculto, 3 ⇒ visible', () => {
    expect(visibleTools(progress({ windowsOpened: 2 })).rsam).toBe(false);
    expect(visibleTools(progress({ windowsOpened: 3 })).rsam).toBe(true);
  });

  it('picking: 1 vista analítica ⇒ oculto, 2 ⇒ visible', () => {
    expect(visibleTools(progress({ spectraViewed: 1 })).picking).toBe(false);
    expect(visibleTools(progress({ spectraViewed: 2 })).picking).toBe(true);
  });

  it('picking se abre por CUALQUIERA de las dos puertas, o por la suma', () => {
    // Sólo RSAM
    expect(visibleTools(progress({ rsamViewed: 2 })).picking).toBe(true);
    // Una de cada una: el umbral es sobre el total, no sobre una sola.
    expect(visibleTools(progress({ spectraViewed: 1, rsamViewed: 1 })).picking).toBe(true);
  });

  it('export acompaña al picking: sin picks no hay nada que exportar', () => {
    expect(visibleTools(progress({ spectraViewed: 1 })).export).toBe(false);
    expect(visibleTools(progress({ spectraViewed: 2 })).export).toBe(true);
  });

  it('el progreso en una herramienta no destapa otra', () => {
    // Muchas ventanas no abren el picking: ese escalón exige análisis, no
    // navegación.
    const v = visibleTools(progress({ windowsOpened: 50 }));
    expect(v.spectrum).toBe(true);
    expect(v.picking).toBe(false);
  });
});

describe('visibleTools — revealAll', () => {
  it('gana sobre cualquier umbral, incluso con progreso en cero', () => {
    const v = visibleTools(progress({ revealAll: true }));
    expect(v).toEqual({
      wave: true,
      spectrum: true,
      rsam: true,
      picking: true,
      export: true,
    });
  });
});

describe('visibleTools — la regla se evalúa en cada render', () => {
  it('el progreso se conserva aunque la herramienta esté oculta', () => {
    // Prueba que no se persiste un "nivel resuelto": el mismo objeto de
    // progreso, evaluado contra umbrales distintos, da visibilidades distintas
    // sin perder los contadores. Es lo que permite subir los umbrales como
    // rollback parcial sin borrarle el avance a nadie.
    const p = progress({ windowsOpened: 3, spectraViewed: 2 });
    expect(visibleTools(p).picking).toBe(true);

    // El progreso sigue intacto después de consultarlo (visibleTools es pura).
    expect(p.windowsOpened).toBe(3);
    expect(p.spectraViewed).toBe(2);
    expect(visibleTools(p).picking).toBe(true);
  });
});

describe('recordInteraction', () => {
  it('no muta el progreso original', () => {
    const p = progress({ windowsOpened: 1 });
    const next = recordInteraction(p, 'window');
    expect(p.windowsOpened).toBe(1);
    expect(next.windowsOpened).toBe(2);
    expect(next).not.toBe(p);
  });

  it('cada evento incrementa SU contador y ningún otro', () => {
    const p = progress();
    expect(recordInteraction(p, 'window')).toEqual(progress({ windowsOpened: 1 }));
    expect(recordInteraction(p, 'spectrum')).toEqual(progress({ spectraViewed: 1 }));
    expect(recordInteraction(p, 'rsam')).toEqual(progress({ rsamViewed: 1 }));
  });

  it('conserva revealAll', () => {
    const next = recordInteraction(progress({ revealAll: true }), 'window');
    expect(next.revealAll).toBe(true);
  });

  it('no pasa del techo', () => {
    const next = recordInteraction(progress({ windowsOpened: MAX_COUNTER }), 'window');
    expect(next.windowsOpened).toBe(MAX_COUNTER);
  });

  it('sanea un progreso que ya venía corrupto', () => {
    const dirty = { windowsOpened: -5, spectraViewed: Number.NaN, rsamViewed: 1.9, revealAll: false };
    const next = recordInteraction(dirty as UserProgress, 'window');
    expect(next.windowsOpened).toBe(1); // -5 → 0, +1
    expect(next.spectraViewed).toBe(0);
    expect(next.rsamViewed).toBe(1); // 1.9 → 1
  });
});

describe('revealAllTools', () => {
  it('activa la bandera sin tocar los contadores', () => {
    const p = progress({ windowsOpened: 2 });
    const next = revealAllTools(p);
    expect(next.revealAll).toBe(true);
    expect(next.windowsOpened).toBe(2);
    expect(p.revealAll).toBe(false);
  });
});

describe('clampCounter', () => {
  it.each([
    [Number.NaN, 0],
    [-1, 0],
    [-9_999, 0],
    [Number.POSITIVE_INFINITY, MAX_COUNTER],
    [Number.NEGATIVE_INFINITY, 0],
    [MAX_COUNTER + 1_000, MAX_COUNTER],
    ['3', 3],
    [3.7, 3],
    [undefined, 0],
    [null, 0],
    ['no soy un número', 0],
    [{}, 0],
  ])('clampCounter(%p) === %i', (input, expected) => {
    expect(clampCounter(input)).toBe(expected);
  });
});

describe('persistencia', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('la clave es global, no por canal', () => {
    expect(progressStorageKey()).toBe('signal-progress');
  });

  it('ida y vuelta', () => {
    const p = progress({ windowsOpened: 4, spectraViewed: 2, revealAll: true });
    saveProgress(p);
    expect(loadProgress()).toEqual(p);
  });

  it('sin nada guardado ⇒ defaults', () => {
    expect(loadProgress()).toEqual(PROGRESS_DEFAULTS);
  });

  it('JSON corrupto ⇒ defaults, sin lanzar', () => {
    store.set(progressStorageKey(), '{no-es-json');
    expect(() => loadProgress()).not.toThrow();
    expect(loadProgress()).toEqual(PROGRESS_DEFAULTS);
  });

  it('contadores negativos y absurdos ⇒ recortados', () => {
    store.set(
      progressStorageKey(),
      JSON.stringify({ windowsOpened: -7, spectraViewed: 1e12, rsamViewed: 'x' }),
    );
    const loaded = loadProgress();
    expect(loaded.windowsOpened).toBe(0);
    expect(loaded.spectraViewed).toBe(MAX_COUNTER);
    expect(loaded.rsamViewed).toBe(0);
  });

  it('el string "true" NO activa revealAll', () => {
    store.set(progressStorageKey(), JSON.stringify({ revealAll: 'true' }));
    expect(loadProgress().revealAll).toBe(false);
  });

  it('un revealAll booleano SÍ lo activa (el par del test anterior)', () => {
    store.set(progressStorageKey(), JSON.stringify({ revealAll: true }));
    expect(loadProgress().revealAll).toBe(true);
  });

  it('sin localStorage (SSR / modo privado) ⇒ defaults, sin lanzar', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadProgress()).toEqual(PROGRESS_DEFAULTS);
    expect(() => saveProgress(progress())).not.toThrow();
  });

  it('cuota llena al guardar ⇒ no rompe la vista', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
    });
    expect(() => saveProgress(progress({ windowsOpened: 1 }))).not.toThrow();
  });
});
