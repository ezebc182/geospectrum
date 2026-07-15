# Backend API Specification — Unificación de fuente de datos sísmicos

## Purpose

Especifica el comportamiento esperado de los endpoints de monitoreo sísmico (`/report`, `/events`, `/alerts`) y del servicio interno de fusión que deben usar, después de unificar la fuente de datos con `/events/search` (USGS + EMSC + INPRES). También especifica el comportamiento del nuevo servicio de fusión y el criterio de aceptación obligatorio para validar la no-conmutatividad de `merge_all_sources` antes de mergear a producción.

No existe un `openspec/specs/backend-api/spec.md` previo en el repositorio (no hay specs base publicadas), por lo que este documento se redacta como spec completa (no delta) del dominio `backend-api`, acotada al alcance de este change.

## Requirements

### Requirement: Fusión de tres fuentes en /report

El endpoint `GET /report` MUST fusionar eventos de USGS, EMSC e INPRES usando el servicio interno de fusión único (ver Requirement "Servicio interno de fusión"), en lugar de fusionar solo USGS+INPRES como en el comportamiento anterior.

#### Scenario: /report incluye eventos exclusivos de EMSC

- GIVEN que EMSC reporta un evento sísmico dentro de la ventana temporal configurada (`settings.window_minutes`) que ni USGS ni INPRES reportan
- WHEN se hace `GET /report`
- THEN el evento de EMSC aparece en `eventos` de la respuesta
- AND el campo `fuentes` de ese evento incluye `"EMSC"`

#### Scenario: /report preserva estructura de MonitorReport

- GIVEN cualquier estado válido de las tres fuentes externas (con o sin eventos)
- WHEN se hace `GET /report`
- THEN la respuesta HTTP es 200
- AND el body contiene `timestamp_utc_generacion`, `region_monitorizada`, `data_source_errors`, `kpis`, `alertas`, `eventos`
- AND `region_monitorizada` proviene de `settings.bbox`, sin cambios respecto al comportamiento actual

#### Scenario: /report con fuente EMSC caída no rompe la respuesta

- GIVEN que el fetch a EMSC falla (timeout o error HTTP)
- WHEN se hace `GET /report`
- THEN la respuesta HTTP sigue siendo 200
- AND `data_source_errors` incluye un identificador de error asociado a EMSC
- AND `eventos` contiene la fusión de las fuentes que sí respondieron (USGS + INPRES en el peor caso)

### Requirement: Fusión de tres fuentes en /events

El endpoint `GET /events` MUST devolver `list[SeismicEvent]` fusionando USGS + EMSC + INPRES a través del mismo servicio interno de fusión usado por `/report`, en lugar de `merge_events(usgs, inpres)`.

#### Scenario: /events refleja el mismo pool de fuentes que /report

- GIVEN el mismo estado de fuentes externas y la misma ventana temporal
- WHEN se hace `GET /events` y luego `GET /report`
- THEN el conjunto de eventos devuelto por `/events` es idéntico (mismos IDs y mismas fusiones) al campo `eventos` devuelto por `/report`

#### Scenario: /events mantiene contrato de respuesta

- GIVEN cualquier estado válido de las fuentes
- WHEN se hace `GET /events`
- THEN la respuesta HTTP es 200
- AND el body es una lista JSON de objetos `SeismicEvent` (sin envoltorio adicional), sin cambios de shape respecto al comportamiento actual

### Requirement: Fusión de tres fuentes en /alerts

El endpoint `GET /alerts` MUST calcular alertas (`compute_kpis_and_alerts`) sobre el resultado de fusionar USGS + EMSC + INPRES a través del mismo servicio interno de fusión, en lugar de calcularlas solo sobre USGS+INPRES.

#### Scenario: /alerts detecta alertas que dependen de EMSC

- GIVEN que solo al incorporar eventos de EMSC se cumple el criterio de enjambre (≥3 eventos M≥3 en ≤15min y ≤20km) o el de evento significativo (M≥5, profundidad <70km)
- WHEN se hace `GET /alerts`
- THEN la alerta correspondiente (`enjambre` o `evento_significativo`) aparece en la respuesta
- AND antes de este change (fusión USGS+INPRES only) esa alerta no se habría generado

#### Scenario: /alerts mantiene contrato de respuesta

- GIVEN cualquier estado válido de las fuentes
- WHEN se hace `GET /alerts`
- THEN la respuesta HTTP es 200
- AND el body es una lista JSON de objetos `Alert`, sin cambios de shape respecto al comportamiento actual

### Requirement: Servicio interno de fusión único

El sistema MUST exponer una única función/servicio interno reutilizable (candidato: `src/services/report_service.py`) que reciba `sources: list[str]` y `window_minutes: int`, ejecute `_fetch_parallel(sources)` → `merge_all_sources(...)` → `compute_kpis_and_alerts(...)`, arme `region_monitorizada` desde `settings.bbox`, y sea la única ruta de fusión invocada por `/report`, `/events` y `/alerts`.

Los endpoints `/report`, `/events` y `/alerts` MUST invocar este servicio con `sources=["usgs", "emsc", "inpres"]` y SHALL NOT duplicar lógica de fetch, merge o cálculo de KPIs/alertas fuera de él.

`merge_events` (fusión de 2 fuentes) y `compute_kpis_and_alerts` MUST permanecer sin modificaciones de comportamiento — el servicio nuevo los reusa, no los reemplaza.

#### Scenario: Un único punto de fusión para los tres endpoints

- GIVEN el código fuente de `/report`, `/events` y `/alerts` después del change
- WHEN se inspecciona qué función invoca cada endpoint para fusionar fuentes
- THEN los tres endpoints llaman a la misma función del servicio interno (mismo símbolo, mismo módulo)
- AND ningún endpoint construye su propia secuencia `_fetch_parallel` + `merge_all_sources` + `compute_kpis_and_alerts` de forma independiente

#### Scenario: El servicio interno es invocable con subconjuntos de fuentes

- GIVEN `sources=["usgs", "inpres"]` (sin EMSC)
- WHEN se invoca el servicio interno con ese parámetro
- THEN el resultado fusiona únicamente USGS e INPRES, sin fetch a EMSC
- AND esto permite reutilizar el servicio para casos que no requieran las 3 fuentes (p.ej. tests, o filtros explícitos de `/events/search` si el diseño así lo determina)

### Requirement: Validación de no-conmutatividad de merge_all_sources

El sistema MUST validar explícitamente, antes de mergear este change a producción, que `merge_all_sources` no es conmutativa respecto al orden de las listas de fuentes que recibe, y MUST documentar el comportamiento observado como parte del proceso de verificación de este change.

Esta validación existe porque `merge_all_sources` reduce las N listas de fuentes de a pares con `merge_events`, cuyo criterio de match es "primer candidato greedy que cumple Δt≤120s y distancia≤30km" (ver `src/services/merge_service.py:62-100`). Esto implica que el resultado de la fusión — qué eventos se consideran duplicados y cuál de sus atributos "gana" en `_fuse_two_events` — puede depender del orden en que se pasan las listas de fuentes.

#### Scenario: Caso de prueba obligatorio — orden de fuentes altera el conteo de eventos fusionados

- GIVEN tres fixtures de eventos representativos (USGS, EMSC, INPRES) que incluyen al menos un caso de solapamiento triple: un mismo evento físico reportado por las 3 fuentes con timestamps y coordenadas dentro del umbral de match (Δt≤120s, distancia≤30km) entre cada par
- WHEN se invoca `merge_all_sources(usgs, emsc, inpres)` y por separado `merge_all_sources(emsc, usgs, inpres)` (incluyendo, como mínimo, las 6 permutaciones de orden de las 3 listas o una muestra que cubra al menos 3 órdenes distintos)
- THEN se documenta, para cada orden probado, el `len(resultado)` y el conjunto de `id`s resultante
- AND si existe al menos un par de órdenes cuyo resultado difiere (en cantidad de eventos fusionados, en atributos ganadores tras `_fuse_two_events`, o en cuáles alertas dispara `compute_kpis_and_alerts` sobre ese resultado), el comportamiento se considera CONFIRMADO como no-conmutativo y se documenta explícitamente en el reporte de verificación del change (`verify-report.md` o equivalente)
- AND se registra explícitamente qué orden de fuentes usarán `/report`, `/events` y `/alerts` en producción (`["usgs", "emsc", "inpres"]` según la propuesta), como decisión consciente y no accidental

#### Scenario: Caso de prueba obligatorio — impacto en alertas derivadas del orden de fusión

- GIVEN el mismo set de fixtures del escenario anterior, construido de forma que el resultado de la fusión en al menos un orden alcance el umbral de enjambre (≥3 eventos M≥3 en ≤15min y ≤20km tras fusión) y en otro orden no lo alcance (por ejemplo, porque un evento fusionado "pierde" magnitud o desaparece como entidad separada según qué atributos gana en `_fuse_two_events`)
- WHEN se ejecuta `compute_kpis_and_alerts` sobre el resultado de `merge_all_sources` para cada orden probado
- THEN se documenta si la alerta `enjambre` (o `evento_significativo` / `actividad_sentida`) aparece o no según el orden
- AND este resultado queda registrado como evidencia del riesgo "Alta — riesgo estructural del algoritmo existente" identificado en la propuesta, junto con la decisión tomada (aceptar el orden fijo `usgs, emsc, inpres` como comportamiento definido, o corregir `merge_all_sources`/`merge_events` — esta corrección queda fuera de alcance de este change salvo que la validación revele una regresión inaceptable)

#### Scenario: Ausencia de solapamiento no dispara falsos positivos de no-conmutatividad

- GIVEN fixtures donde ningún par de eventos entre fuentes distintas cumple el criterio de match (Δt≤120s, distancia≤30km)
- WHEN se invoca `merge_all_sources` con distintos órdenes de las mismas listas
- THEN el `len(resultado)` es igual en todos los órdenes (suma total de eventos de las 3 fuentes)
- AND el conjunto de `id`s resultante es igual en todos los órdenes (aunque el orden interno de la lista pueda variar)

### Requirement: Consistencia entre Dashboard, Monitoreo en Vivo y Explorador

Los eventos mostrados por el Dashboard (`dashboard/app/page.tsx`) y Monitoreo en Vivo (`dashboard/app/live/page.tsx`), que consumen `/report`, MUST corresponder al mismo conjunto de fuentes (USGS+EMSC+INPRES) y a la misma ventana temporal que el Explorador (`dashboard/app/explore/page.tsx`), que consume `/events/search`.

#### Scenario: Mismo conjunto de eventos ante misma ventana y mismas fuentes

- GIVEN una ventana temporal fija y el mismo estado de las 3 fuentes externas
- WHEN se comparan los eventos devueltos por `/report` (`eventos`) contra los eventos devueltos por `/events/search?sources=usgs,emsc,inpres` (sin filtros adicionales de magnitud/profundidad/geo)
- THEN el conjunto de eventos (por `id` y por fusión resultante) es equivalente entre ambas respuestas

#### Scenario: Default de sources en Explorador alineado con backend

- GIVEN el estado inicial de `dashboard/app/explore/page.tsx` sin interacción del usuario
- WHEN el componente monta y dispara su primera consulta a `/events/search`
- THEN el parámetro `sources` enviado por defecto es `usgs,emsc,inpres` (ya no `usgs,emsc` solamente)

### Requirement: Migración deliberada de tests existentes

Los tests en `tests/integration/test_api.py` que actualmente asumen o toleran el comportamiento de "2 fuentes only" en `/report`, `/events` y `/alerts` MUST actualizarse deliberadamente para reflejar el nuevo comportamiento de 3 fuentes, y MUST seguir pasando en verde tras la migración.

#### Scenario: test_report_endpoint_structure sigue validando estructura, ahora con 3 fuentes posibles

- GIVEN el test `test_report_endpoint_structure` (líneas 48-66 de `tests/integration/test_api.py`)
- WHEN se ejecuta después de este change
- THEN el test sigue verificando la presencia de `timestamp_utc_generacion`, `region_monitorizada`, `kpis`, `alertas`, `eventos`
- AND se agrega o adapta un test que mockea explícitamente `fetch_emsc_events` para `/report` y verifica que sus eventos aparecen en la respuesta (análogo a `test_search_events_uses_merge_all_sources` pero apuntando a `/report`)

#### Scenario: Nuevo test cubre paridad /report vs /events vs /alerts

- GIVEN fixtures mockeadas de USGS, EMSC e INPRES compartidas entre `/report`, `/events` y `/alerts`
- WHEN se invocan los tres endpoints con el mismo mock de fuentes activo
- THEN los `id`s de eventos en `/report.eventos` coinciden con los devueltos por `/events`
- AND las alertas devueltas por `/report.alertas` coinciden con las devueltas por `/alerts`

## Out of Scope (heredado de la propuesta, no se especifica aquí)

- Contrato REST definitivo entre `/report` y `/events/search` (endpoint nuevo vs. reuso) — **TBD en design.md**. Este documento NO asume una resolución; los requirements de `/report` arriba describen el comportamiento de fusión de datos, no el contrato de forma final si `design.md` decide introducir un endpoint nuevo.
- Cambios al algoritmo de matching de `merge_events` (Δt≤120s, distancia≤30km, greedy first-match) — se especifica su comportamiento actual como base de la validación de no-conmutatividad, pero no se modifica en este change.
- Rediseño visual/UX del Dashboard.
- Nuevas fuentes de datos sísmicos.
