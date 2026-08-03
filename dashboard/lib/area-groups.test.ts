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

  it('manda a Regiones lo que no está clasificado', () => {
    // El fallback importa: un área nueva del catálogo tiene que aparecer igual,
    // aunque nadie la haya clasificado todavía.
    expect(groupOf(makeArea('chile', 'Chile'))).toBe('regions');
    expect(groupOf(makeArea('slug_inventado', 'Área futura'))).toBe('regions');
  });

  it('manda las áreas del usuario a "Mis áreas" aunque el slug sea de catálogo', () => {
    expect(groupOf(makeArea('san_andres', 'Mi San Andrés', false))).toBe('mine');
  });
});

describe('groupAreas', () => {
  it('omite los grupos vacíos', () => {
    // Sin áreas propias, "Mis áreas" no debe aparecer como etiqueta suelta.
    const groups = groupAreas([makeArea('chile', 'Chile')]);

    expect(groups.map((g) => g.id)).toEqual(['regions']);
  });

  it('respeta el orden de grupos y pone lo del usuario primero', () => {
    const groups = groupAreas([
      makeArea('chile', 'Chile'),
      makeArea('san_andres', 'Falla de San Andrés'),
      makeArea('global', 'Global'),
      makeArea('mi_zona', 'Mi zona', false),
      makeArea('anillo_de_fuego', 'Anillo de Fuego'),
    ]);

    expect(groups.map((g) => g.id)).toEqual([
      'mine',
      'global',
      'belts',
      'faults',
      'regions',
    ]);
  });

  it('ordena alfabéticamente dentro del grupo respetando los acentos', () => {
    const groups = groupAreas([
      makeArea('peru', 'Perú y fosa Perú-Chile (norte)'),
      makeArea('mexico', 'México y fosa Mesoamericana'),
      makeArea('chile', 'Chile y fosa Perú-Chile'),
    ]);

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

    const total = groupAreas(areas).reduce((sum, g) => sum + g.areas.length, 0);

    expect(total).toBe(areas.length);
  });

  it('devuelve una lista vacía sin áreas', () => {
    expect(groupAreas([])).toEqual([]);
  });
});
