/**
 * Eje de frecuencia del espectrograma grande, derivado del dato.
 *
 * El backend recorta las frecuencias en `min(MAX_FREQ_HZ, fs/2)`
 * (`src/services/swarm_spectra.py`), así que el techo depende del muestreo de
 * cada estación. Medido en la tabla `spectrogram_columns`: hay canales que
 * llegan a 10 Hz, otros a 20 y otros a 25, y algunos cambiaron de grilla en el
 * tiempo (65 bins de 0 a 25 conviviendo con 80 bins de 0.25 a 20).
 *
 * Por eso el eje NO puede ser una constante: dibujar 0–20 Hz en un canal que
 * llega a 10 comprime la señal en la mitad inferior del recuadro y el eje
 * miente por un factor de 2. Este proyecto ya tuvo ese bug una vez — ver el
 * docstring de `spectrogram-axis.ts`, que es el eje de la IMAGEN de matplotlib
 * (otro camino, otra grilla) y no sirve para las columnas del WS.
 */

export interface FrequencyAxis {
  fMin: number;
  fMax: number;
  /** true si las columnas de la ventana no comparten la misma grilla. */
  mixedGrid: boolean;
}

/** Eje de respaldo cuando todavía no llegó ninguna columna. */
const FALLBACK_AXIS: FrequencyAxis = { fMin: 0, fMax: 25, mixedGrid: false };

/** Alto mínimo del eje en Hz: evita dividir por cero al mapear a píxeles. */
const MIN_SPAN_HZ = 0.5;

export function frequencyAxis(columns: ReadonlyArray<readonly number[]>): FrequencyAxis {
  let fMin = Number.POSITIVE_INFINITY;
  let fMax = Number.NEGATIVE_INFINITY;
  // La firma de la grilla detecta el caso de columnas heterogéneas; comparar
  // los arrays completos sería O(bins) por columna sin ganar precisión útil.
  const firmas = new Set<string>();

  for (const freqs of columns) {
    let colMin = Number.POSITIVE_INFINITY;
    let colMax = Number.NEGATIVE_INFINITY;
    let n = 0;

    for (const f of freqs) {
      if (!Number.isFinite(f)) continue;
      if (f < colMin) colMin = f;
      if (f > colMax) colMax = f;
      n++;
    }
    if (n === 0) continue;

    firmas.add(`${n}:${colMin}:${colMax}`);
    if (colMin < fMin) fMin = colMin;
    if (colMax > fMax) fMax = colMax;
  }

  if (!Number.isFinite(fMin) || !Number.isFinite(fMax)) return FALLBACK_AXIS;

  return {
    fMin,
    // Un solo bin (o todos iguales) daría un eje de altura cero.
    fMax: fMax - fMin < MIN_SPAN_HZ ? fMin + MIN_SPAN_HZ : fMax,
    mixedGrid: firmas.size > 1,
  };
}

/**
 * Posición vertical de una frecuencia, como fracción del alto: 0 es el tope
 * del eje y 1 la base. La grilla del backend es equiespaciada, así que el
 * mapeo es lineal — usar log acá desalinearía las marcas del dato.
 */
export function freqToFraction(hz: number, axis: FrequencyAxis): number {
  const span = axis.fMax - axis.fMin;
  if (!(span > 0)) return 0;
  const fraction = (hz - axis.fMin) / span;
  return Math.min(1, Math.max(0, 1 - fraction));
}

/**
 * Marcas en valores redondos dentro del rango real del eje.
 *
 * Un eje que va de 0.25 a 10 no puede rotularse con las mismas marcas que uno
 * de 0 a 25: las etiquetas quedarían fuera del recuadro o amontonadas. El paso
 * sale de la escala 1/2/5 × 10^n, que es la que produce números que un humano
 * lee de un vistazo.
 */
export function niceFrequencyTicks(fMin: number, fMax: number, target = 6): number[] {
  const span = fMax - fMin;
  if (!(span > 0)) return [fMin];

  const crudo = span / Math.max(1, target);
  const magnitud = 10 ** Math.floor(Math.log10(crudo));
  const normalizado = crudo / magnitud;
  const paso = (normalizado <= 1 ? 1 : normalizado <= 2 ? 2 : normalizado <= 5 ? 5 : 10) * magnitud;

  const ticks: number[] = [];
  // Arranca en el primer múltiplo del paso que entra en el rango: si empezara
  // en fMin, las marcas serían 0.25/2.25/4.25 en vez de 2/4/6.
  for (let t = Math.ceil(fMin / paso) * paso; t <= fMax + 1e-9; t += paso) {
    // La suma repetida arrastra error binario (0.30000000000000004): se
    // redondea al paso para que la etiqueta no muestre la basura.
    const decimales = Math.max(0, -Math.floor(Math.log10(paso)));
    ticks.push(Number(t.toFixed(decimales)));
  }
  return ticks.length > 0 ? ticks : [fMin, fMax];
}
