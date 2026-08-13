/**
 * Tests de la traducción client-side de nombres de áreas (hallazgo del QA de
 * i18n: los nombres seedeados salían en español con la UI en inglés).
 *
 * Lógica pura: el traductor se fabrica a mano con el mismo contrato mínimo
 * (`t()` + `t.has()`) que declara el módulo — sin montar next-intl.
 */

import { describe, expect, it } from 'vitest';

import { areaDisplayName, localizeAreaNames, type AreaNameTranslator } from './area-name';
import type { Area } from './types';

/** Traductor de juguete: solo conoce las claves del diccionario que se le da. */
function makeTranslator(dictionary: Record<string, string>): AreaNameTranslator {
  const t = ((key: string) => dictionary[key] ?? `MISSING:${key}`) as AreaNameTranslator;
  t.has = (key: string) => key in dictionary;
  return t;
}

function makeArea(slug: string, name: string, isSystem = true): Area {
  return {
    id: `id-${slug}`,
    slug,
    name,
    is_system: isSystem,
    geometry: { type: 'Polygon', coordinates: [] },
    bbox: { minlat: 0, minlon: 0, maxlat: 1, maxlon: 1 },
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };
}

const EN = makeTranslator({
  'names.chile': 'Chile and the Peru-Chile Trench',
  'names.san_andres': 'San Andreas Fault (California)',
});

describe('areaDisplayName', () => {
  it('traduce un área del sistema cuando la clave existe', () => {
    const area = makeArea('chile', 'Chile y fosa Perú-Chile');
    expect(areaDisplayName(area, EN)).toBe('Chile and the Peru-Chile Trench');
  });

  it('slug desconocido cae al nombre de la base sin invocar t()', () => {
    // Un área nueva del catálogo sin traducir NO debe mostrar "MISSING:…"
    // ni disparar el error de clave faltante de next-intl: t.has() guarda.
    const area = makeArea('atacama_norte', 'Atacama Norte');
    expect(areaDisplayName(area, EN)).toBe('Atacama Norte');
  });

  it('las áreas custom del usuario nunca se traducen, ni con slug del catálogo', () => {
    // El nombre lo puso el usuario: pisárselo sería renombrarle su área.
    const area = makeArea('chile', 'Mi zona de Chile', false);
    expect(areaDisplayName(area, EN)).toBe('Mi zona de Chile');
  });
});

describe('localizeAreaNames', () => {
  it('devuelve copias con el nombre localizado y preserva el resto del área', () => {
    const areas = [
      makeArea('chile', 'Chile y fosa Perú-Chile'),
      makeArea('atacama_norte', 'Atacama Norte'),
    ];

    const localized = localizeAreaNames(areas, EN);

    expect(localized.map((area) => area.name)).toEqual([
      'Chile and the Peru-Chile Trench',
      'Atacama Norte',
    ]);
    // El slug y el id no se tocan (la búsqueda por slug y el cambio de área
    // activos dependen de ellos) y el array original queda intacto.
    expect(localized[0].slug).toBe('chile');
    expect(localized[0].id).toBe('id-chile');
    expect(areas[0].name).toBe('Chile y fosa Perú-Chile');
  });
});
