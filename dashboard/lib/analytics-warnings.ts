/**
 * Lib PURA de reglas de confiabilidad de `/analytics` (analytics-redesign,
 * Fase 2).
 *
 * Qué es y qué NO es:
 *
 * - Recibe respuestas YA TIPADAS de `./analytics` y devuelve advertencias
 *   tipadas. **Nunca texto traducido**: cada advertencia lleva un `id` que ES
 *   su clave i18n (`analytics.warnings.<id>`) y un `params` de primitivas. El
 *   que traduce es el componente.
 * - Sin React, sin `next-intl`, sin red, sin `Date.now()`. Se importan **solo
 *   tipos** de `./analytics` (ese módulo trae `fetch` y `ApiStatusError`;
 *   arrastrarlo mataría la pureza). Molde: `lib/uptime-series.ts`.
 * - Función total: para toda entrada que satisfaga los tipos devuelve un array
 *   (posiblemente vacío) y no lanza.
 * - No inventa defaults: si un campo que una regla necesita no existe en el
 *   miembro de la unión recibido, esa regla no dispara (y el compilador lo
 *   fuerza, porque `BValueResponse` está discriminada por `status`).
 */

import type { BValueResponse, TremorResponse } from './analytics';

// --- constantes con nombre ------------------------------------------------------

/**
 * Factor de la normal estándar para el 95 % bilateral.
 *
 * OJO con el supuesto: `sigma_b` del backend es la σ de Shi & Bolt (1982) del
 * estimador de Aki-Utsu, **no** un intervalo de confianza calculado por el
 * backend. `b ± 1.96σ` es aritmética hecha en la UI **bajo supuesto de
 * normalidad**, y así hay que rotularla. Llamarla "intervalo de confianza"
 * sería atribuirle al backend un cálculo que no hizo.
 */
export const NORMAL_95_FACTOR = 1.96;

/**
 * Umbral fijo de "canal que hay que mirar HOY": ratio de uptime `< 0.9`.
 *
 * Fijo a propósito, no percentil ni top-N: significa lo mismo la semana que
 * viene, y si la red mejora la lista se vacía sola — una lista vacía ES
 * información.
 */
export const UPTIME_ATTENTION_THRESHOLD = 0.9;

/**
 * Margen sobre `min_events` bajo el cual la muestra sobre Mc se considera
 * chica: `n_above_mc < min_events * 1.5`.
 *
 * El mínimo NO se hardcodea acá: viaja en `min_events` de la respuesta, que el
 * backend toma de `bValueMinEvents` de `seismic-constants.json` (fuente única).
 * Lo único elegido por el equipo es el factor 1.5, sin respaldo del usuario
 * todavía: se re-confirma en el QA de la Fase 3 con datos reales.
 */
export const SMALL_SAMPLE_FACTOR = 1.5;

/**
 * Fracción de la ventana en episodio por encima de la cual la MEDIANA que hace
 * de línea base queda enmascarada por el propio episodio (`src/services/tremor.py:26-28`).
 */
export const TREMOR_BASELINE_MASK_FRACTION = 0.5;

/**
 * `onset_ratio` por debajo del cual el arranque de un episodio se considera
 * emergente (y no impulsivo): la primera muestra está muy por debajo del pico.
 */
export const EMERGENT_ONSET_RATIO = 0.3;

// --- tipos ----------------------------------------------------------------------

/**
 * Tres niveles, unión cerrada. `critical` es escaso a propósito: `mc-at-catalog-floor`
 * es la única regla de esta fase que lo emite. Si todo advierte, nada advierte.
 */
export type WarningSeverity = 'critical' | 'warning' | 'info';

/**
 * Base de cada miembro de la unión. `id` es a la vez el discriminante y la
 * clave i18n (`analytics.warnings.<id>`): no hay tabla de mapeo que mantener.
 * `params` va tipado POR MIEMBRO — nunca `Record<string, unknown>` — para que
 * el componente pueda narrowar por `id` y el compilador ate el contrato
 * lib↔clave i18n.
 */
interface WarningBase<Id extends string, P extends object> {
  readonly id: Id;
  readonly severity: WarningSeverity;
  readonly params: P;
}

/** Reglas sin interpolación: el objeto existe pero no admite ninguna clave. */
type NoParams = Record<string, never>;

export type McAtCatalogFloorWarning = WarningBase<'b-value.mc-at-catalog-floor', { mc: number }>;
export type MixedMagnitudeScalesWarning = WarningBase<
  'b-value.mixed-magnitude-scales',
  { scales: string; count: number }
>;
export type UnknownMagnitudeTypeWarning = WarningBase<'b-value.unknown-magnitude-type', { count: number }>;
export type SmallSampleAboveMcWarning = WarningBase<
  'b-value.small-sample-above-mc',
  { nAboveMc: number; minEvents: number }
>;
export type MostEventsBelowMcWarning = WarningBase<
  'b-value.most-events-below-mc',
  { nAboveMc: number; nTotal: number }
>;
export type DerivedSigmaIntervalWarning = WarningBase<
  'b-value.derived-sigma-interval',
  { low: number; high: number; sigma: number }
>;

export type MedianBaselineMaskingWarning = WarningBase<'tremor.median-baseline-masking', { fraction: number }>;
export type NoBaselineWarning = WarningBase<'tremor.no-baseline', NoParams>;
export type EmergentOnsetWarning = WarningBase<'tremor.emergent-onset', NoParams>;
export type UndefinedBandWarning = WarningBase<'tremor.undefined-band', NoParams>;

export type ChannelsBelowThresholdWarning = WarningBase<
  'uptime.channels-below-threshold',
  { count: number; threshold: number }
>;
export type ChannelsUnobservedWarning = WarningBase<'uptime.channels-unobserved', { count: number }>;

export type AnalyticsWarning =
  | McAtCatalogFloorWarning
  | MixedMagnitudeScalesWarning
  | UnknownMagnitudeTypeWarning
  | SmallSampleAboveMcWarning
  | MostEventsBelowMcWarning
  | DerivedSigmaIntervalWarning
  | MedianBaselineMaskingWarning
  | NoBaselineWarning
  | EmergentOnsetWarning
  | UndefinedBandWarning
  | ChannelsBelowThresholdWarning
  | ChannelsUnobservedWarning;

export type AnalyticsWarningId = AnalyticsWarning['id'];

// --- aritmética derivada --------------------------------------------------------

/**
 * `b ± NORMAL_95_FACTOR · σ`. Devuelve NÚMEROS, nunca strings formateados: el
 * locale lo pone el componente.
 */
export function derivedBInterval(b: number, sigmaB: number): { low: number; high: number } {
  const halfWidth = NORMAL_95_FACTOR * sigmaB;
  return { low: b - halfWidth, high: b + halfWidth };
}

// --- orden determinista ---------------------------------------------------------

/**
 * Ranking de severidad. El `sort` que lo usa es ESTABLE (ES2019), así que a
 * igual severidad se preserva el orden de DECLARACIÓN de cada regla — nunca el
 * orden de iteración de un objeto, que sería un test flaky esperando pasar.
 */
const SEVERITY_RANK: Record<WarningSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function bySeverity<T extends AnalyticsWarning>(warnings: T[]): T[] {
  return [...warnings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

// --- reglas de b-value ----------------------------------------------------------

/**
 * Las 6 reglas de b-value, evaluadas en el orden de declaración del catálogo y
 * devueltas ordenadas por severidad.
 *
 * `small-sample-above-mc` y `derived-sigma-interval` viven DENTRO del narrow
 * `status === 'ok'` porque `sigma_b` solo existe en `BValueOk`
 * (`analytics.ts:76`): no se defienden con `?.`, se apoyan en que de otra forma
 * NO COMPILA.
 */
export function bValueWarnings(response: BValueResponse): AnalyticsWarning[] {
  const warnings: AnalyticsWarning[] = [];

  // `&& mc !== null` es divergencia deliberada respecto de la spec (C5): el
  // mensaje interpola {mc} y con `mc: null` la clave renderizaría un hueco. El
  // test "mc_at_catalog_floor true con mc null NO emite" la fija.
  if (response.mc_at_catalog_floor === true && response.mc !== null) {
    warnings.push({
      id: 'b-value.mc-at-catalog-floor',
      severity: 'critical',
      params: { mc: response.mc },
    });
  }

  const scaleEntries = Object.entries(response.mag_type_counts);
  if (scaleEntries.length > 1) {
    // Gutenberg-Richter asume UNA escala; el catálogo fusionado mezcla más.
    warnings.push({
      id: 'b-value.mixed-magnitude-scales',
      severity: 'warning',
      params: {
        scales: scaleEntries.map(([scale, count]) => `${scale} (${count})`).join(', '),
        count: scaleEntries.length,
      },
    });
  }

  const unknownCount = response.mag_type_counts.unknown ?? 0;
  if (unknownCount > 0) {
    warnings.push({
      id: 'b-value.unknown-magnitude-type',
      severity: 'info',
      params: { count: unknownCount },
    });
  }

  if (response.status === 'ok') {
    // `min_events: 0` da umbral 0 y `n_above_mc < 0` es falso: no hace falta un
    // `if` extra, pero sí el test que lo fija.
    if (response.n_above_mc < response.min_events * SMALL_SAMPLE_FACTOR) {
      warnings.push({
        id: 'b-value.small-sample-above-mc',
        severity: 'warning',
        params: { nAboveMc: response.n_above_mc, minEvents: response.min_events },
      });
    }
  }

  // Se guarda `n_total > 0` ANTES de dividir: un catálogo vacío no produce NaN.
  if (response.n_total > 0 && response.n_above_mc / response.n_total < 0.5) {
    warnings.push({
      id: 'b-value.most-events-below-mc',
      severity: 'info',
      params: { nAboveMc: response.n_above_mc, nTotal: response.n_total },
    });
  }

  if (response.status === 'ok') {
    const { low, high } = derivedBInterval(response.b, response.sigma_b);
    warnings.push({
      id: 'b-value.derived-sigma-interval',
      severity: 'info',
      params: { low, high, sigma: response.sigma_b },
    });
  }

  return bySeverity(warnings);
}

// --- reglas de tremor -----------------------------------------------------------

/**
 * Las 4 reglas de tremor. Las dos que miran episodios usan `.some(...)`: una
 * advertencia POR REGLA, no una por episodio — diez episodios emergentes no
 * son diez avisos, son un aviso.
 */
export function tremorWarnings(response: TremorResponse): AnalyticsWarning[] {
  const warnings: AnalyticsWarning[] = [];

  if (response.tremor_fraction > TREMOR_BASELINE_MASK_FRACTION) {
    warnings.push({
      id: 'tremor.median-baseline-masking',
      severity: 'warning',
      params: { fraction: response.tremor_fraction },
    });
  }

  // `=== null` EXPLÍCITO, nunca `!baseline_rsam`: un `0` es un hecho medido
  // ("se miró y la amplitud es cero") y NO es "sin dato". Es la invariante
  // `null ≠ 0` de `lib/analytics.ts` y `src/models/analytics.py:11-15`.
  if (response.baseline_rsam === null) {
    warnings.push({ id: 'tremor.no-baseline', severity: 'info', params: {} });
  }

  if (response.episodes.some((ep) => ep.onset_ratio < EMERGENT_ONSET_RATIO)) {
    warnings.push({ id: 'tremor.emergent-onset', severity: 'info', params: {} });
  }

  if (response.episodes.some((ep) => ep.band === 'undefined')) {
    warnings.push({ id: 'tremor.undefined-band', severity: 'info', params: {} });
  }

  return bySeverity(warnings);
}
