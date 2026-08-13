/**
 * Traducción client-side de los nombres de las áreas de interés.
 *
 * Los nombres viven en la base (`areas_of_interest`, seedeada en español) y el
 * backend no sabe de locales: con la UI en inglés los 18 nombres del catálogo
 * seguían saliendo en español (hallazgo del QA de i18n). La traducción se
 * resuelve acá, en el cliente, por SLUG: `areas.names.<slug>` en el
 * diccionario. Los nombres ES del diccionario son copia exacta de la base para
 * que en español no cambie ni un carácter.
 *
 * Fallback deliberado: un área sin clave (las custom del usuario, o un área
 * nueva del catálogo aún sin traducir) muestra el `name` de la API tal cual.
 * Degrada a lo que había — nunca a una clave pelada ni a un error de next-intl.
 *
 * Módulo puro sin next-intl (Decision 5 de i18n-dashboard): el componente
 * provee el traductor y acá solo se declara el contrato mínimo que se usa.
 */

import type { Area } from '@/lib/types';

/**
 * Contrato mínimo del traductor que este módulo necesita, con las claves como
 * `string` plano: el slug es dinámico (viene de la API) y las claves de t()
 * están tipadas como unión literal de es.json, así que el componente castea.
 *
 * `t.has()` es el mecanismo oficial de next-intl (presente en la 4.13.6 en
 * uso, ver use-intl/dist/types/core/createTranslator.d.ts) para sondear una
 * clave opcional sin disparar el error/warning de clave faltante que t() sí
 * emite.
 */
export interface AreaNameTranslator {
  (key: string): string;
  has(key: string): boolean;
}

/**
 * Nombre visible de un área: la traducción por slug si es del sistema y la
 * clave existe; si no, el nombre que mandó la API.
 *
 * Las áreas custom (`is_system=false`) NUNCA se traducen, ni aunque su slug
 * coincidiera con uno del catálogo: el nombre lo puso el usuario y pisárselo
 * sería renombrarle su área.
 */
export function areaDisplayName(
  area: Pick<Area, 'slug' | 'name' | 'is_system'>,
  t: AreaNameTranslator,
): string {
  if (!area.is_system) return area.name;
  const key = `names.${area.slug}`;
  return t.has(key) ? t(key) : area.name;
}

/**
 * Copia de las áreas con `name` ya localizado. Se localiza ANTES de agrupar,
 * ordenar y filtrar: así el orden alfabético (`groupAreas`) y la búsqueda
 * (`filterGroups`) operan sobre el nombre que el usuario VE, sin que
 * area-groups ni area-search se enteren de que existe la traducción.
 */
export function localizeAreaNames(areas: Area[], t: AreaNameTranslator): Area[] {
  return areas.map((area) => ({ ...area, name: areaDisplayName(area, t) }));
}
