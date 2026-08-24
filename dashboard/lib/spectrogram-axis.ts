/**
 * Marcas del eje de frecuencia del espectrograma.
 *
 * El backend dibuja la imagen con matplotlib usando `ax.set_ylim([0.1, 20])` y
 * SIN `set_yscale('log')` (src/services/spectrogram_service.py): el eje es
 * LINEAL. El overlay del front repartía cinco etiquetas con `justify-between`,
 * o sea a distancia uniforme, que es el espaciado de un eje logarítmico. Las
 * dos escalas no coinciden y las marcas mentían hasta 25 puntos porcentuales.
 */

/** Extremos del eje, en Hz. Espejo de `fmin`/`fmax` del servicio. */
export const SPECTROGRAM_FREQ_MIN = 0.1;
export const SPECTROGRAM_FREQ_MAX = 20;

/**
 * Marcas equiespaciadas en frecuencia, que es lo legible en un eje lineal. La
 * escala vieja (20/10/5/1/0.1) amontonaba las dos últimas al 95% y al 100%.
 */
export const SPECTROGRAM_FREQ_TICKS = [20, 15, 10, 5, 1] as const;

/**
 * Posición vertical de una marca, en porcentaje desde arriba del contenedor:
 * 0% es `SPECTROGRAM_FREQ_MAX` y 100% es `SPECTROGRAM_FREQ_MIN`. Se clampea
 * para que una marca fuera de rango no se dibuje fuera del recuadro.
 */
export function freqTickOffset(hz: number): number {
  const span = SPECTROGRAM_FREQ_MAX - SPECTROGRAM_FREQ_MIN;
  const fraction = (hz - SPECTROGRAM_FREQ_MIN) / span;

  return Math.min(100, Math.max(0, (1 - fraction) * 100));
}

/**
 * Marcas del eje de tiempo, calculadas desde las horas realmente pedidas.
 *
 * Antes eran cuatro strings escritos a mano (`-24h/-18h/-12h/-6h`) sin
 * relación con `duration_hours`: si se pedían 12 horas, el eje seguía
 * anunciando un rango de 24. Se generan 4 marcas equiespaciadas dentro del
 * rango real, de más antiguo a más reciente (el extremo "ahora" lo agrega el
 * llamador aparte, con su propio rótulo traducido).
 */
export function timeAxisLabels(durationHours: number): string[] {
  if (!(durationHours > 0)) return [];

  const step = durationHours / 4;
  return [4, 3, 2, 1].map((n) => `-${Math.round(step * n)}h`);
}
