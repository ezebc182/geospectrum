# Live Station Catalog Specification — Mega Wall de Estaciones del Cuaderno

## Purpose

Especifica el comportamiento del catálogo ampliado de estaciones en vivo, la
ingesta multi-servidor SeedLink que lo alimenta (`rtserve.earthscope.org` +
`geofon.gfz-potsdam.de`) y los walls temáticos por región que se arman sobre
ese catálogo. No existe un `openspec/specs/live-station-catalog/spec.md`
previo en el repositorio — es un dominio nuevo, redactado como spec completa
(no delta), acotado al alcance de `mega-wall-estaciones-cuaderno`.

Este dominio es deliberadamente distinto de `observability`: `observability`
especifica cómo el watchdog detecta procesos "falsos vivos"; este dominio
especifica el contenido del catálogo, el aislamiento entre los dos procesos de
ingesta que lo sirven, y las reglas con que `WallManager` compone walls
temáticos a partir de él. También es distinto de `signal-analysis`
(`backend-api`), que no se toca en este change.

## Requirements

### Requirement: Verificación de disponibilidad antes de sumar una estación al catálogo

Ninguna estación MUST sumarse al catálogo de código (`LIVE_CANDIDATES_BY_CITY`
o su estructura equivalente) sin haber sido verificada primero contra datos
vivos reales del servidor SeedLink que la sirve (`rtserve.earthscope.org` o
`geofon.gfz-potsdam.de`), mediante el mismo protocolo de verificación
(`INFO STREAMS`) usado para las 12 de 19 entradas "(cualquiera)" ya
confirmadas. El sistema MUST NOT incluir estaciones aproximadas o inventadas
como sustituto de una estación del cuaderno que no pudo verificarse.

#### Scenario: Estación verificada con datos vivos se suma al catálogo

- GIVEN una estación del cuaderno cuyo código de red.estación responde con
  streams activos en `INFO STREAMS` contra el servidor correspondiente
- WHEN se construye el catálogo de código para este change
- THEN la estación queda incluida en `LIVE_CANDIDATES_BY_CITY` (o estructura
  equivalente) bajo su país/región correspondiente

#### Scenario: Estación del cuaderno sin datos vivos verificables se documenta como pendiente, no se inventa

- GIVEN una estación del cuaderno cuyo código no responde con streams activos
  en `INFO STREAMS` contra ningún servidor conocido
- WHEN se construye el catálogo de código para este change
- THEN la estación MUST NOT incluirse en `LIVE_CANDIDATES_BY_CITY`
- AND queda documentada explícitamente como pendiente fuera de scope, sin una
  estación distinta puesta en su lugar como aproximación

#### Scenario: País sin servidor SeedLink público conocido queda documentado, no bloquea el resto

- GIVEN uno de los 5 países sin servidor SeedLink público conocido (UAE,
  Afganistán, Java específico, Venezuela, Guatemala)
- WHEN se construye el catálogo de código para este change
- THEN ese país MUST NOT tener ninguna estación en el catálogo
- AND queda documentado explícitamente como pendiente futuro fuera de scope
- AND su ausencia MUST NOT impedir que el resto de los países confirmados se
  incluyan en el catálogo

### Requirement: Aislamiento de fallos entre los dos servidores SeedLink

El proceso de ingesta contra `geofon.gfz-potsdam.de` MUST ejecutarse aislado
del proceso de ingesta contra `rtserve.earthscope.org`, de forma que la caída,
saturación o degradación de cualquiera de los dos servidores, o de su proceso
de ingesta correspondiente, MUST NOT afectar la capacidad del otro proceso de
seguir ingiriendo datos con normalidad. Ninguno de los dos procesos MUST
depender en tiempo de ejecución del otro para funcionar.

#### Scenario: Caída del proceso GEOFON no afecta la ingesta de rtserve

- GIVEN que el proceso de ingesta contra `geofon.gfz-potsdam.de` deja de
  responder o se detiene por completo
- WHEN se observa el proceso de ingesta contra `rtserve.earthscope.org`
  durante y después de esa caída
- THEN los canales servidos por `rtserve.earthscope.org` (incluidos los 74 ya
  existentes en producción) siguen actualizando `spectrogram_columns` sin
  gaps ni reconexiones adicionales atribuibles a la caída de GEOFON

#### Scenario: Saturación de rtserve.earthscope.org no afecta la ingesta de GEOFON

- GIVEN que `rtserve.earthscope.org` se satura o degrada su servicio bajo el
  volumen del catálogo ampliado
- WHEN se observa el proceso de ingesta contra `geofon.gfz-potsdam.de` durante
  esa degradación
- THEN el proceso GEOFON sigue ingiriendo datos de sus canales con normalidad,
  sin verse afectado por la saturación del otro servidor

#### Scenario: Apagar el proceso GEOFON no interrumpe el streaming existente

- GIVEN el servicio de ingesta GEOFON corriendo en su propio proceso aislado
- WHEN ese servicio se apaga por completo (detención deliberada o crash)
- THEN el streaming de los 74 canales servidos por `rtserve.earthscope.org`
  continúa sin interrupción ni degradación medible

### Requirement: Prueba de humo antes de cargar el catálogo completo

El sistema MUST cargar primero un subconjunto acotado de 20 a 30 estaciones
nuevas (mezcla de ambos servidores) a un wall de prueba, y ese subconjunto
MUST observarse en producción antes de cargar el resto del catálogo
confirmado. El criterio de avance al catálogo completo MUST incluir, como
mínimo: ausencia de gaps o reconexiones nuevas en `rtserve.earthscope.org`
sobre los 74 canales ya existentes, y estabilidad de las conexiones WebSocket
del wall de prueba en el navegador.

#### Scenario: Prueba de humo sin degradación habilita el catálogo completo

- GIVEN un wall de prueba con 20-30 estaciones nuevas cargado en producción
- WHEN se observa una ventana sostenida de operación sin gaps nuevos en los 74
  canales existentes de `rtserve.earthscope.org` y sin caídas de WebSocket en
  el wall de prueba
- THEN el sistema queda habilitado para cargar el resto del catálogo
  confirmado

#### Scenario: Degradación detectada en la prueba de humo bloquea el catálogo completo

- GIVEN un wall de prueba con 20-30 estaciones nuevas cargado en producción
- WHEN se observan gaps nuevos o reconexiones adicionales en los 74 canales
  existentes de `rtserve.earthscope.org`, o caídas de conexión WebSocket en el
  wall de prueba
- THEN el sistema MUST NOT avanzar a cargar el resto del catálogo confirmado
  hasta que se investigue y resuelva la causa de la degradación

### Requirement: Canal sin datos vivos al momento de cargar el wall no bloquea el resto del wall

Cuando una estación marcada como "(cualquiera)" en el catálogo resulta no
tener datos vivos al momento de intentar suscribirse (a diferencia del momento
en que fue verificada), el sistema MUST seguir sirviendo con normalidad el
resto de los canales del mismo wall. La ausencia de datos de un canal
individual MUST NOT impedir la carga ni la visualización de los demás
canales del wall.

#### Scenario: Un canal sin datos vivos no tumba la carga del wall completo

- GIVEN un wall con N canales, donde uno de ellos no tiene datos vivos
  disponibles al momento de la suscripción (aunque haya sido verificado
  previamente)
- WHEN se carga el wall
- THEN los N-1 canales restantes se cargan y muestran con normalidad
- AND el canal sin datos vivos se refleja como tal (sin datos), sin bloquear
  ni degradar la carga de los demás

### Requirement: Walls temáticos respetan los guardrails existentes sin modificarlos

Cada wall temático por región MUST crearse usando el `WallManager` existente
sin modificar `MAX_WALL_CHANNELS` (120) ni `MAX_WALL_COLUMNS` (8). Un intento
de crear o modificar un wall que exceda cualquiera de esos dos límites MUST
rechazarse con el mismo comportamiento de error ya existente en
`wall_service.py`, sin excepción para los walls de este change.

#### Scenario: Wall temático dentro de los límites se crea correctamente

- GIVEN una selección de canales del catálogo ampliado que no supera 120
  canales ni requiere más de 8 columnas
- WHEN se crea un wall temático por región (ej. "América") con `WallManager`
- THEN el wall se crea exitosamente
- AND queda disponible para visualización con sus canales agrupados según lo
  solicitado

#### Scenario: Intento de wall que excede MAX_WALL_CHANNELS es rechazado

- GIVEN una selección de canales del catálogo ampliado que supera 120 canales
- WHEN se intenta crear un wall temático con esa selección
- THEN la creación se rechaza con `InvalidWallLayoutError` (o el error
  equivalente ya existente en `wall_service.py`)
- AND `MAX_WALL_CHANNELS` permanece en 120 (no se modifica para permitir la
  operación)

#### Scenario: Intento de wall que excede MAX_WALL_COLUMNS es rechazado

- GIVEN una distribución de columnas solicitada para un wall temático que
  supera 8 columnas
- WHEN se intenta crear ese wall
- THEN la creación se rechaza con `InvalidWallLayoutError` (o el error
  equivalente ya existente en `wall_service.py`)
- AND `MAX_WALL_COLUMNS` permanece en 8 (no se modifica para permitir la
  operación)

### Requirement: Catálogo ampliado es aditivo sobre el catálogo actual

Las estaciones nuevas del cuaderno MUST agregarse al catálogo existente sin
modificar ni eliminar ninguna de las 27 ciudades / 74 canales ya servidos en
producción por `rtserve.earthscope.org`. Revertir las entradas agregadas MUST
restaurar el catálogo actual sin requerir ningún otro cambio.

#### Scenario: Catálogo actual permanece intacto tras agregar el catálogo nuevo

- GIVEN el catálogo actual de 27 ciudades / 74 canales en producción
- WHEN se agrega el catálogo ampliado del cuaderno
- THEN las 27 ciudades / 74 canales originales siguen presentes en
  `LIVE_CANDIDATES_BY_CITY` (o estructura equivalente) sin cambios en su
  definición

#### Scenario: Revertir el catálogo nuevo no requiere tocar el catálogo actual

- GIVEN el catálogo ampliado ya agregado
- WHEN se revierte el commit que agrega las entradas nuevas
- THEN el catálogo resultante es idéntico al catálogo actual previo a este
  change, sin necesidad de ningún cambio adicional para restaurarlo
</content>
