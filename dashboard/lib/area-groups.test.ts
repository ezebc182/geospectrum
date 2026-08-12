import { describe, expect, it } from 'vitest';

import { groupAreas, groupOf } from './area-groups';
import type { Area } from '@/lib/types';

function makeArea(slug: string, name: string, is_system = true): Area {
  return {
    id: `id-${slug}`,
    slug,
    name,
    is_system,
    geometry: { type: 'Polygon', coordinates: [] } as unknown as Area['geometry'],
    bbox: { minlat: 0, minlon: 0, maxlat: 1, maxlon: 1 } as unknown as Area['bbox'],
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };
}

describe('groupOf', () => {
  it('clasifica las fallas del catálogo', () => {
    expect(groupOf(makeArea('san_andres', 'Falla de San Andrés'))).toBe('faults');
    expect(groupOf(makeArea('anatolia', 'Anatolia'))).toBe('faults');
  });

  it('clasifica los cinturones del catálogo', () => {
    expect(groupOf(makeArea('anillo_de_fuego', 'Anillo de Fuego'))).toBe('belts');
    expect(groupOf(makeArea('cinturon_alpino_himalayo', 'Alpino-Himalayo'))).toBe('belts');
  });

  it('separa el área global', () => {
    expect(groupOf(makeArea('global', 'Global'))).toBe('global');
  });

  it('clasifica las zonas de subducción del catálogo', () => {
    expect(groupOf(makeArea('cascadia', 'Cascadia'))).toBe('subduction');
    expect(groupOf(makeArea('chile', 'Chile'))).toBe('subduction');
    expect(groupOf(makeArea('japon', 'Japón'))).toBe('subduction');
  });

  it('separa subducción de transformantes', () => {
    // Cascadia y San Andrés son vecinas geográficamente (las separa la triple
    // unión de Mendocino) pero son regímenes distintos, y el grupo lo refleja.
    expect(groupOf(makeArea('cascadia', 'Cascadia'))).toBe('subduction');
    expect(groupOf(makeArea('san_andres', 'San Andrés'))).toBe('faults');
  });

  it('deja en Regiones las áreas sin un régimen tectónico único', () => {
    // No es el fallback actuando por descuido: están sin clasificar a
    // propósito. Nueva Zelanda tiene subducción al noreste y una transformante
    // al suroeste; el Himalaya es colisión continental, sin subducción.
    expect(groupOf(makeArea('nueva_zelanda', 'Nueva Zelanda'))).toBe('regions');
    expect(groupOf(makeArea('himalaya', 'Himalaya'))).toBe('regions');
  });

  it('manda a Regiones lo que no está clasificado', () => {
    // El fallback importa: un área nueva del catálogo tiene que aparecer igual,
    // aunque nadie la haya clasificado todavía.
    expect(groupOf(makeArea('slug_inventado', 'Área futura'))).toBe('regions');
  });

  it('manda las áreas del usuario a "Mis áreas" aunque el slug sea de catálogo', () => {
    expect(groupOf(makeArea('san_andres', 'Mi San Andrés', false))).toBe('mine');
  });
});

describe('groupAreas', () => {
  it('omite los grupos vacíos', () => {
    // Sin áreas propias, "Mis áreas" no debe aparecer como etiqueta suelta.
    const groups = groupAreas([makeArea('himalaya', 'Himalaya')], 'es-AR');

    expect(groups.map((g) => g.id)).toEqual(['regions']);
  });

  it('respeta el orden de grupos y pone lo del usuario primero', () => {
    const groups = groupAreas([
      makeArea('himalaya', 'Himalaya'),
      makeArea('chile', 'Chile'),
      makeArea('san_andres', 'Falla de San Andrés'),
      makeArea('global', 'Global'),
      makeArea('mi_zona', 'Mi zona', false),
      makeArea('anillo_de_fuego', 'Anillo de Fuego'),
    ], 'es-AR');

    expect(groups.map((g) => g.id)).toEqual([
      'mine',
      'global',
      'belts',
      'subduction',
      'faults',
      'regions',
    ]);
  });

  it('ordena alfabéticamente dentro del grupo respetando los acentos', () => {
    const groups = groupAreas([
      makeArea('peru', 'Perú y fosa Perú-Chile (norte)'),
      makeArea('mexico', 'México y fosa Mesoamericana'),
      makeArea('chile', 'Chile y fosa Perú-Chile'),
    ], 'es-AR');

    expect(groups[0].areas.map((a) => a.name)).toEqual([
      'Chile y fosa Perú-Chile',
      'México y fosa Mesoamericana',
      'Perú y fosa Perú-Chile (norte)',
    ]);
  });

  it('no pierde ningún área al agrupar', () => {
    const areas = [
      makeArea('global', 'Global'),
      makeArea('anillo_de_fuego', 'Anillo de Fuego'),
      makeArea('san_andres', 'San Andrés'),
      makeArea('japon', 'Japón'),
      makeArea('propia', 'Propia', false),
    ];

    const total = groupAreas(areas, 'es-AR').reduce((sum, g) => sum + g.areas.length, 0);

    expect(total).toBe(areas.length);
  });

  it('devuelve una lista vacía sin áreas', () => {
    expect(groupAreas([], 'es-AR')).toEqual([]);
  });

  it('no devuelve label: el texto del grupo lo resuelve el componente', () => {
    // Decision 5 de i18n-dashboard: este módulo es puro y no importa
    // next-intl; expone el id y el componente traduce con t(`groups.${id}`).
    const groups = groupAreas([makeArea('chile', 'Chile')], 'es-AR');

    expect(groups[0]).not.toHaveProperty('label');
    expect(Object.keys(groups[0]).sort()).toEqual(['areas', 'id']);
  });

  it('ordena con el locale recibido, no con uno hardcodeado', () => {
    // El locale entra por parámetro (el componente lo pasa desde useLocale).
    // Se comprueba con sueco, donde "Ä" ordena DESPUÉS de "Z": en es/en va
    // junto a la "A", así que el orden delata qué locale se usó de verdad.
    const areas = [makeArea('a', 'Ätna'), makeArea('z', 'Zagros')];

    expect(groupAreas(areas, 'es-AR')[0].areas.map((a) => a.name)).toEqual([
      'Ätna',
      'Zagros',
    ]);
    expect(groupAreas(areas, 'sv')[0].areas.map((a) => a.name)).toEqual([
      'Zagros',
      'Ätna',
    ]);
  });
});
