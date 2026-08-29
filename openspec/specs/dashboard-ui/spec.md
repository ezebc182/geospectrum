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

## Detalle de estación — Wave view, progresividad y picking

Sección incorporada por el change `analiticas-profesionales-senal` (archivado
2026-08-28). Cubre el detalle de estación
(`dashboard/app/(app)/stations/[channel]/page.tsx`): habilitación de las
pestañas `wave` y `rsam`, la regla de progresividad por interacción, la UI de
picking de un solo nivel y las convenciones de idioma/regresión que rigieron
todo el change.

### Requirement: Pestañas wave y rsam habilitadas

Las pestañas `wave` y `rsam` del detalle de estación MUST estar habilitadas
(`enabled: true`) y navegables.

(Previamente: ambas estaban declaradas con `enabled: false`, visibles como
"próximamente" y sin contenido.)

Cada pestaña MUST habilitarse en la fase que entrega su contenido: `wave` en la
Fase 2 y `rsam` en la Fase 4. Una pestaña MUST NOT quedar habilitada apuntando a
una vista vacía.

#### Scenario: La pestaña wave abre el wave view

- GIVEN el detalle de la estación `AK.FIRE..BHZ`
- WHEN el usuario selecciona la pestaña `wave`
- THEN se renderiza el wave view con la ventana activa
- AND la pestaña NO muestra el rótulo de "próximamente"

#### Scenario: La pestaña rsam abre la serie temporal

- GIVEN el detalle de una estación
- WHEN el usuario selecciona la pestaña `rsam`
- THEN se renderiza el gráfico de la serie RSAM sobre la ventana activa

#### Scenario: Un clic en el helicorder abre esa ventana en el wave view

- GIVEN el helicorder de `AK.FIRE..BHZ` mostrando 24 h
- WHEN el usuario hace clic sobre un evento visible
- THEN la vista cambia al wave view
- AND la ventana cargada es la que devuelve la traducción del clic (ver
  `signal-analysis`, requirement de traducción clic→ventana)
- AND se emitió una petición al backend con `start`/`end` absolutos

#### Scenario: El cursor indica que el helicorder es clickeable sólo si lo es

- GIVEN un `HelicorderCanvas` renderizado SIN el callback de selección de ventana
- WHEN el puntero se ubica sobre el área de trazas
- THEN el cursor NO cambia a `pointer`
- AND un clic no dispara navegación

### Requirement: Progresividad por interacción

Las herramientas avanzadas de análisis MUST aparecer en función de la
interacción previa del usuario, no de un toggle básico/avanzado ni de un
"mostrar todo" permanente.

La regla de aparición MUST vivir en una función pura testeable
(`dashboard/lib/progressive-disclosure.ts`), NO dispersa en condicionales de JSX.

Los umbrales MUST ser constantes nombradas y explícitas. Los niveles son:

| Nivel | Se desbloquea cuando | Habilita |
|-------|----------------------|----------|
| 0 — inicial | siempre | onda + espectrograma |
| 1 — espectro | el usuario abrió al menos `WINDOWS_FOR_SPECTRUM` ventanas | espectro 1D |
| 2 — picking | el usuario ya usó el espectro 1D al menos una vez | picking P/S/coda y export |

El estado de progreso MUST persistir entre visitas, siguiendo el mismo patrón de
`dashboard/lib/helicorder-settings.ts`: clamps, fallback a defaults y tolerancia
a JSON corrupto.

#### Scenario: Un usuario nuevo no ve el picking

- GIVEN un usuario sin estado de progreso guardado
- WHEN abre el detalle de una estación por primera vez
- THEN ve la onda y el espectrograma
- AND NO ve el control de espectro 1D
- AND NO ve los controles de picking

#### Scenario: El espectro 1D aparece al alcanzar el umbral de ventanas

- GIVEN un usuario con `WINDOWS_FOR_SPECTRUM - 1` ventanas abiertas registradas
- WHEN abre una ventana más
- THEN el espectro 1D pasa a estar visible
- AND el picking sigue oculto

#### Scenario: Justo por debajo del umbral el espectro sigue oculto

- GIVEN un usuario con exactamente `WINDOWS_FOR_SPECTRUM - 1` ventanas abiertas
- WHEN se evalúa la regla de aparición
- THEN el espectro 1D NO está visible

#### Scenario: El picking aparece después de usar el espectro

- GIVEN un usuario que ya tiene el espectro 1D desbloqueado y NO lo usó nunca
- WHEN se evalúa la regla
- THEN el picking está oculto
- WHEN el usuario usa el espectro 1D una vez
- THEN el picking pasa a estar visible

#### Scenario: El progreso sobrevive a recargar

- GIVEN un usuario que ya desbloqueó el espectro 1D
- WHEN recarga la página
- THEN el espectro 1D sigue visible sin tener que volver a abrir ventanas

#### Scenario: JSON corrupto en el almacenamiento no rompe la vista

- GIVEN un estado de progreso guardado con contenido no parseable (por ejemplo
  `"{no-es-json"`)
- WHEN se carga el detalle de la estación
- THEN la vista renderiza sin lanzar
- AND el estado usado es el de defaults (nivel 0)

#### Scenario: Valores fuera de rango se recortan

- GIVEN un estado guardado con un contador de ventanas negativo o absurdamente
  grande
- WHEN se carga
- THEN el valor se recorta al rango válido
- AND la regla de aparición se evalúa sobre el valor recortado

#### Scenario: Escape hatch para revelar todo manualmente

- GIVEN un usuario en nivel 0
- WHEN activa el control explícito de "mostrar todas las herramientas"
- THEN todas las herramientas avanzadas quedan visibles inmediatamente, sin
  esperar a cumplir umbrales
- AND esa elección persiste entre visitas

#### Scenario: Subir los umbrales esconde las herramientas sin desplegar código

- GIVEN un usuario que ya tenía el picking visible
- WHEN los umbrales se elevan por encima de su progreso registrado
- THEN el picking deja de estar visible
- AND el estado de progreso del usuario NO se borra

### Requirement: UI de picking de un solo nivel

La UI de picking MUST ofrecer acciones directas de un solo nivel: marcar P,
marcar S, marcar coda. El sistema MUST NOT replicar los menús anidados de tres
niveles de SWARM (fase → onset → polaridad → peso 0-4).

#### Scenario: Marcar P es una sola acción

- GIVEN el wave view con el picking visible
- WHEN el usuario marca una fase P en un instante
- THEN el pick queda registrado sin pasar por ningún submenú
- AND se muestra en el wave view en la posición del instante marcado

#### Scenario: Con P y S se muestra la distancia

- GIVEN un pick P y un pick S marcados en la misma traza
- WHEN se muestran las mediciones
- THEN aparece la distancia calculada según el requirement de distancia S-P del
  dominio `signal-analysis`
- AND el valor mostrado corresponde al del cálculo, no a un placeholder

#### Scenario: Con S antes que P no se muestra distancia

- GIVEN un pick S marcado en un instante ANTERIOR al pick P
- WHEN se muestran las mediciones
- THEN NO se muestra un valor de distancia
- AND se indica que el orden de fases es inválido
- AND la vista NO muestra `NaN` ni un número negativo

#### Scenario: Con coda se muestra la magnitud

- GIVEN un pick P y un pick de fin de coda
- WHEN se muestran las mediciones
- THEN aparece la magnitud de coda según el requirement correspondiente
- AND una duración de coda de 100 s se muestra como `2.87`

#### Scenario: Borrar un pick actualiza las mediciones

- GIVEN P, S y coda marcados con sus mediciones visibles
- WHEN el usuario borra el pick S
- THEN la distancia S-P desaparece de las mediciones
- AND la magnitud de coda sigue mostrándose

### Requirement: Paridad de claves i18n ES/EN (detalle de estación)

Toda cadena de interfaz nueva introducida por el change `analiticas-profesionales-senal`
MUST existir en `dashboard/messages/es.json` Y en `dashboard/messages/en.json`.

#### Scenario: Cero claves huérfanas en cualquier dirección

- GIVEN los archivos `es.json` y `en.json` después de este change
- WHEN se comparan sus conjuntos de claves (recursivamente, por path completo)
- THEN el conjunto de claves de `es.json` es exactamente igual al de `en.json`
- AND no hay ninguna clave presente en uno y ausente en el otro

#### Scenario: Ninguna cadena visible queda hardcodeada

- GIVEN las vistas nuevas (wave view, espectro 1D, serie RSAM, picking, export)
- WHEN se inspecciona su código
- THEN todos los textos visibles provienen del sistema de traducciones
- AND no hay literales de interfaz en español ni en inglés incrustados en el JSX
