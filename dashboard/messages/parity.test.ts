/**
 * Test de paridad ES/EN (spec "Paridad de claves ES/EN verificada por
 * test"): los dos diccionarios deben tener EXACTAMENTE el mismo set de
 * claves aplanadas, en ambas direcciones, y ningún valor vacío. Complementa
 * la augmentation de tipos (que solo valida claves contra ES en compile
 * time — no detecta un EN divergente).
 */
import { describe, expect, it } from 'vitest';

import en from './en.json';
import es from './es.json';

type MessageTree = { [key: string]: string | MessageTree };

/** Aplana el árbol de mensajes a claves con puntos: nav.userMenu.logout. */
function flattenKeys(tree: MessageTree, prefix = ''): Map<string, string> {
  const flat = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      flat.set(path, value);
    } else {
      for (const [childPath, childValue] of flattenKeys(value, path)) {
        flat.set(childPath, childValue);
      }
    }
  }
  return flat;
}

const esFlat = flattenKeys(es as MessageTree);
const enFlat = flattenKeys(en as MessageTree);

describe('paridad de mensajes ES/EN', () => {
  it('toda clave de ES existe en EN', () => {
    const missingInEn = [...esFlat.keys()].filter((key) => !enFlat.has(key));
    expect(missingInEn, `Claves presentes en es.json y ausentes en en.json: ${missingInEn.join(', ')}`).toEqual([]);
  });

  it('toda clave de EN existe en ES', () => {
    const missingInEs = [...enFlat.keys()].filter((key) => !esFlat.has(key));
    expect(missingInEs, `Claves presentes en en.json y ausentes en es.json: ${missingInEs.join(', ')}`).toEqual([]);
  });

  it('ningún valor está vacío en ES', () => {
    const empty = [...esFlat.entries()].filter(([, value]) => value.trim() === '').map(([key]) => key);
    expect(empty, `Valores vacíos en es.json: ${empty.join(', ')}`).toEqual([]);
  });

  it('ningún valor está vacío en EN', () => {
    const empty = [...enFlat.entries()].filter(([, value]) => value.trim() === '').map(([key]) => key);
    expect(empty, `Valores vacíos en en.json: ${empty.join(', ')}`).toEqual([]);
  });
});
