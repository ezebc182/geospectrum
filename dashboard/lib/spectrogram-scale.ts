/**
 * Escala de color estable para el espectrograma en vivo.
 *
 * El canvas normalizaba cada columna contra sus propios percentiles 5-95:
 * una columna de ruido de fondo quedaba tan brillante como una con un sismo,
 * porque cada una se estiraba a su propio rango. Eso destruye el contraste
 * temporal — que es la información que el espectrograma tiene que mostrar.
 *
 * El criterio correcto (el mismo que matplotlib en el modo estático, que
 * normaliza sobre la imagen ENTERA) es una escala global: se inicializa con
 * los percentiles del historial precargado y después deriva lento con una
 * media móvil exponencial, para adaptarse a cambios de piso de ruido de la
 * estación sin perder el contraste entre momentos calmos y eventos.
 */

export interface SpectrogramScale {
  vmin: number;
  vmax: number;
}

// Qué tan rápido deriva la escala con cada columna nueva. A ~1 columna cada
// 4-8s, 0.02 significa adaptarse al nuevo piso de ruido en ~5-10 minutos:
// lo bastante lento para que un sismo NO se coma su propio contraste.
export const SCALE_EMA_ALPHA = 0.02;

/** Percentil por interpolación lineal sobre un array YA ordenado. */
export function percentile(sorted: number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Escala global a partir del historial: percentiles 5-95 sobre TODOS los
 * valores de TODAS las columnas juntas (no por columna). Devuelve null sin
 * datos — el llamador inicializa con la primera columna en vivo.
 */
export function scaleFromHistory(columns: number[][]): SpectrogramScale | null {
  const all = columns.flat();
  if (all.length === 0) return null;
  const sorted = [...all].sort((a, b) => a - b);
  return { vmin: percentile(sorted, 0.05), vmax: percentile(sorted, 0.95) };
}

/**
 * Deriva la escala hacia los percentiles de la columna nueva (EMA). No
 * muta: devuelve la escala nueva.
 */
export function updateScale(
  scale: SpectrogramScale,
  powerDb: number[],
  alpha: number = SCALE_EMA_ALPHA
): SpectrogramScale {
  if (powerDb.length === 0) return scale;
  const sorted = [...powerDb].sort((a, b) => a - b);
  const p5 = percentile(sorted, 0.05);
  const p95 = percentile(sorted, 0.95);
  return {
    vmin: scale.vmin + (p5 - scale.vmin) * alpha,
    vmax: scale.vmax + (p95 - scale.vmax) * alpha,
  };
}

/**
 * Últimas `width` columnas del historial: a 1px por columna, las anteriores
 * saldrían del canvas apenas dibujadas — pedirlas está bien (el recorte por
 * tiempo lo hace el backend), pintarlas es tirar trabajo.
 */
export function sliceToWidth<T>(columns: T[], width: number): T[] {
  if (columns.length <= width) return columns;
  return columns.slice(columns.length - width);
}

// Peor caso observado: una columna cada ~8 s, pintada a 1 px. Pedir más
// historial del que entra en el canvas es payload tirado — y con ~74 tiras
// montadas en el muro de la cartelera, se multiplica.
const WORST_SECONDS_PER_COLUMN = 8;

export function historyMinutesForWidth(width: number): number {
  return Math.max(1, Math.ceil((width * WORST_SECONDS_PER_COLUMN) / 60));
}
