# Proposal: Redesign Explorer Page

## Intent

El Dashboard (`app/page.tsx`) ya fue migrado (change archivado `2026-07-17-redesign-dashboard-page`) a la paleta industrial/tokens semánticos de shadcn (`--severity-*`, componentes `Card`/`Badge`/`Skeleton`, sin Tailwind hardcodeado). Como parte colateral de ese change, los componentes compartidos `FilterPanel`, `EventsTable` y `AdvancedSeismicMap` — todos usados también por `/explore` — ya heredaron el nuevo estilo visual. El bug puntual `bg-seismic-600` del toggle Mapa/Lista en `explore/page.tsx` ya fue corregido en un commit separado, fuera de este flujo SDD.

Pero el contenedor propio de `dashboard/app/explore/page.tsx` — el título (`<h1>`), el panel de "Controles y Estadísticas" (contador de resultados + toggle Mapa/Lista), el botón "Exportar CSV", el banner de error, los empty states de mapa/lista, y el banner de "Fuentes de Datos Utilizadas" — sigue con Tailwind hardcodeado del sistema visual anterior: `text-gray-900 dark:text-white`, `bg-white dark:bg-gray-900 border-2 border-gray-200 dark:border-gray-700`, `bg-green-600 hover:bg-green-700` (botón exportar), `bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800` (error), `bg-gray-50 dark:bg-gray-900 border-dashed border-gray-300 dark:border-gray-700` (empty states), `bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800` (fuentes de datos).

El resultado es una página con dos sistemas visuales conviviendo: los hijos (filtros, tabla, mapa) ya en paleta industrial, y el contenedor que los envuelve todavía en el estilo viejo. Este change cierra esa brecha, siguiendo el orden ya acordado con el usuario (Dashboard → Explorador → Análisis) y replicando el mismo alcance puramente visual que tuvo el change del Dashboard: sin cambios de estructura, UX ni features nuevas.

## Scope

### In Scope

- Migrar `dashboard/app/explore/page.tsx` a tokens semánticos shadcn (`bg-card`, `border-border`, `text-foreground`, `text-muted-foreground`, `bg-primary`/`text-primary-foreground`, `bg-destructive`/variantes de severidad según corresponda), eliminando toda clase Tailwind hardcodeada del sistema anterior (`text-gray-*`, `bg-gray-*`, `border-gray-*`, `dark:*` manual, `bg-green-*`, `bg-red-*`, `bg-blue-*`).
- Migrar el título y subtítulo del header de la página al mismo patrón tipográfico/color usado en `app/page.tsx` (Dashboard).
- Migrar el panel de "Controles y Estadísticas" (contador de eventos + rango de magnitud) a `Card` de shadcn.
- Migrar el botón "Exportar CSV" a `Button` de shadcn (variante apropiada), sin cambiar su comportamiento (`exportToCSV`) ni su condición de visibilidad (`eventos.length > 0`).
- Migrar el banner de error a tokens de severidad/`destructive`, consistente con el tratamiento de errores ya usado en el Dashboard (`AlertBanner` o equivalente si aplica).
- Migrar los dos empty states (mapa sin resultados, lista sin resultados) a tokens semánticos, manteniendo el mismo texto y misma lógica condicional.
- Migrar el banner informativo "Fuentes de Datos Utilizadas" (chips de fuente) a tokens semánticos, sin cambiar su contenido ni condición de aparición.
- Verificar que el toggle Mapa/Lista (ya corregido previamente a `bg-primary`/tokens) queda consistente con el resto de la página tras esta migración, sin reintroducir regresiones.

### Out of Scope

- Cualquier cambio de estructura, layout o UX de `/explore` (grid de filtros + contenido, orden de secciones, comportamiento de búsqueda).
- Features nuevas: paginador, agrupación de eventos, checkbox "solo visibles en mapa", selectores de sort/format sobre la tabla — son decisiones de producto pendientes de definir con el usuario, fuera de este change.
- Migración de `globe.gl` 3D o cualquiera de las 6 iniciativas grandes del documento de arquitectura v2.
- Cambios en `FilterPanel`, `EventsTable` o `AdvancedSeismicMap` más allá de lo estrictamente necesario para que `page.tsx` los envuelva de forma consistente — estos componentes ya están migrados desde el change del Dashboard; si se detecta una regresión puntual en ellos durante este change, se corrige acotadamente, pero no se re-diseñan.
- Rediseño de `/analytics` (siguiente en el orden acordado, change futuro separado).
- Cualquier cambio de backend o de contrato de API (`seismicAPI.searchEvents`, tipos de `SeismicEvent`).

## Approach

Enfoque mínimo (equivalente en alcance al Dashboard, pero sin componente de funcionalidad nueva porque acá no aplica): migración visual pura de un solo archivo (`page.tsx`), reemplazando clases Tailwind hardcodeadas por tokens semánticos y componentes shadcn ya establecidos como patrón en `app/page.tsx` y en los componentes hijos (`EventsTable.tsx` como referencia directa de "cómo se ve migrado").

Pasos técnicos principales:
1. Reemplazar el bloque de header (`<h1>`/`<p>`) por el mismo patrón tipográfico usado en el Dashboard.
2. Migrar el panel de "Controles y Estadísticas" a `Card` de shadcn, conservando el layout flex interno (contador, rango de magnitud, toggle, botón exportar).
3. Reemplazar el botón "Exportar CSV" por `Button` de shadcn, sin tocar `exportToCSV()`.
4. Migrar el banner de error a tokens de severidad/`destructive` (evaluar reutilizar `AlertBanner` si su firma lo permite sin cambios; si no encaja, migrar el div manual a tokens directamente, sin forzar el reuso del componente).
5. Migrar los dos empty states (mapa y lista) a tokens semánticos, sin duplicar innecesariamente el markup entre ambos si se puede extraer un sub-componente local simple (opcional, a criterio de implementación, no bloqueante).
6. Migrar el banner de "Fuentes de Datos Utilizadas" a tokens semánticos.
7. Verificación manual de `/explore` completa (búsqueda con resultados, sin resultados, error, toggle Mapa/Lista, exportar CSV) para confirmar que no hay regresión funcional.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `dashboard/app/explore/page.tsx` | Modified | Migración visual completa del contenedor: header, panel de controles/estadísticas, botón exportar, banner de error, empty states, banner de fuentes de datos. Sin cambios de lógica de negocio (`handleSearch`, `exportToCSV`, estado de filtros) |
| `dashboard/components/AlertBanner.tsx` | Possibly Reused | Se evalúa reutilizar para el banner de error de `/explore` si su firma actual (ya migrada en el change del Dashboard) encaja sin forzar cambios; si no encaja, no se modifica este componente, se migra el div local en `page.tsx` directamente |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Migración visual introduce una regresión funcional sutil (ej. condición de visibilidad del botón exportar, o del banner de error) | Low | Los cambios son solo de clases/markup envolvente, no de lógica de estado ni de las funciones `handleSearch`/`exportToCSV`; verificación manual de los 4 estados de la página (con resultados, sin resultados, error, exportando) antes de cerrar el change |
| Reutilizar `AlertBanner` para el error de `/explore` fuerza una firma de props que no encaja bien con el caso de uso simple (mensaje de string plano) | Low | Si no encaja limpio, se migra el div de error directamente a tokens sin forzar el reuso del componente; no es un requisito duro del change |
| Inconsistencia visual residual si se pasa por alto alguna clase hardcodeada (ej. dentro de un template literal condicional) | Medium | Verificación final con `rg` sobre `page.tsx` buscando patrones `text-gray-|bg-gray-|border-gray-|bg-green-|bg-red-|bg-blue-|dark:` remanentes, igual que se hizo como evidencia de cierre en el change del Dashboard |

## Rollback Plan

Todo el cambio está contenido en un único archivo (`dashboard/app/explore/page.tsx`), con una posible modificación acotada de `AlertBanner.tsx` solo si se decide reutilizarlo. No hay cambios de backend, de esquema de datos ni de contrato de API. Rollback vía `git revert` del commit del change: revertir deja `/explore` en su estado visual actual (mezcla de sistemas), funcionalmente idéntico en ambos casos porque no se toca lógica de negocio.

## Dependencies

- Ninguna dependencia externa nueva. Reutiliza componentes shadcn (`Card`, `Button`, y evaluar `AlertBanner`) ya introducidos en el change del Dashboard.

## Success Criteria

- [ ] `dashboard/app/explore/page.tsx` no contiene clases Tailwind hardcodeadas del sistema anterior. Evidencia esperada: `rg -n "text-gray-|bg-gray-|border-gray-|bg-green-|bg-red-|bg-blue-|dark:" dashboard/app/explore/page.tsx` sin coincidencias (fuera de comentarios).
- [ ] El header, panel de controles/estadísticas, botón exportar, banner de error, empty states y banner de fuentes de datos usan tokens semánticos (`bg-card`, `border-border`, `text-foreground`, `text-muted-foreground`, etc.) y/o componentes shadcn (`Card`, `Button`), consistentes con `app/page.tsx` y `EventsTable.tsx`.
- [ ] `exportToCSV()` y `handleSearch()` no cambiaron de comportamiento: verificación manual de exportar CSV con resultados presentes, y de búsqueda con/sin resultados.
- [ ] El banner de error se muestra correctamente ante una búsqueda sin resultados o un error de red, con el nuevo estilo.
- [ ] El toggle Mapa/Lista sigue funcionando y visualmente es consistente con el resto de la página migrada (sin regresión sobre la corrección previa de `bg-seismic-600`).
- [ ] `npm run build` (comando de verify del proyecto, `dashboard/`) pasa sin errores.
