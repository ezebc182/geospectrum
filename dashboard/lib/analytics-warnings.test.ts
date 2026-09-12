/**
 * Tests de la lib pura de reglas de confiabilidad (analytics-redesign, Fase 2).
 *
 * El estándar de esta fase: la lib no la consume NADIE todavía, así que el
 * verde por sí solo no distingue una lib correcta de una que nunca se ejecutó.
 * Cada regla del catálogo tiene su mutación registrada en `mutation-log.md`.
 */
import { describe, expect, it } from 'vitest';

import type { BValueNotEstimable, BValueOk, TremorEpisode, TremorResponse } from './analytics';
import {
  type AnalyticsWarning,
  EMERGENT_ONSET_RATIO,
  NORMAL_95_FACTOR,
  SMALL_SAMPLE_FACTOR,
  TREMOR_BASELINE_MASK_FRACTION,
  UPTIME_ATTENTION_THRESHOLD,
  bValueWarnings,
  derivedBInterval,
  tremorWarnings,
} from './analytics-warnings';

/** Respuesta sana: `ok`, un solo tipo de magnitud, muestra holgada. */
function okResponse(overrides: Partial<BValueOk> = {}): BValueOk {
  return {
    status: 'ok',
    method: 'aki-utsu-mle',
    n_total: 400,
    n_above_mc: 300,
    min_events: 50,
    mc: 2.1,
    mc_at_catalog_floor: false,
    bins: [],
    mag_type_counts: { ml: 300 },
    window_start: '2026-09-01T00:00:00Z',
    window_end: '2026-09-08T00:00:00Z',
    area_slug: null,
    b: 1.0,
    a: 4.2,
    sigma_b: 0.05,
    ...overrides,
  };
}

function notEstimableResponse(overrides: Partial<BValueNotEstimable> = {}): BValueNotEstimable {
  const { b: _b, a: _a, sigma_b: _sigma, status: _status, ...base } = okResponse();
  return { ...base, status: 'insufficient', ...overrides };
}

const ids = (warnings: readonly AnalyticsWarning[]): string[] => warnings.map((w) => w.id);

function find(warnings: readonly AnalyticsWarning[], id: string): AnalyticsWarning | undefined {
  return warnings.find((w) => w.id === id);
}

describe('constantes de la lib de advertencias', () => {
  it('los cinco umbrales tienen el valor que fija la spec', () => {
    expect(NORMAL_95_FACTOR).toBe(1.96);
    expect(UPTIME_ATTENTION_THRESHOLD).toBe(0.9);
    expect(SMALL_SAMPLE_FACTOR).toBe(1.5);
    expect(TREMOR_BASELINE_MASK_FRACTION).toBe(0.5);
    expect(EMERGENT_ONSET_RATIO).toBe(0.3);
  });
});

describe('derivedBInterval', () => {
  it('deriva b ± 1.96σ (punto flotante: 1 - 1.96*0.1 no da 0.804 exacto)', () => {
    const { low, high } = derivedBInterval(1.0, 0.1);
    expect(low).toBeCloseTo(0.804, 10);
    expect(high).toBeCloseTo(1.196, 10);
  });

  it('con sigma_b en cero el intervalo colapsa pero la función no falla', () => {
    expect(derivedBInterval(0.9, 0)).toEqual({ low: 0.9, high: 0.9 });
  });

  it('el cálculo sale de la constante, no de un 1.96 escrito a mano', () => {
    // Se compara contra la constante IMPORTADA: si alguien cambia el valor de
    // la constante, este caso sigue verde (muta con ella) y es el caso 2 el que
    // cae. Este prueba que el código la USA; el otro prueba su VALOR.
    const b = 1.23;
    const sigma = 0.07;
    const { low, high } = derivedBInterval(b, sigma);
    expect(low).toBeCloseTo(b - NORMAL_95_FACTOR * sigma, 10);
    expect(high).toBeCloseTo(b + NORMAL_95_FACTOR * sigma, 10);
  });
});

describe('bValueWarnings', () => {
  it('una respuesta sana solo trae el intervalo derivado, que con status ok dispara siempre', () => {
    // Matiz: la spec dice "array vacío" en su escenario sano, pero esa misma
    // spec declara `derived-sigma-interval` con condición "status === 'ok'
    // (siempre que haya estimación)". El array LITERALMENTE vacío solo existe
    // con status !== 'ok' y sin otros disparadores — es el caso de abajo.
    expect(ids(bValueWarnings(okResponse()))).toEqual(['b-value.derived-sigma-interval']);
  });

  it('sin estimación y sin otros disparadores el array es literalmente vacío', () => {
    expect(bValueWarnings(notEstimableResponse())).toEqual([]);
  });

  it('mc_at_catalog_floor true emite critical, y en false no la reemplaza ninguna otra', () => {
    const conFloor = bValueWarnings(okResponse({ mc_at_catalog_floor: true, mc: 2.1 }));
    const floor = find(conFloor, 'b-value.mc-at-catalog-floor');
    expect(floor).toBeDefined();
    expect(floor?.severity).toBe('critical');

    const sinFloor = bValueWarnings(okResponse({ mc_at_catalog_floor: false }));
    expect(ids(sinFloor)).not.toContain('b-value.mc-at-catalog-floor');
    // Se asserta el LARGO, no solo la ausencia: si otra regla ocupara su lugar
    // la ausencia sola daría verde.
    expect(sinFloor).toHaveLength(conFloor.length - 1);
  });

  it('mc_at_catalog_floor true con mc null NO emite (C5, divergencia deliberada spec/design)', () => {
    // La spec dice `mc_at_catalog_floor === true`, punto. Se sigue al design
    // (`&& mc !== null`) SOLO porque el mensaje interpola {mc}: con mc null la
    // clave i18n renderizaría un hueco. Queda registrado acá para que no
    // parezca un olvido.
    const warnings = bValueWarnings(okResponse({ mc_at_catalog_floor: true, mc: null }));
    expect(ids(warnings)).not.toContain('b-value.mc-at-catalog-floor');
  });

  it('dos escalas de magnitud emiten mixed-magnitude-scales warning con escalas y conteos', () => {
    const warnings = bValueWarnings(okResponse({ mag_type_counts: { ml: 120, mw: 30 } }));
    const mixed = find(warnings, 'b-value.mixed-magnitude-scales');
    expect(mixed?.severity).toBe('warning');
    const params = mixed?.params as { scales: string; count: number };
    expect(params.count).toBe(2);
    expect(params.scales).toContain('ml');
    expect(params.scales).toContain('mw');
    expect(params.scales).toContain('120');
    expect(params.scales).toContain('30');
  });

  it('una sola escala no advierte', () => {
    const warnings = bValueWarnings(okResponse({ mag_type_counts: { ml: 150 } }));
    expect(ids(warnings)).not.toContain('b-value.mixed-magnitude-scales');
  });

  it('unknown con conteo positivo emite las dos, y mixed precede a unknown por severidad', () => {
    const warnings = bValueWarnings(okResponse({ mag_type_counts: { ml: 100, unknown: 8 } }));
    const listed = ids(warnings);
    expect(listed).toContain('b-value.mixed-magnitude-scales');
    expect(listed).toContain('b-value.unknown-magnitude-type');
    expect(listed.indexOf('b-value.mixed-magnitude-scales')).toBeLessThan(
      listed.indexOf('b-value.unknown-magnitude-type'),
    );
    expect(find(warnings, 'b-value.unknown-magnitude-type')?.severity).toBe('info');
  });

  it('unknown en cero no emite unknown-magnitude-type pero sí mixed (dos claves declaradas)', () => {
    const warnings = bValueWarnings(okResponse({ mag_type_counts: { ml: 100, unknown: 0 } }));
    expect(ids(warnings)).not.toContain('b-value.unknown-magnitude-type');
    expect(ids(warnings)).toContain('b-value.mixed-magnitude-scales');
  });

  it('mag_type_counts vacío no advierte ni lanza', () => {
    const warnings = bValueWarnings(okResponse({ mag_type_counts: {} }));
    expect(ids(warnings)).not.toContain('b-value.mixed-magnitude-scales');
    expect(ids(warnings)).not.toContain('b-value.unknown-magnitude-type');
  });

  it('muestra justo por encima del mínimo emite small-sample-above-mc warning', () => {
    const warnings = bValueWarnings(okResponse({ min_events: 50, n_above_mc: 60 }));
    expect(find(warnings, 'b-value.small-sample-above-mc')?.severity).toBe('warning');
  });

  it('el corte de small-sample es estrictamente < min_events * 1.5', () => {
    // Los dos bordes en el mismo it: 75 = 50*1.5 exacto no dispara, 74 sí.
    expect(ids(bValueWarnings(okResponse({ min_events: 50, n_above_mc: 75 })))).not.toContain(
      'b-value.small-sample-above-mc',
    );
    expect(ids(bValueWarnings(okResponse({ min_events: 50, n_above_mc: 74 })))).toContain(
      'b-value.small-sample-above-mc',
    );
  });

  it('min_events en cero no dispara y ningún params queda con NaN ni Infinity', () => {
    const warnings = bValueWarnings(okResponse({ min_events: 0, n_above_mc: 3, n_total: 400 }));
    expect(ids(warnings)).not.toContain('b-value.small-sample-above-mc');
    for (const warning of warnings) {
      for (const value of Object.values(warning.params as Record<string, unknown>)) {
        if (typeof value === 'number') {
          expect(Number.isFinite(value), `${warning.id} trae un valor no finito`).toBe(true);
        }
      }
    }
  });

  it('con más de la mitad del catálogo bajo Mc emite most-events-below-mc info', () => {
    const warnings = bValueWarnings(okResponse({ n_total: 400, n_above_mc: 120 }));
    expect(find(warnings, 'b-value.most-events-below-mc')?.severity).toBe('info');
  });

  it('un catálogo vacío no divide por cero ni emite most-events-below-mc', () => {
    const warnings = bValueWarnings(okResponse({ n_total: 0, n_above_mc: 0, min_events: 0 }));
    expect(ids(warnings)).not.toContain('b-value.most-events-below-mc');
    for (const warning of warnings) {
      for (const value of Object.values(warning.params as Record<string, unknown>)) {
        if (typeof value === 'number') expect(Number.isNaN(value)).toBe(false);
      }
    }
  });

  it('el intervalo derivado llega en params con los extremos numéricos', () => {
    const warnings = bValueWarnings(okResponse({ b: 1.0, sigma_b: 0.1 }));
    const derived = find(warnings, 'b-value.derived-sigma-interval');
    const params = derived?.params as { low: number; high: number };
    expect(params.low).toBeCloseTo(0.804, 10);
    expect(params.high).toBeCloseTo(1.196, 10);
  });

  it('con status insufficient no aparecen las reglas que dependen de b, pero sí las demás', () => {
    const warnings = bValueWarnings(
      notEstimableResponse({
        status: 'insufficient',
        mc_at_catalog_floor: true,
        mc: 2.1,
        mag_type_counts: { ml: 10, mw: 2 },
        n_above_mc: 10,
        min_events: 50,
      }),
    );
    const listed = ids(warnings);
    expect(listed).not.toContain('b-value.derived-sigma-interval');
    expect(listed).not.toContain('b-value.small-sample-above-mc');
    expect(listed).toContain('b-value.mc-at-catalog-floor');
    expect(listed).toContain('b-value.mixed-magnitude-scales');
  });

  it('el orden es por severidad, no por orden de declaración de las reglas', () => {
    // El caso está ELEGIDO para que los dos órdenes NO coincidan:
    // `unknown-magnitude-type` (info) se declara ANTES que
    // `small-sample-above-mc` (warning). Sin el sort por severidad, el info
    // saldría primero. Un caso donde ambos órdenes coinciden deja la mutación
    // "quitar el sort" en verde y no prueba nada — ya pasó (mutación 2.6).
    const response = okResponse({
      mc_at_catalog_floor: true,
      mc: 2.1,
      mag_type_counts: { ml: 100, unknown: 4 },
      n_total: 400,
      n_above_mc: 60,
      min_events: 50,
    });
    const first = ids(bValueWarnings(response));
    const second = ids(bValueWarnings(response));
    expect(first).toEqual(second);
    expect(first[0]).toBe('b-value.mc-at-catalog-floor');
    expect(first.indexOf('b-value.small-sample-above-mc')).toBeLessThan(
      first.indexOf('b-value.unknown-magnitude-type'),
    );

    const severities = bValueWarnings(response).map((w) => w.severity);
    expect(severities.indexOf('critical')).toBe(0);
    // Ningún `info` precede a un `warning`.
    expect(severities.indexOf('info')).toBeGreaterThan(severities.lastIndexOf('warning'));
  });

  it('critical es escaso: mc-at-catalog-floor es la ÚNICA regla que puede emitirlo', () => {
    // Se dispara el catálogo COMPLETO de b-value a la vez y se verifica que
    // solo una advertencia sea critical. Es el test que hace verificable el
    // riesgo "si todo advierte, nada advierte".
    const todas = bValueWarnings(
      okResponse({
        mc_at_catalog_floor: true,
        mc: 2.1,
        mag_type_counts: { ml: 100, unknown: 4 },
        n_total: 400,
        n_above_mc: 60,
        min_events: 50,
      }),
    );
    const criticals = todas.filter((w) => w.severity === 'critical');
    expect(criticals.map((w) => w.id)).toEqual(['b-value.mc-at-catalog-floor']);
    expect(todas.length).toBeGreaterThan(3);
  });

  it('la lib no traduce: cada advertencia tiene exactamente id, severity y params', () => {
    const todas = bValueWarnings(
      okResponse({ mc_at_catalog_floor: true, mc: 2.1, mag_type_counts: { ml: 10, mw: 4 }, n_above_mc: 60 }),
    );
    expect(todas.length).toBeGreaterThan(0);
    for (const warning of todas) {
      expect(Object.keys(warning).sort()).toEqual(['id', 'params', 'severity']);
      for (const prohibida of ['message', 'text', 'label'] as const) {
        expect(warning).not.toHaveProperty(prohibida);
      }
      for (const value of Object.values(warning.params as Record<string, unknown>)) {
        expect(['string', 'number']).toContain(typeof value);
      }
    }
  });
});

/** Episodio mínimo: solo importan `onset_ratio` y `band` para estas reglas. */
function episode(overrides: Partial<TremorEpisode> = {}): TremorEpisode {
  return {
    start: '2026-09-01T00:00:00Z',
    end: '2026-09-01T00:10:00Z',
    samples: 40,
    duration_s: 600,
    mean_ratio: 2.4,
    peak_rsam: 120,
    peak_ratio: 3.1,
    onset_ratio: 0.8,
    mean_dominant_hz: 3.2,
    mean_fi: -0.4,
    band: 'mid',
    fi_sign: 'lp_like',
    ...overrides,
  };
}

function tremorResponse(overrides: Partial<TremorResponse> = {}): TremorResponse {
  return {
    channel: 'AR.CHE.00.HHZ',
    sampling_rate: 100,
    period_seconds: 15,
    baseline_rsam: 50,
    threshold_rsam: 100,
    tremor_fraction: 0.1,
    parameters: { baseline_factor: 2.0, min_duration_periods: 3 },
    samples: [],
    episodes: [],
    ...overrides,
  };
}

describe('tremorWarnings', () => {
  it('el corte de median-baseline-masking es estrictamente > 0.5', () => {
    const alta = tremorWarnings(tremorResponse({ tremor_fraction: 0.62 }));
    expect(find(alta, 'tremor.median-baseline-masking')?.severity).toBe('warning');
    // 0.5 exacto NO aparece: el corte es estrictamente mayor.
    const exacta = tremorWarnings(tremorResponse({ tremor_fraction: 0.5 }));
    expect(ids(exacta)).not.toContain('tremor.median-baseline-masking');
  });

  it('baseline_rsam null emite no-baseline con severidad info (C3)', () => {
    const warnings = tremorWarnings(tremorResponse({ baseline_rsam: null, threshold_rsam: null }));
    expect(find(warnings, 'tremor.no-baseline')?.severity).toBe('info');
  });

  it('una línea base en CERO no es "sin dato": no emite no-baseline', () => {
    // Invariante `null ≠ 0` que declaran `lib/analytics.ts` y
    // `src/models/analytics.py:11-15`. Convertir null en 0 acá reintroduciría
    // del lado del frontend el bug que el backend evita a propósito.
    const warnings = tremorWarnings(tremorResponse({ baseline_rsam: 0, threshold_rsam: 0 }));
    expect(ids(warnings)).not.toContain('tremor.no-baseline');
  });

  it('sin episodios las reglas por episodio no disparan ni lanzan', () => {
    const warnings = tremorWarnings(tremorResponse({ episodes: [] }));
    expect(ids(warnings)).not.toContain('tremor.emergent-onset');
    expect(ids(warnings)).not.toContain('tremor.undefined-band');
  });

  it('emergent-onset aparece UNA sola vez, no una por episodio', () => {
    const warnings = tremorWarnings(
      tremorResponse({
        episodes: [episode({ onset_ratio: 0.8 }), episode({ onset_ratio: 0.12 }), episode({ onset_ratio: 0.05 })],
      }),
    );
    expect(ids(warnings).filter((id) => id === 'tremor.emergent-onset')).toHaveLength(1);
    expect(find(warnings, 'tremor.emergent-onset')?.severity).toBe('info');
  });

  it('un episodio con banda undefined entre varios emite undefined-band una vez', () => {
    const warnings = tremorWarnings(
      tremorResponse({
        episodes: [episode({ band: 'mid' }), episode({ band: 'undefined' }), episode({ band: 'low' })],
      }),
    );
    expect(ids(warnings).filter((id) => id === 'tremor.undefined-band')).toHaveLength(1);
  });

  it('sin ninguna banda undefined no aparece undefined-band', () => {
    const warnings = tremorWarnings(
      tremorResponse({ episodes: [episode({ band: 'mid' }), episode({ band: 'high' })] }),
    );
    expect(ids(warnings)).not.toContain('tremor.undefined-band');
  });
});
