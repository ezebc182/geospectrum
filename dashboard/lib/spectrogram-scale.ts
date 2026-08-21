/**
 * Escala fija de potencia estilo SWARM (USGS, WaveDefaults.config): 20-120 dB.
 *
 * Antes acá vivía una escala adaptativa por percentiles con deriva EMA.
 * Se eliminó a propósito: el backend (src/services/swarm_spectra.py) ahora
 * calcula los dB con paridad exacta a SWARM (20*log10 de la FFT cruda de
 * counts), así que los valores absolutos SIGNIFICAN lo mismo en todas las
 * estaciones — un rojo es 120 dB reales, no "el 5% más alto de este canal".
 * Normalizar por percentiles garantizaba que cada canal usara la rampa
 * completa del colormap, con o sin sismo: con jet eso pintaba fuego perpetuo.
 */

export const SWARM_MIN_POWER_DB = 20;
export const SWARM_MAX_POWER_DB = 120;

/** dB → t en [0,1] para la paleta, saturando fuera del rango SWARM. */
export function powerDbToT(powerDb: number): number {
  const t =
    (powerDb - SWARM_MIN_POWER_DB) / (SWARM_MAX_POWER_DB - SWARM_MIN_POWER_DB);
  return Math.max(0, Math.min(1, t));
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
