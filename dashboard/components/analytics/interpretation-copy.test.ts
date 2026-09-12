/**
 * Test de LÍMITE DE DOMINIO sobre las claves i18n de la capa de interpretación
 * (analytics-redesign, Fase 2).
 *
 * El límite lo fija `src/services/tremor.py:30-32`: se puede afirmar amplitud
 * sostenida, banda dominante y signo del FI; **la interpretación del fenómeno
 * es del sismólogo**. Un riesgo declarado High que solo viviera en una tabla de
 * riesgos no estaría mitigado: acá se convierte en un test.
 *
 * Se importan los dos JSON DIRECTO (no vía provider): lo que se audita es el
 * contenido, no el render.
 */
import { describe, expect, it } from 'vitest';

import en from '../../messages/en.json';
import es from '../../messages/es.json';

type MessageNode = string | { [key: string]: MessageNode };

/** Aplana un subárbol a `path -> string`. */
function flatten(node: MessageNode, prefix: string): Map<string, string> {
  const flat = new Map<string, string>();
  if (typeof node === 'string') {
    flat.set(prefix, node);
    return flat;
  }
  for (const [key, value] of Object.entries(node)) {
    for (const [path, text] of flatten(value, `${prefix}.${key}`)) flat.set(path, text);
  }
  return flat;
}

/** Las claves NUEVAS de esta fase: glosario y mensajes de advertencia. */
function newKeysOf(locale: string, messages: unknown): Map<string, string> {
  const analytics = (messages as { analytics: Record<string, MessageNode> }).analytics;
  const flat = new Map<string, string>();
  for (const subtree of ['glossary', 'warnings'] as const) {
    const node = analytics[subtree];
    expect(node, `falta el subárbol analytics.${subtree} en ${locale}.json`).toBeTruthy();
    for (const [path, text] of flatten(node, `${locale}:analytics.${subtree}`)) flat.set(path, text);
  }
  return flat;
}

const allStrings = new Map<string, string>([...newKeysOf('es', es), ...newKeysOf('en', en)]);

/**
 * Piso de cobertura. Sin este `it`, un typo en el path de un subárbol dejaría
 * el test VERDE iterando sobre cero strings — exactamente el modo de fallo que
 * la Fase 1 encontró en `chart-chrome.test.ts`.
 */
const MINIMUM_STRINGS = 50;

/** Diagnóstico de fenómeno: lo que la UI NO puede afirmar. */
const FORBIDDEN_TERMS = [
  'tremor volcánico',
  'volcanic tremor',
  'erupción',
  'eruption',
  'enjambre',
  'swarm',
  'precursor',
  'inminente',
  'imminent',
  'predice',
  'predicts',
  'volcán',
  'volcánico',
  'volcanic',
  'premonitor',
];

/** Riesgo distinto: confundir la σ de Shi & Bolt con un intervalo de confianza. */
const CONFIDENCE_INTERVAL_TERMS = ['intervalo de confianza', 'confidence interval'];

function violations(terms: readonly string[]): string[] {
  const found: string[] = [];
  for (const [path, text] of allStrings) {
    const haystack = text.toLowerCase();
    for (const term of terms) {
      if (haystack.includes(term.toLowerCase())) found.push(`${path} contiene "${term}"`);
    }
  }
  return found;
}

describe('límite de dominio de las claves de interpretación', () => {
  it(`recorre al menos ${MINIMUM_STRINGS} strings de los dos locales`, () => {
    expect(
      allStrings.size,
      `el recorrido tocó ${allStrings.size} strings: si bajó mucho, el path de un subárbol está mal y el test no protege nada`,
    ).toBeGreaterThanOrEqual(MINIMUM_STRINGS);
  });

  it('ninguna clave nueva diagnostica un fenómeno de dominio, en ES ni en EN', () => {
    const found = violations(FORBIDDEN_TERMS);
    expect(found, `términos de diagnóstico prohibidos encontrados:\n${found.join('\n')}`).toEqual([]);
  });

  it('ninguna clave llama "intervalo de confianza" al intervalo derivado de sigma', () => {
    // `sigma_b` es la σ de Shi & Bolt (1982), no un IC del backend. Rotularlo
    // como IC sería atribuirle al backend un cálculo que no hizo.
    const found = violations(CONFIDENCE_INTERVAL_TERMS);
    expect(found, `el intervalo derivado se está rotulando como IC:\n${found.join('\n')}`).toEqual([]);
  });
});
