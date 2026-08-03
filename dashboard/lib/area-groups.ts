/**
 * Agrupación de las áreas de interés para el selector.
 *
 * Con 18 áreas del sistema, una lista plana obliga a leerlas todas para
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

export type AreaGroupId =
  | 'mine'
  | 'global'
  | 'belts'
  | 'subduction'
  | 'faults'
  | 'regions';

/** Orden en que se muestran los grupos. Lo propio del usuario va primero. */
export const AREA_GROUP_ORDER: AreaGroupId[] = [
  'mine',
  'global',
  'belts',
  'subduction',
  'faults',
  'regions',
];

export const AREA_GROUP_LABELS: Record<AreaGroupId, string> = {
  mine: 'Mis áreas',
  global: 'Global',
  belts: 'Cinturones sísmicos',
  subduction: 'Zonas de subducción',
  faults: 'Fallas',
  regions: 'Regiones',
};

/**
 * Slugs por categoría, tomados del catálogo real (18 áreas del sistema).
 * Lo que no figure acá cae en "Regiones", el default razonable para un área
 * geográfica nueva.
 *
 * El criterio es el RÉGIMEN TECTÓNICO, no la geografía: "Zonas de subducción"
 * son márgenes convergentes donde una placa se hunde bajo otra, y "Fallas" son
 * transformantes, donde dos placas se deslizan lateralmente. Separarlas importa
 * porque los eventos son distintos —una subducción produce megaterremotos
 * interplaca y tsunamis; una transformante, eventos someros de desgarre— y
 * quien monitorea suele buscar uno de los dos tipos, no una región del mapa.
 *
 * Antes de que existiera 'subduction', todas estas áreas caían en "Regiones"
 * por descarte, no por decisión: era el cajón genérico. Cascadia obligó a
 * mirarlo, porque es subducción pero se busca al lado de San Andrés.
 */
const SLUG_GROUPS: Record<string, AreaGroupId> = {
  global: 'global',

  anillo_de_fuego: 'belts',
  cinturon_alpino_himalayo: 'belts',

  // Márgenes convergentes. Todas se extienden mar adentro sobre su fosa: ahí
  // ocurre el evento interplaca, que es el que importa.
  cascadia: 'subduction',
  chile: 'subduction',
  peru: 'subduction',
  mexico: 'subduction',
  centroamerica: 'subduction',
  japon: 'subduction',
  indonesia: 'subduction',
  filipinas: 'subduction',
  kamchatka_aleutianas: 'subduction',
  mediterraneo_oriental: 'subduction',

  // Transformantes: desgarre, sin placa hundiéndose.
  san_andres: 'faults',
  anatolia: 'faults',

  // Quedan en "Regiones" a propósito, por no tener un régimen único:
  //   - himalaya: colisión continental (India–Eurasia), sin subducción oceánica.
  //   - nueva_zelanda: fosa de Hikurangi al noreste PERO falla Alpina
  //     transformante al suroeste; clasificarla en uno solo sería mentir.
  //   - papua_nueva_guinea: colisión múltiple entre placas y microplacas.
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
