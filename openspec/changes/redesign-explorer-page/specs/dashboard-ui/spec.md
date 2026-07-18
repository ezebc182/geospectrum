# Delta for Dashboard UI — Explorer Page Container

## ADDED Requirements

### Requirement: Paleta industrial en el contenedor de la página Explorador

`dashboard/app/explore/page.tsx` MUST usar tokens semánticos de shadcn (`bg-card`, `border-border`, `text-foreground`, `text-muted-foreground`, `bg-primary`/`text-primary-foreground`, y variantes `--severity-*`/`destructive` donde corresponda) para todo el markup propio del contenedor de la página (header, panel de "Controles y Estadísticas", botón "Exportar CSV", banner de error, empty states de mapa y lista, banner de "Fuentes de Datos Utilizadas"), y MUST NOT usar clases Tailwind hardcodeadas del sistema visual anterior (`text-gray-*`, `bg-gray-*`, `border-gray-*`, `dark:*` manual, `bg-green-*`, `bg-red-*`, `bg-blue-*`) en ese mismo markup.

Esta migración MUST ser puramente visual: el estado del componente (`filters`, `eventos`, `isSearching`, `error`, `view`), la lógica de `handleSearch()` y `exportToCSV()`, y toda condición de renderizado (`eventos.length > 0`, `error &&`, `view === 'map'`/`'list'`) MUST permanecer sin cambios de comportamiento tras la migración.

Los componentes hijos (`FilterPanel`, `AdvancedSeismicMap`, `EventsTable`) MUST seguir recibiendo las mismas props que reciben hoy — esta migración no MUST modificar sus interfaces ni su forma de consumo desde `page.tsx`.

#### Scenario: Ninguna clase del sistema anterior sobrevive en el archivo

- GIVEN el código fuente de `dashboard/app/explore/page.tsx` después de este change
- WHEN se inspeccionan las clases Tailwind usadas en el markup del contenedor (header, panel de controles, botón exportar, banner de error, empty states, banner de fuentes)
- THEN no aparecen clases `text-gray-*`, `bg-gray-*`, `border-gray-*`, `dark:*` manual, `bg-green-*`, `bg-red-*` ni `bg-blue-*`
- AND una búsqueda `rg -n "text-gray-|bg-gray-|border-gray-|bg-green-|bg-red-|bg-blue-|dark:" dashboard/app/explore/page.tsx` no produce coincidencias fuera de comentarios

#### Scenario: El comportamiento de búsqueda y exportación no cambia

- GIVEN que el usuario ejecuta una búsqueda que retorna eventos
- WHEN se compara el comportamiento de `handleSearch()` y `exportToCSV()` antes y después de la migración visual
- THEN ambas funciones producen el mismo resultado (mismos eventos cargados en estado, mismo archivo CSV generado con las mismas columnas) sin cambios de lógica

### Requirement: Header de la página Explorador consistente con el Dashboard

El header de `/explore` (título `<h1>` y subtítulo `<p>`) MUST usar el mismo patrón tipográfico y de color que el header del Dashboard (`dashboard/app/page.tsx`): el título MUST usar `text-3xl font-bold text-foreground` (o clases equivalentes basadas en los mismos tokens) y el subtítulo MUST usar `text-muted-foreground`, sin clases `text-gray-900 dark:text-white` ni `text-gray-600 dark:text-gray-400`.

El texto del título ("Explorador de Eventos Sísmicos") y del subtítulo MUST permanecer sin cambios de contenido.

#### Scenario: Header visualmente alineado con el Dashboard

- GIVEN que el usuario navega a `/explore`
- WHEN se renderiza el header de la página
- THEN el título usa `text-foreground` y el subtítulo usa `text-muted-foreground`, con el mismo texto que antes de la migración

#### Scenario: Header legible en dark mode

- GIVEN que el usuario tiene el modo oscuro activo (clase `dark` en el árbol de la aplicación)
- WHEN se renderiza el header de `/explore`
- THEN el título y el subtítulo se renderizan con contraste adecuado usando los valores de `--foreground` y `--muted-foreground` definidos para dark mode en `globals.css`, sin depender de un modificador `dark:` explícito en `page.tsx`

### Requirement: Panel de Controles y Estadísticas migrado a Card de shadcn

El panel de "Controles y Estadísticas" (contador de resultados, rango de magnitud, toggle Mapa/Lista, botón Exportar CSV) MUST estar construido sobre el componente `Card` de shadcn (u otro contenedor basado en tokens `bg-card`/`border-border` equivalente), en reemplazo del `div` con clases `bg-white dark:bg-gray-900 border-2 border-gray-200 dark:border-gray-700`.

El layout flex interno del panel (contador a la izquierda, controles de vista y exportación a la derecha, wrap en pantallas angostas) MUST permanecer igual al comportamiento actual.

El contador de resultados y el rango de magnitud (`M{min} - M{max}`) MUST seguir mostrando el mismo texto y los mismos valores calculados a partir de `eventos`, solo con clases de color migradas a tokens semánticos.

#### Scenario: Contador de resultados con eventos presentes

- GIVEN que una búsqueda retornó 12 eventos con magnitudes entre 2.5 y 5.8
- WHEN se renderiza el panel de Controles y Estadísticas
- THEN se muestra "Resultados: 12 eventos" y "M2.5 - M5.8" usando tokens semánticos (`text-foreground`/`text-muted-foreground`) sin clases `text-gray-*`

#### Scenario: Rango de magnitud oculto sin eventos

- GIVEN que `eventos.length` es 0 (sin búsqueda realizada aún, o búsqueda sin resultados)
- WHEN se renderiza el panel de Controles y Estadísticas
- THEN se muestra "Resultados: 0 eventos" con el mismo token de estilo
- AND el rango de magnitud (`M{min} - M{max}`) no se renderiza, igual que en el comportamiento actual

### Requirement: Botón Exportar CSV migrado a Button de shadcn

El botón "Exportar CSV" MUST usar el componente `Button` de shadcn con una variante apropiada (por ejemplo `default` o una variante de éxito/positiva si existe en el inventario del proyecto), en reemplazo del `button` HTML con clases `bg-green-600 hover:bg-green-700`.

La condición de visibilidad del botón (`eventos.length > 0`) MUST permanecer sin cambios: el botón MUST NOT renderizarse cuando no hay eventos cargados.

El `onClick` del botón MUST seguir invocando `exportToCSV()` sin cambios de comportamiento ni de las columnas/formato del CSV generado.

#### Scenario: Botón Exportar visible y funcional con eventos

- GIVEN que hay al menos 1 evento cargado en `eventos`
- WHEN se renderiza el panel de Controles y Estadísticas
- THEN el botón "Exportar CSV" se muestra usando el componente `Button` de shadcn
- AND al hacer click, se invoca `exportToCSV()` generando un archivo CSV con las mismas columnas que antes de la migración (ID, Fecha UTC, Latitud, Longitud, Profundidad, Magnitud, Tipo Mag, Lugar, Sentido, Revisado, Fuentes)

#### Scenario: Botón Exportar ausente sin eventos

- GIVEN que `eventos.length` es 0
- WHEN se renderiza el panel de Controles y Estadísticas
- THEN el botón "Exportar CSV" no se renderiza en el DOM

### Requirement: Banner de error migrado a tokens de severidad

El banner de error de `/explore` (mostrado cuando `error` no es `null`) MUST usar tokens de severidad/`destructive` para su color de fondo, borde y texto, en reemplazo de `bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800` y `text-red-800 dark:text-red-200`.

Si `AlertBanner` puede reutilizarse sin forzar cambios en su firma de props (que espera `alertas: Alert[]`, no un mensaje de string plano), la migración MAY reutilizarlo envolviendo el mensaje de error en la estructura `Alert` esperada. Si eso requiere forzar el tipo o adaptar `AlertBanner`, la migración MUST en su lugar migrar el `div` de error local a tokens semánticos directamente (`border-destructive`, `bg-destructive/10`, `text-destructive` o equivalentes `--severity-critical`), sin modificar `AlertBanner.tsx`.

El texto del mensaje de error MUST seguir siendo exactamente el valor de la variable `error` (mensaje de "No se encontraron eventos..." o el mensaje de excepción capturado), sin alterar su contenido.

La condición de renderizado (`error &&`) MUST permanecer sin cambios.

#### Scenario: Banner de error visible tras búsqueda sin resultados

- GIVEN que el usuario ejecuta una búsqueda que retorna 0 eventos
- WHEN se completa `handleSearch()`
- THEN `error` se establece a "No se encontraron eventos con los filtros especificados"
- AND el banner de error se renderiza con tokens de severidad/destructive mostrando ese texto exacto

#### Scenario: Banner de error visible tras fallo de red

- GIVEN que `seismicAPI.searchEvents` lanza una excepción (por ejemplo, timeout de red)
- WHEN `handleSearch()` captura el error
- THEN el banner de error se renderiza con tokens de severidad/destructive mostrando el mensaje de la excepción
- AND `eventos` no se modifica con resultados parciales o inválidos

#### Scenario: Banner de error ausente sin error activo

- GIVEN que `error` es `null` (estado inicial, o tras una búsqueda exitosa con resultados)
- WHEN se renderiza la página
- THEN el banner de error no aparece en el DOM

### Requirement: Empty states de mapa y lista migrados a tokens semánticos

Los dos empty states (mostrados cuando `eventos.length === 0` en la vista de mapa y en la vista de lista respectivamente) MUST usar tokens semánticos (`border-border`/`border-dashed`, `bg-muted` o `bg-card`, `text-muted-foreground`) en reemplazo de `bg-gray-50 dark:bg-gray-900 border-2 border-dashed border-gray-300 dark:border-gray-700` y sus textos internos `text-gray-900 dark:text-white`/`text-gray-600 dark:text-gray-400`.

Ambos empty states MUST conservar su texto actual ("No hay resultados" y "Ajusta los filtros y haz clic en 'Buscar Eventos' para ver resultados") y su ícono distintivo (`Search` para la vista de mapa, `List` para la vista de lista).

La condición de aparición de cada empty state (ligada a `view === 'map'`/`'list'` combinado con `eventos.length === 0`) MUST permanecer sin cambios.

#### Scenario: Empty state de mapa sin resultados

- GIVEN que `view` es `'map'` y `eventos.length` es 0
- WHEN se renderiza la sección de contenido principal
- THEN se muestra el empty state con ícono `Search`, título "No hay resultados" y el texto de ayuda, usando tokens semánticos
- AND `AdvancedSeismicMap` no se renderiza

#### Scenario: Empty state de lista sin resultados

- GIVEN que `view` es `'list'` y `eventos.length` es 0
- WHEN se renderiza la sección de contenido principal
- THEN se muestra el empty state con ícono `List`, título "No hay resultados" y el texto de ayuda, usando tokens semánticos
- AND `EventsTable` no se renderiza

#### Scenario: Empty state legible en dark mode

- GIVEN que el modo oscuro está activo
- WHEN se renderiza cualquiera de los dos empty states
- THEN el borde punteado, el fondo y el texto mantienen contraste adecuado usando los valores dark de los tokens semánticos (`--border`, `--muted`/`--card`, `--muted-foreground`), sin depender de clases `dark:` explícitas en `page.tsx`

### Requirement: Banner de Fuentes de Datos Utilizadas migrado a tokens semánticos

El banner informativo "Fuentes de Datos Utilizadas" (visible cuando `eventos.length > 0`) MUST usar tokens semánticos para su contenedor, título, chips de fuente y texto de ayuda, en reemplazo de `bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800`, `text-blue-900 dark:text-blue-100`, `bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-100`, y `text-blue-700 dark:text-blue-200`.

Los chips de fuente (uno por cada valor en `filters.sources`, en mayúsculas) MUST seguir renderizándose con el mismo texto y la misma cantidad de chips, MAY usar el componente `Badge` de shadcn en reemplazo del `span` con clases hardcodeadas.

El texto de ayuda ("Los eventos pueden estar deduplicados si aparecen en múltiples fuentes") MUST permanecer sin cambios de contenido.

La condición de aparición del banner (`eventos.length > 0`) MUST permanecer sin cambios.

#### Scenario: Banner de fuentes visible con eventos y múltiples fuentes activas

- GIVEN que `eventos.length` es mayor a 0 y `filters.sources` es `['usgs', 'emsc', 'inpres']`
- WHEN se renderiza la sección de contenido principal
- THEN se muestra el banner "Fuentes de Datos Utilizadas" con tres chips: "USGS", "EMSC", "INPRES", usando tokens semánticos
- AND se muestra el texto de ayuda sobre deduplicación

#### Scenario: Banner de fuentes ausente sin eventos

- GIVEN que `eventos.length` es 0
- WHEN se renderiza la sección de contenido principal
- THEN el banner "Fuentes de Datos Utilizadas" no se renderiza en el DOM

### Requirement: Consistencia del toggle Mapa/Lista tras la migración del contenedor

El toggle Mapa/Lista (ya corregido previamente a usar `bg-primary`/`text-primary-foreground` en el estado activo) MUST permanecer visualmente consistente con el resto del panel de Controles y Estadísticas tras esta migración: su contenedor (`border-2 border-gray-300 dark:border-gray-600`) y el estado inactivo (`bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800`) MUST migrarse a tokens semánticos equivalentes (`border-border`, `bg-card`/`bg-background`, `text-muted-foreground`, `hover:bg-muted` o equivalente).

El comportamiento del toggle (cambiar `view` entre `'map'` y `'list'` al hacer click) MUST permanecer sin cambios, y esta migración MUST NOT reintroducir la clase `bg-seismic-600` corregida previamente.

#### Scenario: Toggle Mapa/Lista con Mapa activo

- GIVEN que `view` es `'map'`
- WHEN se renderiza el toggle
- THEN el botón "Mapa" usa `bg-primary text-primary-foreground` y el botón "Lista" usa el estilo inactivo migrado a tokens semánticos

#### Scenario: Cambiar de vista al hacer click en el toggle

- GIVEN que `view` es `'map'`
- WHEN el usuario hace click en el botón "Lista"
- THEN `view` cambia a `'list'`, el botón "Lista" pasa a usar `bg-primary text-primary-foreground`, y el botón "Mapa" pasa al estilo inactivo
- AND no aparece en ningún momento la clase `bg-seismic-600` en el DOM

#### Scenario: No hay regresión del bug bg-seismic-600 tras la migración completa

- GIVEN el código fuente de `dashboard/app/explore/page.tsx` después de este change
- WHEN se inspecciona el markup del toggle Mapa/Lista
- THEN no aparece la clase `bg-seismic-600` en ninguna rama condicional del toggle
