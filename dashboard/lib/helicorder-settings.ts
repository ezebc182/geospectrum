/**
 * Settings manuales del helicorder, persistidos por canal (spec §61).
 *
 * SWARM no adivina la escala: el operador la mueve hasta que el evento se lee.
 * Nuestro `autoClipValue` (percentil del día) sigue siendo el punto de partida
 * —evita arrancar con la pantalla en blanco— pero ya no es la última palabra,
 * porque un sismo real vive justo en la cola que ese percentil recorta: el
 * evento salía clampado y pintado de rojo, que es exactamente lo que uno
 * quiere mirar.
 *
 * `clipMult` multiplica ese clip automático y `barMult` exagera la amplitud
 * dibujada. Son los dos ejes de SWARM y hacen cosas distintas: subir el clip
 * deja de saturar, subir barMult agranda lo que ya entra.
 */

export interface HelicorderSettings {
  /** Multiplicador del clip automático. 1 = el auto de siempre. */
  clipMult: number;
  /** Exageración de amplitud al dibujar (SWARM `barMult`). */
  barMult: number;
  /** Minutos por fila. */
  timeChunkMinutes: number;
}

/** Las tres franjas de SWARM; la página las ofrece en ese orden. */
export const TIME_CHUNK_OPTIONS = [15, 30, 60] as const;

export const HELICORDER_DEFAULTS = {
  clipMult: 1,
  clipMultMin: 0.1,
  clipMultMax: 20,
  barMult: 1,
  barMultMin: 0.25,
  barMultMax: 10,
  timeChunkMinutes: 30,
} as const;

function clampRange(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function clampClipMult(value: number): number {
  return clampRange(
    value,
    HELICORDER_DEFAULTS.clipMultMin,
    HELICORDER_DEFAULTS.clipMultMax,
    HELICORDER_DEFAULTS.clipMult,
  );
}

export function clampBarMult(value: number): number {
  return clampRange(
    value,
    HELICORDER_DEFAULTS.barMultMin,
    HELICORDER_DEFAULTS.barMultMax,
    HELICORDER_DEFAULTS.barMult,
  );
}

/**
 * Clip efectivo = clip automático × multiplicador del operador.
 *
 * El piso positivo no es defensivo por gusto: el clip termina en el
 * denominador de la escala del canvas, y un 0 propaga NaN a cada coordenada
 * sin lanzar ninguna excepción — la fila simplemente no se dibuja.
 */
export function effectiveClip(autoClip: number, clipMult: number): number {
  const base = Number.isFinite(autoClip) && autoClip > 0 ? autoClip : 1;
  const mult = Number.isFinite(clipMult) && clipMult > 0 ? clipMult : 1;
  return base * mult;
}

export function settingsStorageKey(channel: string): string {
  return `helicorder-settings:${channel}`;
}

export function loadHelicorderSettings(channel: string): HelicorderSettings {
  const defaults: HelicorderSettings = {
    clipMult: HELICORDER_DEFAULTS.clipMult,
    barMult: HELICORDER_DEFAULTS.barMult,
    timeChunkMinutes: HELICORDER_DEFAULTS.timeChunkMinutes,
  };

  // SSR y modo privado: no hay storage y no es un error, es el caso normal.
  if (typeof localStorage === 'undefined') return defaults;

  try {
    const raw = localStorage.getItem(settingsStorageKey(channel));
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<HelicorderSettings>;
    const chunk = Number(parsed.timeChunkMinutes);
    return {
      clipMult: clampClipMult(Number(parsed.clipMult)),
      barMult: clampBarMult(Number(parsed.barMult)),
      // El timeChunk es discreto: un valor arbitrario rompería la grilla del
      // eje X, así que sólo se aceptan los de la lista.
      timeChunkMinutes: (TIME_CHUNK_OPTIONS as readonly number[]).includes(chunk)
        ? chunk
        : defaults.timeChunkMinutes,
    };
  } catch {
    return defaults;
  }
}

export function saveHelicorderSettings(channel: string, settings: HelicorderSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(settingsStorageKey(channel), JSON.stringify(settings));
  } catch {
    // Cuota llena o storage bloqueado: perder la preferencia es aceptable,
    // romper la vista no.
  }
}
