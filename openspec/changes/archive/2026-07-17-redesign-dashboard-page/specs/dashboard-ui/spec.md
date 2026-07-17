# Dashboard UI Specification — Rediseño visual + exploración del mapa

## Purpose

Especifica el comportamiento esperado de la página Dashboard (`dashboard/app/page.tsx`) y de los tres componentes compartidos que consume (`KPICard`, `AlertBanner`, `EventsTable`) tras aplicarles la paleta industrial/shadcn de la Fase 1, y el comportamiento del mapa del Dashboard tras extender `AdvancedSeismicMap` con límites de placas tectónicas reales, contador de eventos en área visible, y sincronización unidireccional tabla → mapa.

No existe un `openspec/specs/dashboard-ui/spec.md` previo en el repositorio (no hay specs base publicadas para el dominio de frontend/dashboard), por lo que este documento se redacta como spec completa (no delta) del dominio `dashboard-ui`, acotada al alcance de este change.

Fuera de alcance de este documento: comportamiento de `/explore` y `/analytics` como páginas (su layout no cambia en este change). Solo se especifica el comportamiento de `KPICard`, `AlertBanner` y `EventsTable` en sí mismos — el hecho de que esas dos páginas los consuman y por lo tanto hereden el nuevo estilo visualmente es un efecto colateral aceptado, no una funcionalidad de esas páginas que este documento defina.

## Requirements

### Requirement: Paleta industrial en el Dashboard y componentes compartidos

`dashboard/app/page.tsx`, `KPICard`, `AlertBanner` y `EventsTable` MUST usar los tokens CSS de severidad (`--severity-low`, `--severity-moderate`, `--severity-high`, `--severity-critical`) definidos en `globals.css` para toda codificación visual de severidad/magnitud/estado, y MUST NOT usar clases Tailwind de color hardcodeadas del sistema anterior (por ejemplo `text-gray-900 dark:text-white`, `bg-blue-50`, `border-red-200 dark:border-red-800`, o valores de retorno fijos de `getMagnitudeColor()` no derivados de tokens).

Todo valor numérico de datos sísmicos (magnitud, profundidad, coordenadas, timestamps en formato de dato, conteos) renderizado en estos cuatro componentes MUST usar la clase utilitaria `.font-data`.

Estos cuatro componentes MUST construirse sobre los componentes `ui/*` de shadcn ya disponibles en el inventario del proyecto (`Card`, `Badge`, `Tooltip`, `Skeleton`) en reemplazo de divs con clases Tailwind genéricas equivalentes, en los casos donde exista un componente shadcn aplicable (por ejemplo: `KPICard` MUST usar `Card`; indicadores de magnitud/fuente/estado sentido MUST usar `Badge`).

#### Scenario: KPICard usa tokens de severidad y font-data

- GIVEN un KPI de "Magnitud Máxima" con valor 5.8
- WHEN se renderiza `KPICard` en el Dashboard
- THEN el valor numérico `5.8` se renderiza con la clase `.font-data`
- AND el color de acento del card (borde, ícono o fondo) usa una variable `--severity-*` correspondiente a la magnitud, no una clase Tailwind de color hardcodeada
- AND el componente raíz del card usa el componente `Card` de shadcn

#### Scenario: AlertBanner mapea severidad de alerta a tokens

- GIVEN una alerta de tipo `evento_significativo` calificada como severidad alta por el backend
- WHEN se renderiza `AlertBanner` con esa alerta
- THEN el estilo visual de esa alerta usa `--severity-high` (o el token que corresponda a su nivel), no `severityStyles` con clases `red-`/`yellow-`/`blue-` hardcodeadas

#### Scenario: EventsTable no usa colores hardcodeados por magnitud

- GIVEN una fila de `EventsTable` para un evento de magnitud 6.2
- WHEN se renderiza la tabla
- THEN el color asociado a esa magnitud proviene de un token `--severity-*` (directamente o vía una función de mapeo derivada de esos tokens), no de un valor de color fijo retornado por la función de coloreo anterior
- AND los valores numéricos de la fila (magnitud, profundidad, coordenadas) usan `.font-data`

#### Scenario: No quedan clases del sistema de color anterior tras la migración

- GIVEN el código fuente de `page.tsx`, `KPICard.tsx`, `AlertBanner.tsx` y `EventsTable.tsx` después de este change
- WHEN se inspeccionan las clases Tailwind usadas para color y tipografía de datos
- THEN no aparecen clases como `text-gray-900`, `dark:text-white`, `bg-blue-50`, `border-red-200`, `dark:border-red-800`, ni literales de color asociados a `getMagnitudeColor()` fuera de una función que derive esos colores de tokens `--severity-*`

### Requirement: Límites de placas tectónicas reales en el mapa del Dashboard

El mapa del Dashboard MUST renderizar los límites de placas tectónicas usando el dataset GeoJSON PB2002 real (`fraxen/tectonicplates`) vía `L.geoJSON()`, en reemplazo del overlay `GEOLOGICAL_OVERLAYS.plateBoundaries` anterior (tile WMS de fronteras políticas mal etiquetado).

La capa de placas tectónicas SHOULD cargarse de forma asíncrona sin bloquear el render inicial del mapa ni de los eventos/ciudades.

#### Scenario: Placas tectónicas visibles por defecto en el Dashboard

- GIVEN que el usuario carga el Dashboard
- WHEN el mapa termina de inicializarse
- THEN se observan líneas de límites de placas tectónicas renderizadas sobre el mapa, provenientes del GeoJSON PB2002
- AND estas líneas son geométricamente distintas del rectángulo punteado de `region_monitorizada` y de los marcadores de eventos/ciudades

#### Scenario: Falla de carga del GeoJSON de placas no rompe el mapa

- GIVEN que la fuente del GeoJSON de placas tectónicas (CDN o asset vendorizado) no está disponible o responde con error
- WHEN el mapa del Dashboard se inicializa
- THEN el mapa igual se renderiza con capas base, eventos y ciudades visibles
- AND la ausencia de la capa de placas no genera una excepción no capturada que rompa el resto de la página

### Requirement: Contador de eventos en área visible del mapa

El Dashboard MUST mostrar un contador con el formato "N of M events in map area" (o su equivalente textual localizado), donde `M` es el total de eventos disponibles en los datos actuales del Dashboard (el mismo conjunto que alimenta `EventsTable` y los KPIs) y `N` es la cantidad de esos eventos cuya coordenada cae dentro del viewport actual del mapa (bounding box visible en pantalla, no un bbox fijo de configuración).

El contador MUST recalcularse cada vez que cambian los bounds visibles del mapa (eventos `moveend` y `zoomend` de Leaflet) y MUST recalcularse también cuando cambia el conjunto de eventos subyacente (por ejemplo, tras un refresh de datos de `useSWR`).

Cuando `N` es 0, el contador MUST mostrar explícitamente "0 of M events in map area" (no ocultar el contador ni mostrar un estado vacío distinto).

Cuando `M` es 0 (no hay eventos en los datos actuales), el contador MUST mostrar "0 of 0 events in map area", sin error ni división por cero.

#### Scenario: Contador refleja el viewport inicial

- GIVEN que el Dashboard carga con 40 eventos totales y el mapa se inicializa con un zoom/centro tal que 25 de esos eventos caen dentro del viewport visible
- WHEN el mapa termina de renderizar su estado inicial
- THEN el contador muestra "25 of 40 events in map area"

#### Scenario: Contador se actualiza al hacer pan o zoom

- GIVEN que el contador muestra "25 of 40 events in map area"
- WHEN el usuario hace pan o zoom del mapa de forma que ahora solo 10 de los 40 eventos caen dentro del nuevo viewport visible
- THEN el contador se actualiza a "10 of 40 events in map area" sin necesidad de recargar la página

#### Scenario: Contador en cero eventos visibles

- GIVEN que el usuario hace zoom o pan a una región del mapa sin eventos
- WHEN el mapa termina de re-renderizar los bounds
- THEN el contador muestra "0 of 40 events in map area" (asumiendo 40 eventos totales), visible y sin error

#### Scenario: Contador cuando no hay eventos en los datos

- GIVEN que el Dashboard recibe una respuesta con 0 eventos totales (por ejemplo, todas las fuentes externas fallaron o no hay actividad en la ventana temporal)
- WHEN el mapa se renderiza
- THEN el contador muestra "0 of 0 events in map area"

### Requirement: Sincronización unidireccional tabla → mapa

`EventsTable`, cuando se usa dentro del Dashboard, MUST exponer un callback (`onRowClick` o equivalente) que se invoca al hacer click en una fila, con el identificador del evento correspondiente.

`page.tsx` MUST mantener el identificador del evento seleccionado en estado local (`useState`, sin store global) y MUST pasarlo como prop al mapa extendido.

El mapa del Dashboard MUST, al recibir un `selectedEventId` no nulo correspondiente a un evento presente en sus datos, centrar la vista del mapa en las coordenadas de ese evento y resaltarlo visualmente (por ejemplo, cambio de estilo del marcador o apertura de su popup) de forma distinguible del resto de los eventos no seleccionados.

Esta sincronización MUST ser unidireccional: interacciones en el mapa (click o hover sobre un marcador) MUST NOT modificar la fila seleccionada o el scroll de `EventsTable`. Hover sobre filas de la tabla MUST NOT disparar ningún efecto en el mapa (solo click).

#### Scenario: Click en fila centra y resalta el evento en el mapa

- GIVEN que el Dashboard muestra `EventsTable` con al menos un evento y el mapa correspondiente
- WHEN el usuario hace click en una fila de la tabla correspondiente al evento con id `evt-123`
- THEN el mapa centra su vista en las coordenadas de `evt-123`
- AND el marcador de `evt-123` se muestra visualmente distinguido (resaltado) respecto a los demás marcadores de eventos

#### Scenario: Click en otra fila cambia la selección

- GIVEN que el evento `evt-123` está actualmente seleccionado y resaltado en el mapa
- WHEN el usuario hace click en la fila del evento `evt-456`
- THEN el mapa centra su vista en `evt-456` y lo resalta
- AND `evt-123` deja de mostrarse resaltado

#### Scenario: Interacción en el mapa no afecta la tabla

- GIVEN que ningún evento está seleccionado (o `evt-123` está seleccionado desde la tabla)
- WHEN el usuario hace click o hover directamente sobre un marcador del mapa (sin pasar por la tabla)
- THEN la fila resaltada/seleccionada en `EventsTable` no cambia como resultado de esa interacción
- AND el estado `selectedEventId` en `page.tsx` no se modifica por esa interacción de mapa

#### Scenario: Click en fila de un evento fuera del viewport actual del mapa

- GIVEN que el usuario hizo pan/zoom de forma que el evento `evt-789` no está dentro del viewport visible actual
- WHEN el usuario hace click en la fila de `evt-789` en `EventsTable`
- THEN el mapa ajusta su centro (y opcionalmente zoom) para que `evt-789` quede visible y resaltado
- AND el contador "N of M events in map area" se recalcula reflejando el nuevo viewport tras el ajuste

### Requirement: El mapa del Dashboard extiende AdvancedSeismicMap, no SeismicMapWithCities

`page.tsx` MUST renderizar el mapa del Dashboard usando `AdvancedSeismicMap` extendido (con soporte de capa de ciudades y `selectedEventId`), y MUST NOT importar ni renderizar `SeismicMapWithCities`.

`SeismicMapWithCities.tsx` MUST permanecer en el repositorio sin eliminarse físicamente en este change, y SHALL NOT tener referencias activas desde `page.tsx` tras el change.

`AdvancedSeismicMap` MUST seguir siendo utilizable sin regresiones por `/explore`, que ya lo consume hoy: las props nuevas requeridas para el caso de uso del Dashboard (capa de ciudades, `selectedEventId`, callback de bounds para el contador) MUST ser opcionales, de forma que el uso existente en `/explore` sin esas props siga comportándose como antes de este change.

#### Scenario: Dashboard usa AdvancedSeismicMap extendido

- GIVEN el código fuente de `page.tsx` tras este change
- WHEN se inspecciona qué componente de mapa importa y renderiza
- THEN el componente es `AdvancedSeismicMap` (o un wrapper directo sobre él), no `SeismicMapWithCities`

#### Scenario: SeismicMapWithCities sigue existiendo pero sin uso

- GIVEN el repositorio tras este change
- WHEN se busca el archivo `SeismicMapWithCities.tsx`
- THEN el archivo sigue presente en `dashboard/components/`
- AND ninguna importación activa en `page.tsx` referencia ese componente

#### Scenario: /explore no tiene regresiones tras extender AdvancedSeismicMap

- GIVEN que `/explore` renderiza `AdvancedSeismicMap` sin pasar las props nuevas introducidas para el Dashboard (capa de ciudades, `selectedEventId`)
- WHEN se carga `/explore` tras este change
- THEN el mapa se comporta como antes de este change (mismas capas base, mismo control de layers, sin errores en consola atribuibles a props faltantes)
