/**
 * Catálogo de términos del glosario v1 (analytics-redesign, Fase 2).
 *
 * Cinco términos, ni uno más. El criterio de corte es "entra lo que es una
 * ETIQUETA VISIBLE en la UI": `sigma_b`, `onset_ratio`, `fi_sign` y
 * `tremor_fraction` NO son etiquetas —son magnitudes que aparecen dentro de una
 * fila o de una frase— y se explican dentro del texto de su propia advertencia.
 * Un glosario que crece con cada campo del backend deja de ser un glosario y
 * pasa a ser documentación. Un sexto término es un pedido nuevo.
 *
 * Acá NO vive ninguna definición: la prosa está en `messages/es.json` y
 * `messages/en.json`, bajo `analytics.glossary`. Este archivo solo mapea el id
 * a su clave de mensaje.
 */

/** Unión CERRADA: pedir `'sigma_b'` no compila, no falla en runtime. */
export type GlossaryTermId = 'b-value' | 'mc' | 'rsam' | 'fi' | 'uptime-ratio';

export const GLOSSARY_TERM_IDS = ['b-value', 'mc', 'rsam', 'fi', 'uptime-ratio'] as const satisfies readonly GlossaryTermId[];

/**
 * Id (kebab-case, como se lee en el código del panel) → segmento de clave i18n
 * (camelCase, como exige next-intl).
 *
 * La tabla es EXPLÍCITA a propósito, en vez de un `camelCase()` genérico: con
 * cinco entradas cerradas, un helper de conversión agrega una función que
 * puede fallar en silencio (`'uptime-ratio'` → `'uptimeRatio'` está bien, pero
 * nadie garantiza que el próximo id se convierta como el traductor espera).
 * Siendo `Record<GlossaryTermId, string>`, olvidarse una entrada NO COMPILA.
 */
export const GLOSSARY_MESSAGE_KEYS: Record<GlossaryTermId, string> = {
  'b-value': 'bValue',
  mc: 'mc',
  rsam: 'rsam',
  fi: 'fi',
  'uptime-ratio': 'uptimeRatio',
};
