/**
 * Agrupación de las áreas de interés para el selector.
 *
 * Con 17 áreas del sistema, una lista plana obliga a leerlas todas para
 * encontrar una. Los grupos ("Fallas", "Cinturones"…) hacen el barrido visual
 * mucho más corto.
 *
 * La categoría se DERIVA DEL SLUG y no viene del backend: `areas_of_interest`
 * no tiene columna de categoría, y agregarla implicaba migración a mano (el
 * proyecto no usa Alembic), seed, schema y tipo del front. Se eligió el mapa
 * acá a sabiendas del trade-off: un área nueva en el catálogo cae en "Regiones"
 * hasta que se la clasifique. Degrada bien —aparece igual, sólo que en el grupo
 * genérico— en vez de desaparecer del selector.
 *
 * El día que exista `Area.category`, este archivo se reemplaza por una lectura
 * directa del campo y el resto del selector no se entera.
 */

import type { Area } from '@/lib/types';

export type AreaGroupId = 'mine' | 'global' | 'belts' | 'faults' | 'regions';

/** Orden en que se muestran los grupos. Lo propio del usuario va primero. */
export const AREA_GROUP_ORDER: AreaGroupId[] = [
  'mine',
  'global',
  'belts',
  'faults',
  'regions',
];

export const AREA_GROUP_LABELS: Record<AreaGroupId, string> = {
  mine: 'Mis áreas',
  global: 'Global',
  belts: 'Cinturones sísmicos',
  faults: 'Fallas',
  regions: 'Regiones',
};

/**
 * Slugs por categoría, tomados del catálogo real (17 áreas del sistema).
 * Lo que no figure acá cae en "Regiones", que es el grupo más numeroso y el
 * default razonable para un área geográfica nueva.
 */
const SLUG_GROUPS: Record<string, AreaGroupId> = {
  global: 'global',

  anillo_de_fuego: 'belts',
  cinturon_alpino_himalayo: 'belts',

  san_andres: 'faults',
  anatolia: 'faults',
};

/**
 * Grupo de un área. Las que no son del sistema van siempre a "Mis áreas",
 * aunque su slug coincida con uno del catálogo: para el usuario, que un área
 * sea SUYA pesa más que su clasificación geológica.
 */
export function groupOf(area: Area): AreaGroupId {
  if (!area.is_system) return 'mine';
  return SLUG_GROUPS[area.slug] ?? 'regions';
}

export interface AreaGroup {
  id: AreaGroupId;
  label: string;
  areas: Area[];
}

/**
 * Agrupa y ordena las áreas para el selector. Los grupos vacíos se omiten: hoy
 * "Mis áreas" no existe hasta que el usuario cree la primera, y una etiqueta
 * sola sin nada abajo sólo agrega ruido.
 */
export function groupAreas(areas: Area[]): AreaGroup[] {
  const byGroup = new Map<AreaGroupId, Area[]>();

  for (const area of areas) {
    const group = groupOf(area);
    const current = byGroup.get(group);
    if (current) current.push(area);
    else byGroup.set(group, [area]);
  }

  return AREA_GROUP_ORDER.flatMap((id) => {
    const groupAreas = byGroup.get(id);
    if (!groupAreas || groupAreas.length === 0) return [];
    return [
      {
        id,
        label: AREA_GROUP_LABELS[id],
        // Alfabético dentro del grupo: el orden del backend no es significativo
        // y `localeCompare` respeta los acentos del español (México, Perú).
        areas: [...groupAreas].sort((a, b) => a.name.localeCompare(b.name, 'es')),
      },
    ];
  });
}
