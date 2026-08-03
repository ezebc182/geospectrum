import { describe, expect, it } from 'vitest';

import { countAreas, filterGroups, normalize } from './area-search';
import type { AreaGroup } from './area-groups';
import type { Area } from '@/lib/types';

function makeArea(slug: string, name: string): Area {
  return {
    id: `id-${slug}`,
    slug,
    name,
    is_system: true,
    geometry: { type: 'Polygon', coordinates: [] } as unknown as Area['geometry'],
    bbox: { minlat: 0, minlon: 0, maxlat: 1, maxlon: 1 } as unknown as Area['bbox'],
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };
}

/** Réplica reducida del catálogo real, con sus acentos y nombres largos. */
function catalog(): AreaGroup[] {
  return [
    {
      id: 'belts',
      label: 'Cinturones sísmicos',
      areas: [makeArea('anillo_de_fuego', 'Cinturón — Anillo de Fuego')],
    },
    {
      id: 'subduction',
      label: 'Zonas de subducción',
      areas: [
        makeArea('cascadia', 'Zona de subducción de Cascadia'),
        makeArea('chile', 'Chile y fosa Perú-Chile'),
        makeArea('japon', 'Japón y fosa de Japón'),
        makeArea('mexico', 'México y fosa Mesoamericana'),
      ],
    },
    {
      id: 'faults',
      label: 'Fallas',
      areas: [makeArea('san_andres', 'Falla de San Andrés (California)')],
    },
  ];
}

describe('normalize', () => {
  it('saca los acentos para que se pueda buscar sin tipearlos', () => {
    expect(normalize('Japón')).toBe('japon');
    expect(normalize('México')).toBe('mexico');
    expect(normalize('Perú')).toBe('peru');
  });

  it('pasa a minúsculas y recorta los espacios de los bordes', () => {
    expect(normalize('  CASCADIA  ')).toBe('cascadia');
  });
});

describe('filterGroups', () => {
  it('devuelve todo con la consulta vacía', () => {
    const groups = catalog();

    expect(filterGroups(groups, '')).toEqual(groups);
    expect(filterGroups(groups, '   ')).toEqual(groups);
  });

  it('encuentra por nombre sin exigir acentos', () => {
    const result = filterGroups(catalog(), 'japon');

    expect(countAreas(result)).toBe(1);
    expect(result[0].areas[0].slug).toBe('japon');
  });

  it('encuentra por slug, no sólo por el nombre visible', () => {
    // El nombre dice "Falla de San Andrés (California)": quien tipea el slug
    // que ve en la URL tiene que encontrarla igual.
    const result = filterGroups(catalog(), 'san_andres');

    expect(countAreas(result)).toBe(1);
    expect(result[0].areas[0].slug).toBe('san_andres');
  });

  it('acepta términos sueltos en cualquier orden', () => {
    // Un `includes` de la frase completa fallaría: en el nombre real "fosa" va
    // después de "Chile".
    const result = filterGroups(catalog(), 'fosa chile');

    expect(countAreas(result)).toBe(1);
    expect(result[0].areas[0].slug).toBe('chile');
  });

  it('omite los grupos que quedan sin áreas', () => {
    const result = filterGroups(catalog(), 'cascadia');

    expect(result.map((g) => g.id)).toEqual(['subduction']);
  });

  it('conserva la agrupación cuando el filtro cruza varios grupos', () => {
    // "fosa" aparece en Chile, Japón y México (todos subducción); el grupo se
    // mantiene en vez de aplanarse a una lista suelta.
    const result = filterGroups(catalog(), 'fosa');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('subduction');
    expect(result[0].areas.map((a) => a.slug)).toEqual(['chile', 'japon', 'mexico']);
  });

  it('devuelve vacío cuando no matchea nada', () => {
    expect(filterGroups(catalog(), 'atlantida')).toEqual([]);
  });

  it('no muta los grupos que recibe', () => {
    const groups = catalog();
    const before = countAreas(groups);

    filterGroups(groups, 'cascadia');

    expect(countAreas(groups)).toBe(before);
  });
});

describe('countAreas', () => {
  it('suma las áreas de todos los grupos', () => {
    expect(countAreas(catalog())).toBe(6);
  });

  it('devuelve cero sin grupos', () => {
    expect(countAreas([])).toBe(0);
  });
});
