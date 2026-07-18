# Design: Redesign Explorer Page

## Technical Approach

Migración visual pura, un solo archivo: `dashboard/app/explore/page.tsx`. No se toca estado (`filters`, `eventos`, `isSearching`, `error`, `view`), ni `handleSearch()`, ni `exportToCSV()`, ni las props que reciben `FilterPanel`, `AdvancedSeismicMap` o `EventsTable`. El trabajo es 100% de clases Tailwind: reemplazar el vocabulario hardcodeado del sistema anterior (`text-gray-*`, `bg-gray-*`, `border-gray-*`, `dark:*` manual, `bg-green-*`, `bg-red-*`, `bg-blue-*`) por tokens semánticos y componentes shadcn, replicando exactamente los patrones ya validados en `app/page.tsx` (Dashboard, ya migrado) y en `EventsTable.tsx`/`FilterPanel.tsx` (hijos ya migrados).

Cada uno de los 8 requirements del spec mapea a una sección de markup dentro del mismo `return` de `ExplorePage`. No hay nuevos componentes ni archivos nuevos — se confirma el alcance de "single file" del proposal tras leer el archivo completo (258 líneas): todo el markup del contenedor vive inline en el `return`, no hay sub-render-functions que ameriten extracción obligatoria.

## Architecture Decisions

### Decision: Banner de error — migrar el div local a tokens de severidad, NO forzar `AlertBanner`

**Choice**: Mantener el banner de error de `/explore` como un `div` local dentro de `page.tsx`, migrado a tokens `--severity-critical` (`border-severity-critical/30 bg-severity-critical/10 text-severity-critical`), sin importar ni modificar `AlertBanner.tsx`.

**Alternativas consideradas**:
1. Envolver el `string` de `error` en un `Alert` sintético (`{ tipo: 'evento_significativo', descripcion: error, eventos_relacionados: [] }`) para poder pasarlo a `<AlertBanner alertas={[alertaSintetica]} />`.
2. Modificar la firma de `AlertBanner` para aceptar una unión `alertas: Alert[] | string`.
3. (Elegida) Migrar el `div` local directamente a tokens, sin tocar `AlertBanner`.

**Rationale**: Leí `dashboard/components/AlertBanner.tsx` completo — su contrato (`alertas: Alert[]`) modela alertas de dominio sísmico reales, con `tipo` (`evento_significativo` | `enjambre` | `actividad_sentida`), `descripcion`, `eventos_relacionados`, e iconografía/severidad derivada de `getAlertSeverity(alerta.tipo)`. El `error` de `/explore` es un string de estado de búsqueda ("No se encontraron eventos...", o un mensaje de excepción de red) — no es una alerta sísmica y no tiene `tipo` real ni `eventos_relacionados`. Forzarlo a `Alert` (alternativa 1) requeriría inventar un `tipo` falso solo para satisfacer el tipo, lo cual es un code smell: el discriminante de la unión dejaría de significar lo que dice significar. La alternativa 2 ensancha la interfaz de un componente compartido para un único caso de uso marginal, violando el principio de que el contrato de un componente reusable debe reflejar su dominio, no acomodarse al primer caso raro que aparece.
Además, tengo evidencia directa de que el propio Dashboard (`app/page.tsx:55-66`) enfrenta el mismo problema — un error de carga (`error || !data` de `useSWR`) que tampoco es un `Alert[]` — y lo resuelve exactamente así: un `div` local con `border-severity-critical/30 bg-severity-critical/10 text-severity-critical`, sin tocar `AlertBanner`. Es el precedente directo del propio autor del sistema de diseño migrado. Seguir ese patrón exacto en `/explore` es la opción más consistente con la arquitectura ya establecida y la de menor riesgo (cero cambios a un componente compartido usado también en el Dashboard).

### Decision: Panel de "Controles y Estadísticas" → `Card` de shadcn (solo el contenedor raíz)

**Choice**: Reemplazar el `div` raíz (`bg-white dark:bg-gray-900 border-2 border-gray-200 dark:border-gray-700 rounded-lg p-4`) por `<Card className="p-4">...</Card>` de `components/ui/card.tsx`, conservando el `div` interno `flex items-center justify-between flex-wrap gap-4` tal cual (no usar `CardHeader`/`CardContent`, que imponen `px-4`/grid propios pensados para un patrón título+descripción que este panel no tiene).

**Alternativas consideradas**:
1. Usar `Card` + `CardContent` con el layout flex dentro de `CardContent`.
2. Usar `Card` "a secas" con `className="p-4"` y meter el flex interno directamente como children.
3. No usar `Card`, migrar el `div` a `bg-card border-border` a mano.

**Rationale**: El spec exige explícitamente `Card` de shadcn (Requirement "Panel de Controles y Estadísticas migrado a Card de shadcn"), así que la opción 3 queda descartada. Entre 1 y 2, `CardContent` aplica `px-4` pero no `py-4` (ese padding vertical lo pone `Card` en su nivel raíz vía `py-4`), y `CardHeader` no aplica al caso porque no hay separación título/acción — este panel es un solo bloque flex horizontal. Usar `Card` con `className="p-4"` directo (opción 2) es el que menos reestructura el layout interno actual y es fiel al requirement de "el layout flex interno... MUST permanecer igual".

### Decision: Botón Exportar CSV → `Button variant="default"`, sin variante de éxito dedicada

**Choice**: `<Button onClick={exportToCSV}><Download className="h-4 w-4" />Exportar CSV</Button>` usando la variante `default` (la única que da un botón "sólido" con fondo lleno en el inventario actual de `buttonVariants`).

**Alternativas consideradas**:
1. Variante `default` (`bg-primary text-primary-foreground`).
2. Inventar una variante `success`/`positive` nueva en `button.tsx`.

**Rationale**: Leí `components/ui/button.tsx` completo — el inventario de variantes es `default | outline | secondary | ghost | destructive | link`. No existe variante de "éxito" verde, y el proposal la menciona solo como posibilidad ("por ejemplo default o una variante de éxito/positiva si existe en el inventario del proyecto"). Como no existe, y este change es explícitamente de alcance visual puro sin tocar el sistema de diseño compartido (`button.tsx` no está en Affected Areas del proposal), la opción correcta es `default`. Inventar una variante nueva sería expandir el design system fuera del scope declarado de este change.

### Decision: Empty states — sin extraer sub-componente

**Choice**: Migrar los dos bloques de empty state (mapa y lista) in-place, cada uno como su propio JSX inline dentro de la rama condicional correspondiente, sin extraer un componente `EmptyState` compartido.

**Alternativas consideradas**:
1. Extraer `<EmptyState icon={...} />` local (definido en el mismo archivo o en `components/`).
2. Dejar los dos bloques duplicados in-place, solo migrando clases.

**Rationale**: El proposal deja esto explícitamente "opcional, a criterio de implementación, no bloqueante". Los dos bloques difieren únicamente en el ícono (`Search` vs `List`) — toda otra clase, texto y estructura es idéntica. Extraer un componente agrega una capa de indirección para ahorrar ~6 líneas duplicadas en un archivo que de por sí ya tiene bastante JSX condicional; no hay un tercer consumidor que justifique la abstracción (regla de las 3 repeticiones), y el archivo ya usa el patrón de "vista de mapa" / "vista de lista" como bloques paralelos independientes en el código actual. Mantener el duplicado in-place es más legible en este caso concreto y evita tocar más superficie de la estrictamente necesaria, alineado con el Rollback Plan del proposal ("un único archivo").

## Data Flow

No aplica — este change no introduce ni modifica flujo de datos. `handleSearch()`, `exportToCSV()` y las props hacia `FilterPanel`/`AdvancedSeismicMap`/`EventsTable` permanecen bit-a-bit idénticas. El único "flujo" relevante es el mapeo 1:1 de clase-vieja → clase-nueva, documentado en la tabla de abajo.

    filters/eventos/error/view (useState, sin cambios)
              │
              ▼
    ExplorePage render (mismo JSX tree, nuevas clases)
              │
      ┌───────┼────────────────┬─────────────────┐
      ▼       ▼                ▼                 ▼
  FilterPanel  Card(controles)  error?div(severity) view==map?AdvancedSeismicMap:EventsTable

## File Changes

| File | Action | Description |
|------|--------|--------------|
| `dashboard/app/explore/page.tsx` | Modify | Migración visual completa: header, `Card` de controles/estadísticas, `Button` de exportar, banner de error a tokens `--severity-critical`, dos empty states a tokens semánticos, banner de fuentes a tokens + `Badge`, toggle Mapa/Lista a tokens (contenedor y estado inactivo). Import nuevo: `Card` desde `@/components/ui/card`, `Button` desde `@/components/ui/button`, `Badge` desde `@/components/ui/badge` (para los chips de fuente, MAY según spec). Sin cambios de lógica, estado ni props hacia hijos. |

No hay archivos nuevos. No se modifica `AlertBanner.tsx` (decisión arriba). No se modifican `FilterPanel.tsx`, `EventsTable.tsx` ni `AdvancedSeismicMap.tsx` — ya migrados en el change anterior del Dashboard, y el proposal los excluye explícitamente de scope salvo regresión puntual (no detectada durante esta lectura).

## Interfaces / Contracts

Sin cambios de interfaces. `SeismicFilters`, `SeismicEvent`, props de `FilterPanel`/`AdvancedSeismicMap`/`EventsTable` permanecen idénticas. Mapeo de clases (referencia de implementación, no una interfaz de tipos):

| Elemento | Clase anterior | Clase migrada |
|----------|-----------------|----------------|
| Título `<h1>` | `text-gray-900 dark:text-white` | `text-foreground` (patrón de `app/page.tsx:74`) |
| Subtítulo `<p>` | `text-gray-600 dark:text-gray-400` | `text-muted-foreground` |
| Panel controles (contenedor) | `bg-white dark:bg-gray-900 border-2 border-gray-200 dark:border-gray-700 rounded-lg p-4` | `<Card className="p-4">` |
| Texto contador/label | `text-gray-600 dark:text-gray-400` | `text-muted-foreground` |
| Texto contador/valor | `text-gray-900 dark:text-white` | `text-foreground` |
| Toggle: contenedor | `border-2 border-gray-300 dark:border-gray-600` | `border-2 border-border` |
| Toggle: separador interno | `border-l-2 border-gray-300 dark:border-gray-600` | `border-l-2 border-border` |
| Toggle: estado inactivo | `bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800` | `bg-background text-muted-foreground hover:bg-muted` |
| Toggle: estado activo | `bg-primary text-primary-foreground` (ya migrado, sin cambios) | idéntico |
| Botón Exportar | `bg-green-600 text-white hover:bg-green-700` (`<button>`) | `<Button>` (variant `default`) |
| Banner error (contenedor) | `bg-red-50 dark:bg-red-900/20 border-2 border-red-200 dark:border-red-800` | `border-2 border-severity-critical/30 bg-severity-critical/10` (patrón de `app/page.tsx:57`) |
| Banner error (texto) | `text-red-800 dark:text-red-200` | `text-severity-critical` |
| Empty state (contenedor) | `bg-gray-50 dark:bg-gray-900 border-2 border-dashed border-gray-300 dark:border-gray-700` | `border-2 border-dashed border-border bg-muted` |
| Empty state (ícono) | `text-gray-400` | `text-muted-foreground` |
| Empty state (título) | `text-gray-900 dark:text-white` | `text-foreground` |
| Empty state (texto ayuda) | `text-gray-600 dark:text-gray-400` | `text-muted-foreground` |
| Banner fuentes (contenedor) | `bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-200 dark:border-blue-800` | `border-2 border-severity-low/30 bg-severity-low/10` (mismo patrón `--severity-*` que error, en tono informativo) |
| Banner fuentes (título) | `text-blue-900 dark:text-blue-100` | `text-foreground` |
| Chips de fuente | `bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-100` (`<span>`) | `<Badge variant="secondary">` |
| Banner fuentes (texto ayuda) | `text-blue-700 dark:text-blue-200` | `text-muted-foreground` |

Nota sobre el banner de fuentes: el spec pide "tokens semánticos" sin exigir `--severity-*` específicamente (a diferencia del banner de error, que sí exige "tokens de severidad"). Se usa `--severity-low` por ser informativo (no es un contenedor de error ni de éxito), consistente con el uso de `severity-low` como nivel "info" en `AlertBanner.tsx:21` (`info: 'border-severity-low bg-severity-low/10 text-foreground'`) — mismo vocabulario de tokens que el resto del sistema ya migrado, en vez de introducir un color nuevo fuera de la paleta `--severity-*`/`shadcn` establecida.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|--------------|----------|
| Unit/Component | Ninguno nuevo | No aplica: cambio 100% de clases CSS/markup, sin lógica nueva ni condiciones nuevas. `EventsTable.test.tsx` y `map-bounds.test.ts` cubren lógica de componentes hijos que no se tocan en este change — no requieren actualización porque sus props/contratos no cambian. |
| Manual (verify) | Los 4 estados de la página: búsqueda con resultados, sin resultados, error de red, exportar CSV con eventos presentes; toggle Mapa/Lista en ambos sentidos; dark mode en header, panel, banners y empty states | Igual que el criterio de "Success Criteria" del proposal: correr `npm run build` (verify del proyecto) + navegación manual de `/explore` cubriendo los 4 estados listados en el proposal |
| Static check | Ausencia de clases del sistema anterior | `rg -n "text-gray-|bg-gray-|border-gray-|bg-green-|bg-red-|bg-blue-|dark:" dashboard/app/explore/page.tsx` sin coincidencias fuera de comentarios (criterio de cierre ya definido en el proposal) |

Decisión explícita: no se agregan tests de Vitest nuevos. Se evaluó testear "el banner de error se renderiza cuando `error` no es null" al estilo de `EventsTable.test.tsx`, pero se descarta porque (a) la condición `error &&` ya existe hoy sin test y este change no la modifica ni la crea, (b) no hay lógica nueva que testear — el `if` es el mismo, solo cambian las clases del JSX que retorna, y (c) el propio `EventsTable.test.tsx`/`map-bounds.test.ts` del proyecto testean lógica de transformación de datos (bounds, filas), no clases CSS de contenedores — no hay precedente de testear presencia de clases Tailwind en este proyecto, y agregarlo acá rompería esa convención sin aportar cobertura real (un snapshot de clases es frágil y no detecta regresiones funcionales).

## Migration / Rollout

No migration required. Cambio de un solo archivo, sin flags, sin cambios de datos ni de API. Deploy estándar del `dashboard/` Next.js app.

## Open Questions

None — la decisión abierta del spec (banner de error: `AlertBanner` vs. div local) queda resuelta arriba con evidencia directa del propio `app/page.tsx`.
