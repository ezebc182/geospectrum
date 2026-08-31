# Observability Specification — Watchdog externo de servicios en Railway

## Purpose

Especifica el comportamiento del servicio `watchdog` (`src/services/watchdog.py`), un
proceso standalone en Railway que detecta el caso que ni Railway ni los procesos
internos pueden ver por sí mismos: un componente que sigue VIVO pero dejó de
producir algo útil ("falso vivo") — API, UI (Vercel), `seedlink_ingestor` o
`events_ingestor`. No existe un `openspec/specs/observability/spec.md` previo en
el repositorio, por lo que este documento se redacta como spec completa (no
delta) de este dominio nuevo, acotada al alcance de este change.

Este dominio es deliberadamente distinto de `backend-api`: `backend-api`
especifica contratos HTTP request/response consumidos por clientes de negocio
(dashboard, integraciones). El watchdog no expone HTTP, no atiende requests, y
su "cliente" es un canal de notificación (ntfy) y un operador humano. Es, en
cambio, el mismo tipo de proceso de infraestructura interna que
`src/services/disk_alert.py`.

## Requirements

### Requirement: Chequeo de disponibilidad del API

El watchdog MUST verificar la disponibilidad del API haciendo `GET` sobre su
endpoint de salud (`https://api.geospectrum.org/health`) con un timeout corto
configurado explícitamente. Cualquier respuesta cuyo status HTTP no sea 200, o
cualquier timeout/error de conexión, MUST considerarse "API caída".

#### Scenario: API responde 200 dentro del timeout

- GIVEN que `GET /health` responde HTTP 200 dentro del timeout configurado
- WHEN corre el ciclo de chequeo del watchdog
- THEN el componente `api` se marca como `up`
- AND no se genera ninguna notificación de caída para `api`

#### Scenario: API responde con status distinto de 200

- GIVEN que `GET /health` responde HTTP 500 (o cualquier status ≠ 200)
- WHEN corre el ciclo de chequeo del watchdog
- THEN el componente `api` se marca como `down`

#### Scenario: API no responde dentro del timeout

- GIVEN que la petición a `GET /health` no completa antes de que expire el
  timeout configurado (el servidor no responde, o la conexión cuelga)
- WHEN corre el ciclo de chequeo del watchdog
- THEN el componente `api` se marca como `down` por timeout
- AND el chequeo NO bloquea indefinidamente el resto del ciclo (el timeout
  vence y el ciclo continúa con los demás chequeos)

### Requirement: Chequeo de disponibilidad de la UI

El watchdog MUST verificar la disponibilidad del dashboard público haciendo
`GET` sobre la URL pública de Vercel configurada (`watchdog_ui_url`), sin
autenticación, con el mismo criterio de timeout y no-200 que el chequeo de API.
Este chequeo MUST ser independiente del resultado del chequeo de API: la UI
puede estar caída sin que el backend lo esté, y viceversa.

#### Scenario: UI responde 200

- GIVEN que `GET {watchdog_ui_url}` responde HTTP 200 dentro del timeout
- WHEN corre el ciclo de chequeo del watchdog
- THEN el componente `ui` se marca como `up`

#### Scenario: UI caída con API sana

- GIVEN que el API responde 200 en `/health` pero `GET {watchdog_ui_url}` da
  timeout o un status ≠ 200
- WHEN corre el ciclo de chequeo del watchdog
- THEN el componente `ui` se marca como `down`
- AND el componente `api` permanece `up`
- AND se notifica la caída de `ui` sin mencionar al `api` como afectado

### Requirement: Chequeo de seedlink_ingestor por canales mudos

El watchdog MUST determinar el estado de `seedlink_ingestor` consultando
`TimescaleColumnWriter.fetch_active_channels(minutes)` contra
`spectrogram_columns`, usando un umbral de silencio configurable
(`watchdog_seedlink_stale_after_seconds`). El componente `seedlink_ingestor`
SHALL marcarse como `down` ÚNICAMENTE cuando TODOS los canales del catálogo
activo esperado están mudos por encima del umbral. Un subconjunto de canales
mudos, mientras al menos uno siga activo dentro del umbral, MUST NOT disparar
ninguna notificación — SeedLink cae de a ratos por canal y es comportamiento
normal.

#### Scenario: Todos los canales mudos por encima del umbral

- GIVEN que el catálogo de canales activos esperados tiene N canales, y
  `fetch_active_channels(minutes)` con `minutes` derivado del umbral configurado
  devuelve una lista vacía (ningún canal actualizó `spectrogram_columns` dentro
  del umbral)
- WHEN corre el ciclo de chequeo del watchdog
- THEN el componente `seedlink_ingestor` se marca como `down`

#### Scenario: Un canal individual mudo con otros activos no alerta

- GIVEN un canal individual mudo hace 20 minutos (por encima del umbral de
  referencia de 300s, pero el resto de los canales del catálogo siguen
  actualizando `spectrogram_columns` dentro del umbral)
- WHEN corre el ciclo de chequeo del watchdog
- THEN el componente `seedlink_ingestor` se marca como `up`
- AND NO se genera ninguna notificación por el canal mudo individual

#### Scenario: Todos los canales activos, ninguno mudo

- GIVEN que todos los canales del catálogo activo tienen al menos una fila en
  `spectrogram_columns` con `endtime` dentro del umbral configurado
- WHEN corre el ciclo de chequeo del watchdog
- THEN el componente `seedlink_ingestor` se marca como `up`

#### Scenario: Catálogo de canales activos vacío no se confunde con caída total

- GIVEN que el catálogo de canales activos esperados está vacío (no hay
  ninguna estación suscripta en este momento, situación operativa distinta de
  "todas mudas")
- WHEN corre el ciclo de chequeo del watchdog
- THEN el chequeo de `seedlink_ingestor` NO produce una notificación de caída
  basada únicamente en la ausencia de canales a comparar (el diseño MUST
  distinguir explícitamente "no hay canales que chequear" de "hay canales y
  todos están mudos")

### Requirement: Chequeo de events_ingestor por heartbeat independiente de sismos

`events_ingestor.py` MUST escribir periódicamente una key de heartbeat en
Redis con TTL, en cada vuelta de su loop de proceso, de forma estrictamente
INDEPENDIENTE de si se detectó o procesó algún sismo nuevo en esa vuelta. El
watchdog MUST leer esa key para determinar el estado de `events_ingestor`: su
ausencia (TTL expirado) o una antigüedad mayor al umbral esperado indica
proceso colgado.

Esta independencia es una decisión de diseño explícita y no negociable: el
heartbeat MUST NOT derivarse, ni directa ni indirectamente, del timestamp del
último sismo detectado o de cualquier métrica de `EventStore.stats()`
equivalente. Confundir ambas señales fue identificado como un error de diseño
en la propuesta de este change y MUST evitarse.

#### Scenario: Heartbeat presente y reciente

- GIVEN que la key de heartbeat de `events_ingestor` existe en Redis con una
  antigüedad menor al umbral esperado
- WHEN corre el ciclo de chequeo del watchdog
- THEN el componente `events_ingestor` se marca como `up`

#### Scenario: Heartbeat expirado sin sismos nuevos en el período

- GIVEN una calma sísmica real prolongada (ningún evento nuevo de EMSC ni USGS
  durante varios ciclos), PERO `events_ingestor.py` sigue vivo y renovando su
  heartbeat en cada vuelta de su loop
- WHEN corre el ciclo de chequeo del watchdog
- THEN el componente `events_ingestor` se marca como `up`
- AND la ausencia de sismos nuevos NO se interpreta como caída del proceso

#### Scenario: Heartbeat expirado por proceso colgado

- GIVEN que `events_ingestor.py` dejó de renovar su heartbeat (el proceso está
  colgado pero no crasheó, por lo que Railway no lo reinicia) y la key de Redis
  expiró por TTL
- WHEN corre el ciclo de chequeo del watchdog
- THEN el componente `events_ingestor` se marca como `down`
- AND esto ocurre incluso si en ese mismo período no hubo ningún sismo nuevo
  que procesar (ausencia total de sismos no es excusa para no reportar la
  caída)

#### Scenario: Fallo al escribir el heartbeat no debe tumbar el loop principal

- GIVEN que la escritura del heartbeat en Redis falla (Redis caído o
  inalcanzable) dentro de una vuelta del loop de `events_ingestor.py`
- WHEN ocurre ese fallo
- THEN el fallo se captura en su propio `try/except` y se loguea
- AND el loop principal de ingesta de EMSC/USGS continúa sin interrupción
- AND el fallo de heartbeat NUNCA dispara el `raise RuntimeError` reservado
  para fallos reales de ingesta

### Requirement: Deduplicación de notificaciones de caída

El watchdog MUST persistir en Redis el estado actual (`up`/`down`) de cada
componente y el timestamp de la última transición, en una key por componente.
Mientras un componente permanezca en estado `down` sin haber transicionado a
`up` en un ciclo intermedio, el watchdog MUST NOT enviar una nueva notificación
de caída para ese componente en cada ciclo — solo debe notificar en el ciclo en
que se detecta la transición de `up` a `down`.

#### Scenario: Primera detección de caída notifica

- GIVEN que el componente `api` estaba `up` en el ciclo anterior
- WHEN el ciclo actual determina que `api` está `down`
- THEN se envía una notificación de caída para `api`
- AND se persiste en Redis el nuevo estado `down` con el timestamp de esta
  transición

#### Scenario: Caída sostenida no repite notificación

- GIVEN que el componente `api` ya está persistido como `down` desde un ciclo
  anterior
- WHEN el ciclo actual vuelve a determinar que `api` sigue `down`
- THEN NO se envía una nueva notificación de caída para `api`
- AND el timestamp de la transición original persistido en Redis no se
  modifica

#### Scenario: Caída simulada prolongada verificable en Redis

- GIVEN una caída simulada de un componente que se sostiene durante múltiples
  ciclos consecutivos del watchdog (al menos 3)
- WHEN se inspecciona el estado persistido en Redis para ese componente después
  de esos ciclos
- THEN el estado sigue siendo `down` con el timestamp de la primera transición,
  sin haberse actualizado en los ciclos intermedios
- AND solo existe UN evento de notificación de caída asociado a este incidente
  (no uno por ciclo)

### Requirement: Notificación de recuperación con duración de la caída

Cuando un componente que estaba persistido como `down` vuelve a responder
correctamente (`up`), el watchdog MUST enviar una notificación de recuperación
distinta de la notificación de caída, indicando cuánto tiempo estuvo caído
(calculado como la diferencia entre el timestamp de la transición a `down`
persistida y el momento de la recuperación).

#### Scenario: Recuperación después de una caída detectada

- GIVEN que el componente `seedlink_ingestor` está persistido como `down` desde
  un timestamp conocido
- WHEN un ciclo posterior determina que `seedlink_ingestor` volvió a `up`
- THEN se envía una notificación de recuperación para `seedlink_ingestor`
- AND la notificación incluye la duración de la caída (recuperación menos
  timestamp de caída)
- AND el estado persistido en Redis se actualiza a `up`

#### Scenario: Recuperación sin caída previa no notifica

- GIVEN que el componente `ui` está persistido como `up`
- WHEN el ciclo actual vuelve a determinar que `ui` sigue `up`
- THEN NO se envía ninguna notificación (ni de caída ni de recuperación)

### Requirement: Sin reintentos — alerta directa al primer fallo

Cada chequeo MUST alertar en el mismo ciclo en que detecta el fallo, sin
mecanismos de reintento ni de confirmación en ciclos subsiguientes antes de
notificar. Esta es una decisión de diseño explícita: el ciclo de 5 minutos ya
acota el ruido, y un falso positivo transitorio se resuelve con su propia
notificación de recuperación en el ciclo siguiente.

#### Scenario: Un único fallo transitorio dispara notificación inmediata

- GIVEN que un componente estaba `up` y un único ciclo de chequeo detecta que
  no responde (por cualquier causa, incluyendo un problema de red transitorio
  entre el watchdog y el componente)
- WHEN termina ese ciclo
- THEN se envía la notificación de caída correspondiente en ese mismo ciclo
- AND el watchdog NO espera un segundo ciclo de confirmación antes de notificar

#### Scenario: Blip transitorio se autorresuelve con notificación de recuperación

- GIVEN el escenario anterior, donde el fallo fue una caída de red transitoria
  y no una caída real del componente
- WHEN el siguiente ciclo (5 minutos después) encuentra al componente
  respondiendo normalmente
- THEN se envía la notificación de recuperación con una duración de caída de
  aproximadamente un ciclo
- AND no se requiere ninguna acción manual para que el sistema refleje el
  estado correcto

### Requirement: Comportamiento con Redis caído

Si Redis no está disponible al momento de leer o persistir el estado de
transición, el watchdog MUST notificar el resultado del chequeo igual que si
Redis estuviera disponible, aceptando la pérdida de capacidad de
deduplicación como consecuencia conocida. El watchdog MUST NOT quedarse mudo
(sin notificar nada) solo porque no puede leer o escribir su estado en Redis.

#### Scenario: Redis caído durante una caída real de un componente

- GIVEN que Redis no responde (caído o inalcanzable) y el componente `api` está
  realmente caído
- WHEN corre el ciclo de chequeo del watchdog
- THEN se envía la notificación de caída de `api` en este ciclo
- AND si Redis sigue caído en el ciclo siguiente y `api` sigue caído, se acepta
  que la notificación se repita (no hay forma de deduplicar sin poder leer el
  estado previo)

#### Scenario: Fallo de Redis no impide notificar otros chequeos

- GIVEN que Redis está caído y el chequeo de `events_ingestor` depende de leer
  una key de Redis (heartbeat)
- WHEN corre el ciclo de chequeo del watchdog
- THEN el chequeo de `events_ingestor` se marca como indeterminado o `down` (no
  se puede confirmar el heartbeat) y se notifica ese resultado
- AND los chequeos de `api` y `ui`, que no dependen de leer el heartbeat de
  Redis, se ejecutan y notifican con normalidad
- AND el fallo al leer/escribir en Redis se loguea sin abortar el ciclo
  completo

### Requirement: Aislamiento de fallos entre chequeos

Cada uno de los 4 chequeos (API, UI, seedlink_ingestor, events_ingestor) MUST
ejecutarse envuelto en su propio manejo de errores, de forma que una excepción
no controlada en un chequeo MUST NOT impedir que se ejecuten los chequeos
restantes del mismo ciclo.

#### Scenario: Excepción no controlada en un chequeo no aborta el ciclo

- GIVEN que el chequeo de `seedlink_ingestor` lanza una excepción no anticipada
  (por ejemplo, un error de conexión a TimescaleDB distinto de "sin datos")
- WHEN corre el ciclo de chequeo del watchdog
- THEN los chequeos de `api`, `ui` y `events_ingestor` se ejecutan y notifican
  con normalidad
- AND la excepción del chequeo de `seedlink_ingestor` se loguea
- AND el proceso del watchdog no termina ni deja de despertar en el próximo
  ciclo programado

### Requirement: Independencia del watchdog respecto a los componentes vigilados

El proceso del watchdog MUST correr aislado de los procesos que vigila, de
forma que la caída de cualquiera de ellos (API, UI, seedlink_ingestor,
events_ingestor) o de Redis MUST NOT afectar la capacidad del watchdog de
seguir ejecutando su ciclo y notificando.

#### Scenario: Caída total del API no detiene al watchdog

- GIVEN que el proceso del API dejó de responder por completo
- WHEN corre el ciclo de chequeo del watchdog
- THEN el watchdog completa el ciclo, marca `api` como `down`, notifica, y
  programa su próximo ciclo con normalidad
- AND ningún otro componente vigilado (`ui`, `seedlink_ingestor`,
  `events_ingestor`) deja de reportarse por la caída del API
</content>
