/**
 * Tests del catálogo de términos del glosario (analytics-redesign, Fase 2).
 *
 * El catálogo TS y el contenido i18n son dos archivos distintos; el último
 * caso de acá es el que los ata: sin él, agregar un sexto término al JSON
 * dejaría este test verde.
 */
import { describe, expect, it } from 'vitest';

import es from '../messages/es.json';
import { GLOSSARY_MESSAGE_KEYS, GLOSSARY_TERM_IDS } from './glossary';

describe('catálogo del glosario v1', () => {
  it('tiene exactamente 5 términos y coinciden con las claves del Record', () => {
    expect(GLOSSARY_TERM_IDS).toHaveLength(5);
    expect([...GLOSSARY_TERM_IDS].sort()).toEqual(Object.keys(GLOSSARY_MESSAGE_KEYS).sort());
  });

  it('cada id mapea a una clave de mensaje no vacía', () => {
    for (const id of GLOSSARY_TERM_IDS) {
      expect(GLOSSARY_MESSAGE_KEYS[id], `falta la clave de mensaje de "${id}"`).toBeTruthy();
      expect(GLOSSARY_MESSAGE_KEYS[id].trim()).not.toBe('');
    }
  });

  it('no se cuela ningún término fuera del corte de la decisión 1', () => {
    // `sigma_b`, `onset_ratio`, `fi_sign` y `tremor_fraction` NO son etiquetas
    // visibles: se explican dentro del texto de su propia advertencia. Un
    // glosario que crece con cada campo del backend deja de ser un glosario.
    const fuera = ['sigma_b', 'onset_ratio', 'fi_sign', 'tremor_fraction'];
    for (const termino of fuera) {
      expect(GLOSSARY_TERM_IDS as readonly string[]).not.toContain(termino);
      expect(Object.values(GLOSSARY_MESSAGE_KEYS)).not.toContain(termino);
    }
  });

  it('el set de entradas del JSON coincide con el catálogo TS, en las DOS direcciones', () => {
    // Sin este caso, agregar una sexta entrada al glosario en `es.json` dejaría
    // el test verde: `GLOSSARY_TERM_IDS` es TS puro y no cuenta contra el JSON.
    const glossary = (es as { analytics: { glossary: Record<string, unknown> } }).analytics.glossary;
    const chrome = ['trigger', 'close'];
    const jsonKeys = Object.keys(glossary)
      .filter((key) => !chrome.includes(key))
      .sort();
    const catalogKeys = Object.values(GLOSSARY_MESSAGE_KEYS).sort();

    expect(jsonKeys, 'hay entradas en es.json que no están en GLOSSARY_MESSAGE_KEYS').toEqual(catalogKeys);
  });
});
