/**
 * Progresividad POR INTERACCIÓN.
 *
 * No es un toggle básico/avanzado y no es todo visible siempre: las
 * herramientas aparecen cuando el usuario ya usó las anteriores. El objetivo
 * es que el principiante no vea una cabina de avión, y que el que ya sabe no
 * tenga que buscar un switch escondido.
 *
 * Toda la regla vive acá, en funciones puras. Ningún componente decide su
 * propia visibilidad: si la regla estuviera repartida en condicionales de JSX,
 * el riesgo "aparece nunca / aparece de más" sería imposible de testear sin
 * montar el árbol entero — y la sexta herramienta copiaría el umbral a mano en
 * un sexto lugar.
 *
 * Tolerancia idéntica a `helicorder-settings.ts`: clamps + fallback a defaults
 * + JSON corrupto NO rompe la vista.
 */

/** Lo que el usuario hizo. Contadores monótonos, nunca decrecen. */
export interface UserProgress {
  /** Ventanas de onda abiertas (clic en helicorder o zoom). */
  windowsOpened: number;
  /** Veces que miró el espectro 1D. */
  spectraViewed: number;
  /** Veces que miró la serie RSAM. */
  rsamViewed: number;
  /** Escape hatch: el usuario pidió ver todo. Gana sobre cualquier umbral. */
  revealAll: boolean;
}

export type ToolId = 'wave' | 'spectrum' | 'rsam' | 'picking' | 'export';

export type ToolVisibility = Record<ToolId, boolean>;

/**
 * Umbrales. Un solo objeto: subirlos al infinito es el rollback parcial sin
 * deploy que la propuesta pide como feature flag.
 */
export const DISCLOSURE_THRESHOLDS = {
  /** El wave view está disponible desde el principio: es el escalón base. */
  wave: 0,
  /** Espectro 1D: después de haber abierto ventanas. */
  spectrumAfterWindows: 3,
  /** RSAM: mismo escalón que el espectro, otra puerta. */
  rsamAfterWindows: 3,
  /** Picking: exige haber usado alguna herramienta analítica. */
  pickingAfterSpectraOrRsam: 2,
  // Export no tiene umbral propio: lo abre el picking, porque exportar sin
  // picks hechos no tendría nada que exportar.
} as const;

export const PROGRESS_DEFAULTS: UserProgress = {
  windowsOpened: 0,
  spectraViewed: 0,
  rsamViewed: 0,
  revealAll: false,
};

/**
 * Techo de los contadores: no cambia ninguna decisión (todos los umbrales
 * están muy por debajo) y evita overflow y valores absurdos en el storage.
 */
export const MAX_COUNTER = 9_999;

/**
 * Recorta un contador a un entero de [0, MAX_COUNTER].
 *
 * `Number(v)` acepta `"3"` y devuelve `NaN` para basura: las dos cosas tienen
 * que terminar en un entero válido, porque el valor viene de `localStorage` y
 * ahí puede haber cualquier cosa que otra pestaña o una versión vieja escribió.
 */
export function clampCounter(value: unknown): number {
  const n = Number(value);
  // `NaN` sale por 0 porque no tiene orden: no se puede decir si es mucho o
  // poco. `Infinity` NO: está ordenado, significa "más que cualquier umbral",
  // y por eso cae al techo en vez de borrarle el avance al usuario. Los dos
  // son valores corruptos, pero no son el mismo tipo de corrupción.
  if (Number.isNaN(n)) return 0;
  return Math.min(MAX_COUNTER, Math.max(0, Math.floor(n)));
}

/**
 * LA regla. Función pura: mismo progreso ⇒ misma visibilidad, siempre.
 *
 * El nivel resuelto NO se persiste: se recalcula en cada render. Por eso subir
 * los umbrales esconde herramientas sin borrar el progreso del usuario, que es
 * lo que hace de esto un rollback parcial sin deploy.
 */
export function visibleTools(p: UserProgress): ToolVisibility {
  if (p.revealAll) {
    return { wave: true, spectrum: true, rsam: true, picking: true, export: true };
  }

  const windows = clampCounter(p.windowsOpened);
  const spectra = clampCounter(p.spectraViewed);
  const rsam = clampCounter(p.rsamViewed);

  const wave = windows >= DISCLOSURE_THRESHOLDS.wave;
  const spectrum = windows >= DISCLOSURE_THRESHOLDS.spectrumAfterWindows;
  const rsamVisible = windows >= DISCLOSURE_THRESHOLDS.rsamAfterWindows;
  // "Espectros O RSAM": el usuario llega al picking por cualquiera de las dos
  // puertas analíticas, no hace falta que haya recorrido las dos.
  const picking =
    spectra + rsam >= DISCLOSURE_THRESHOLDS.pickingAfterSpectraOrRsam;

  return {
    wave,
    spectrum,
    rsam: rsamVisible,
    picking,
    // Export sale con el picking: exportar mediciones sin picks no exporta nada.
    export: picking,
  };
}

/** Registrar una interacción. Devuelve un progreso NUEVO (no muta). */
export function recordInteraction(
  p: UserProgress,
  event: 'window' | 'spectrum' | 'rsam',
): UserProgress {
  const next: UserProgress = {
    windowsOpened: clampCounter(p.windowsOpened),
    spectraViewed: clampCounter(p.spectraViewed),
    rsamViewed: clampCounter(p.rsamViewed),
    revealAll: p.revealAll === true,
  };

  if (event === 'window') next.windowsOpened = clampCounter(next.windowsOpened + 1);
  else if (event === 'spectrum') next.spectraViewed = clampCounter(next.spectraViewed + 1);
  else next.rsamViewed = clampCounter(next.rsamViewed + 1);

  return next;
}

/** Escape hatch. Persistente: quien lo pidió una vez no lo pide de nuevo. */
export function revealAllTools(p: UserProgress): UserProgress {
  return { ...p, revealAll: true };
}

/**
 * Clave GLOBAL, no por canal (a diferencia de `helicorder-settings`).
 *
 * El progreso mide qué aprendió el usuario, no cómo quiere ver un canal
 * específico: quien ya marcó fases en `AK.FIRE..BHZ` no es un principiante
 * cuando abre `IU.MAJO.00.BHZ`. Esconderle el picking ahí sería castigarlo por
 * haber cambiado de estación.
 */
export function progressStorageKey(): string {
  return 'signal-progress';
}

/** Tolera ausencia de storage, JSON corrupto y valores basura. */
export function loadProgress(): UserProgress {
  // SSR y modo privado: no hay storage y no es un error, es el caso normal.
  if (typeof localStorage === 'undefined') return { ...PROGRESS_DEFAULTS };

  try {
    const raw = localStorage.getItem(progressStorageKey());
    if (!raw) return { ...PROGRESS_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<UserProgress>;
    return {
      windowsOpened: clampCounter(parsed.windowsOpened),
      spectraViewed: clampCounter(parsed.spectraViewed),
      rsamViewed: clampCounter(parsed.rsamViewed),
      // Estrictamente `true`: el string "true" que guardaría un serializador
      // distinto NO abre todas las herramientas de golpe.
      revealAll: parsed.revealAll === true,
    };
  } catch {
    return { ...PROGRESS_DEFAULTS };
  }
}

export function saveProgress(p: UserProgress): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(progressStorageKey(), JSON.stringify(p));
  } catch {
    // Cuota llena o storage bloqueado: perder el progreso significa ver menos
    // herramientas en la próxima visita y un clic lo arregla. Romper la vista
    // no se arregla con un clic.
  }
}
