/**
 * Filtro de texto del selector de áreas.
 *
 * Con 18 áreas del sistema repartidas en seis grupos, el desplegable ya no
 * entra de una en pantalla: hay que scrollear para encontrar una. Escribir dos
 * letras es más rápido que barrer la lista con la vista.
 *
 * Vive separado de `AreaSelector` porque es lógica pura —entra texto, sale una
 * lista— y así se testea sin montar el componente ni simular tipeo.
 *
 * No usa Select2 ni ninguna librería de combobox: el desplegable ya es un
 * `DropdownMenu` de Radix (ver el comentario en AreaSelector.tsx sobre por qué
 * se reemplazó al `<select>` nativo), y sumar una dependencia para filtrar un
 * array de 18 elementos no se justifica.
 */

import type { AreaGroup } from '@/lib/area-groups';

/**
 * Normaliza para comparar: sin acentos, minúsculas y sin espacios sobrantes.
 *
 * Es lo que hace que buscar "japon" encuentre "Japón" y "mexico" encuentre
 * "México". En un catálogo con acentos en la mitad de los nombres, exigir que
 * el usuario los tipee es garantizar que el buscador parezca roto.
 *
 * NFD separa cada letra acentuada en letra + diacrítico, y el rango
 * U+0300–U+036F (Combining Diacritical Marks) borra el diacrítico suelto. Va
 * como escape y no como carácter literal para que el patrón siga siendo legible
 * y no dependa de la codificación con que se abra el archivo.
 */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * ¿El área matchea la consulta?
 *
 * Busca en el nombre Y en el slug. El slug importa porque es lo que aparece en
 * la URL y en la base: quien tipea "san_andres" o "cascadia" espera encontrarla
 * aunque el nombre visible diga "Falla de San Andrés (California)".
 *
 * Cada término se busca por separado y todos deben aparecer, en cualquier
 * orden. Así "fosa chile" encuentra "Chile y fosa Perú-Chile", que un `includes`
 * de la frase completa se perdería.
 */
function matches(haystack: string, terms: string[]): boolean {
  return terms.every((term) => haystack.includes(term));
}

/**
 * Filtra los grupos por el texto de búsqueda, preservando su orden.
 *
 * Devuelve los grupos ya armados por `groupAreas()` y no una lista plana: la
 * agrupación sigue siendo útil mientras el filtro no sea muy específico, y
 * mantenerla evita que la lista salte de agrupada a plana al escribir la
 * primera letra.
 *
 * Los grupos que quedan sin áreas se omiten, mismo criterio que `groupAreas()`:
 * una etiqueta sin nada abajo es sólo ruido.
 */
export function filterGroups(groups: AreaGroup[], query: string): AreaGroup[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return groups;

  return groups.flatMap((group) => {
    const areas = group.areas.filter((area) =>
      matches(normalize(`${area.name} ${area.slug}`), terms),
    );
    if (areas.length === 0) return [];
    return [{ ...group, areas }];
  });
}

/** Cantidad total de áreas en los grupos, para decidir si mostrar el vacío. */
export function countAreas(groups: AreaGroup[]): number {
  return groups.reduce((total, group) => total + group.areas.length, 0);
}
