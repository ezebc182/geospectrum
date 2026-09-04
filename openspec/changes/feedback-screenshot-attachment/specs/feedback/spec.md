# Delta for Feedback — Captura de pantalla opcional

Delta sobre `openspec/changes/feedback-beta-testers/specs/feedback/spec.md`
(ese change está mergeado a `main`; no existe todavía un
`openspec/specs/feedback/spec.md` archivado — verificado con `fd`/`rg`, así
que la fuente vigente es el spec del change base). Todo lo de acá es
**ADDED**: una columna nueva, un endpoint de presign y una regla de
validación de forma sobre `screenshot_key`. Ningún requirement del spec base
se modifica ni se contradice — un reporte sin captura sigue comportándose
exactamente igual que hoy.

## Decisiones tomadas en esta spec (el proposal las dejó abiertas)

| # | Tema | Decisión | Por qué |
|---|------|----------|---------|
| 1 | **Cap de tamaño/dimensión del PNG** | Máximo **1920px** en el lado largo y máximo **2 MB** tras compresión client-side (`modern-screenshot` con `quality`/escala ajustada si excede). Si tras comprimir sigue por encima de 2 MB, el cliente **descarta la captura** (no la sube, no bloquea el envío) en vez de reintentar o rechazar el reporte | La base de beta son ~4 cuentas: no hay presión de volumen que justifique un cap más chico, y 1920×2MB cubre cualquier viewport de escritorio real sin generar archivos que tarden en subir en una conexión débil (riesgo ya señalado en el proposal). Es un número arbitrario pero conservador: mejor pecar de generoso en una beta cerrada que inventar precisión que nadie va a medir |
| 2 | **Forma del flujo de subida** | Endpoint **separado**: `POST /feedback/upload-url`, llamado ANTES de `POST /feedback`, en el momento en que el widget ABRE (no al submit). Devuelve la URL prefirmada y la key; el browser hace `PUT` directo a R2 en paralelo mientras el tester escribe; `POST /feedback` solo recibe `screenshot_key` (ya subido) o lo omite | Recomendado explícitamente por el proposal: la captura se dispara al abrir el widget, no al enviar (mismo momento que el contexto de texto). Un presign plegado en `POST /feedback` obligaría a capturar y subir DESPUÉS de que el tester termine de escribir, agregando latencia visible al submit — exactamente lo que "no debe bloquear el envío" quiere evitar. Dos round-trips es diff aceptado a cambio de que la subida corra en paralelo con el tipeo |
| 3 | **Scoping y expiración de la URL prefirmada** | Key `feedback-screenshots/{uuid4}.png` (UUID4 impredecible, sin relación con `report_id` porque el presign ocurre ANTES de que el reporte exista). La URL prefirmada autoriza únicamente `PUT` sobre esa key exacta (sin `ListBucket`, sin `GetObject` de otras keys), expiración de **5 minutos**. El backend **NO valida contra R2** que el objeto de un `screenshot_key` recibido en `POST /feedback` haya sido efectivamente subido — ver Requirement de validación de forma para lo que sí valida | Ver justificación de confianza más abajo |

### Justificación de la Decisión 3 (superficie de ataque)

La URL prefirmada en sí (PUT-only, key única, 5 minutos) ya cierra el riesgo
del proposal ("permite `PUT` arbitrario al bucket"): nadie que no haya
llamado a `POST /feedback/upload-url` en los últimos 5 minutos puede escribir
en esa key, y escribir en ESA key no le sirve a un atacante para nada más que
pisar un PNG que nadie más referencia todavía.

Lo que el backend **NO** valida, explícitamente, y por qué es aceptable en
este nivel de confianza (beta cerrada, ~4 cuentas, todas autenticadas):

- **Que el objeto exista en el bucket**: `POST /feedback` con un
  `screenshot_key` de forma válida pero que nunca se subió a R2 se acepta
  igual. El peor caso es una tarjeta cuyo thumbnail no carga (404 al pedir la
  imagen) — degradación visual, no un fallo de seguridad ni de integridad de
  datos.
- **Que el `screenshot_key` provisto en `POST /feedback` provenga de un
  presign que el backend emitió para ESA sesión/usuario**: no hay tabla de
  "presigns emitidos pendientes de canje" ni verificación cruzada
  usuario↔key. Un usuario autenticado podría, en teoría, adjuntar a su
  reporte el `screenshot_key` de OTRO reporte cuya imagen ya conoce (si de
  algún modo la obtuvo).
- **Content-type real del archivo ni malware scanning**: el backend confía en
  que lo que se subió es un PNG; no lo abre ni lo inspecciona.

Por qué no hace falta más en este trust level: los cuatro usuarios de la
beta ya están autenticados con sesión válida (mismo modelo de confianza que
el resto del dominio `feedback` — el body y el contexto técnico tampoco se
verifican contra una fuente externa). El peor escenario de "adjuntar la key
ajena" es que la tarjeta de un reporte muestre una imagen de OTRO reporte del
MISMO grupo cerrado de testers — no una fuga hacia afuera del grupo, ni
escalación de privilegios, ni acceso a datos que ese usuario no podría ver
igual en el propio tablero (`GET /feedback` ya expone todas las tarjetas a
todos). Construir una tabla de canje agrega una tabla, un TTL y un código de
limpieza para mitigar un riesgo cuyo techo de daño es "ver una captura ajena
en el tablero que de todos modos es visible para todo el grupo". Si la base
de usuarios creciera más allá de una beta cerrada, esto se reabre.

## ADDED Requirements

### Requirement: Persistencia de la captura opcional

El sistema MUST agregar a `feedback_reports` la columna `screenshot_key TEXT
NULL` (migración `020_feedback_screenshot.sql`, idempotente —
`ADD COLUMN IF NOT EXISTS`, mismo patrón que las 19 migraciones previas). Un
reporte MUST poder crearse con `screenshot_key = NULL` (sin captura) y esto
MUST comportarse en todo lo demás exactamente igual que un reporte del spec
base: mismo 201, mismo ack, misma fila.

Cuando `screenshot_key` no es `NULL`, MUST tener la forma
`feedback-screenshots/{uuid4}.png` (prefijo fijo + UUID versión 4 + extensión
`.png`). El sistema MUST validar esta forma en `POST /feedback` (validación
de Pydantic/regex, sin consultar R2) y MUST rechazar con 422 un
`screenshot_key` que no matchea el patrón, SIN crear la fila.

`GET /feedback`, `PUT /feedback/{id}/status` y `PUT /feedback/{id}/comment`
MUST incluir `screenshot_key` en cada item de su respuesta (mismo `SELECT`
que ya trae el resto de las columnas) — ninguno de los tres endpoints cambia
su contrato existente salvo por este campo adicional.

#### Scenario: Un reporte sin captura se comporta igual que hoy

- GIVEN una sesión válida
- WHEN hace `POST /feedback` con un payload válido y SIN el campo
  `screenshot_key` (u omitiéndolo)
- THEN la respuesta HTTP es 201 con el mismo ack mínimo del spec base
  (`{id, created_at}`)
- AND la fila creada tiene `screenshot_key = NULL`
- AND ningún otro campo ni comportamiento difiere de un reporte del spec base

#### Scenario: Un reporte con screenshot_key de forma válida se acepta

- GIVEN una sesión válida
- WHEN hace `POST /feedback` con
  `screenshot_key = "feedback-screenshots/3fa85f64-5717-4562-b3fc-2c963f66afa6.png"`
  y el resto del payload válido
- THEN la respuesta HTTP es 201
- AND la fila persiste ese `screenshot_key` tal cual, sin verificar contra R2
  que el objeto exista

#### Scenario: Un screenshot_key con formato ajeno se rechaza

- GIVEN una sesión válida
- WHEN hace `POST /feedback` con `screenshot_key = "../../etc/passwd"`, o con
  `screenshot_key = "otro-bucket/imagen.jpg"`, o con
  `screenshot_key = "feedback-screenshots/no-es-un-uuid.png"`
- THEN la respuesta HTTP es 422 con body `{"detail": ...}`
- AND no se crea ninguna fila

#### Scenario: Segunda aplicación de la migración 020 es no-op

- GIVEN una base donde la migración 020 ya fue aplicada y la columna
  `screenshot_key` existe
- WHEN el servicio arranca de nuevo y `apply_migrations.py` vuelve a correr
  la migración 020
- THEN el arranque termina sin error
- AND la columna y las filas existentes quedan intactas

### Requirement: Emisión de URL prefirmada para subida directa a R2

`POST /feedback/upload-url` MUST exigir sesión válida
(`get_current_user`, mismo criterio que `POST /feedback`: cualquier usuario
autenticado y activo, viewer incluido). Sin sesión válida, 401.

El endpoint MUST generar una key nueva `feedback-screenshots/{uuid4}.png`
(UUID4 generado por el servidor, no por el cliente) y MUST devolver **201**
con `{"key": "<key>", "upload_url": "<url prefirmada>", "expires_at":
"<timestamp ISO>"}`. La URL prefirmada MUST autorizar únicamente el método
`PUT` sobre esa key exacta del bucket configurado, con expiración de **5
minutos** desde su emisión. El sistema MUST NOT emitir URLs con permisos de
lectura, listado o escritura sobre otras keys.

Si R2 está mal configurado (variables de entorno de credenciales o bucket
ausentes/inválidas) o inalcanzable, el endpoint MUST responder con un error
que el cliente pueda distinguir de una falla de validación — 503 con
`{"detail": "..."}` — y MUST NOT crashear el proceso ni afectar ningún otro
endpoint del router.

#### Scenario: Un usuario autenticado obtiene una URL prefirmada

- GIVEN una sesión válida de cualquier rol
- WHEN hace `POST /feedback/upload-url`
- THEN la respuesta HTTP es 201 con `upload_url` (string no vacío), `key` con
  la forma `feedback-screenshots/{uuid4}.png`, y `expires_at`
- AND dos llamadas sucesivas del mismo usuario devuelven `key` distintos
  entre sí

#### Scenario: Sin sesión se rechaza con 401

- GIVEN una petición sin cookie `session` válida
- WHEN hace `POST /feedback/upload-url`
- THEN la respuesta HTTP es 401 con body `{"detail": "..."}`
- AND no se genera ninguna key ni se emite ninguna URL

#### Scenario: La URL prefirmada expira a los 5 minutos

- GIVEN una URL prefirmada obtenida de `POST /feedback/upload-url`
- WHEN se intenta el `PUT` del PNG dentro de los 5 minutos
- THEN R2 acepta la subida
- AND la MISMA URL reintentada después de expirados los 5 minutos es
  rechazada por R2 (no por el backend, que ya no interviene en ese `PUT`)

### Requirement: R2 mal configurado no bloquea el resto del feedback

Un fallo o mala configuración de R2 (credenciales ausentes, bucket
inexistente, timeout de red hacia R2) MUST afectar ÚNICAMENTE al endpoint de
presign. `POST /feedback` (con o sin `screenshot_key`), `GET /feedback`,
`PUT /feedback/{id}/status` y `PUT /feedback/{id}/comment` MUST seguir
respondiendo con su comportamiento normal del spec base, sin ninguna
dependencia en tiempo de request hacia R2 — la creación del reporte MUST NOT
llamar a R2 en ningún punto: solo persiste el `screenshot_key` como texto que
ya le llegó validado por forma.

#### Scenario: R2 caído no impide crear reportes sin captura

- GIVEN R2 inalcanzable o mal configurado (credenciales inválidas)
- WHEN un usuario hace `POST /feedback/upload-url` (falla con 503) y luego,
  desde el mismo widget, envía igual el reporte con `POST /feedback` SIN
  `screenshot_key`
- THEN el `POST /feedback` responde 201 igual que si R2 nunca hubiera fallado
- AND la fila se crea con `screenshot_key = NULL`

#### Scenario: R2 caído no impide leer ni gestionar el tablero

- GIVEN R2 inalcanzable
- WHEN un usuario hace `GET /feedback`, y un admin mueve una tarjeta o
  escribe un comentario
- THEN ambas operaciones responden con su código de éxito normal del spec
  base, sin ningún error relacionado con R2

### Requirement: Emisión de URL prefirmada de lectura para la captura

`GET /feedback/{report_id}/screenshot-url` MUST exigir sesión válida
(`get_current_user`, mismo criterio que `GET /feedback`: cualquier usuario
autenticado ve todo el tablero, viewer incluido). Sin sesión válida, 401.

El sistema MUST responder 200 con `{"url": "<url prefirmada>", "expires_at":
"<timestamp ISO>"}` cuando el reporte existe y su `screenshot_key` no es
`NULL`. La URL prefirmada MUST autorizar únicamente `GET` sobre esa key
exacta, con expiración de **5 minutos** desde su emisión.

El sistema MUST responder 404 cuando el `report_id` no existe, y MUST
responder 404 (el mismo código, sin distinguir el caso al cliente) cuando el
reporte existe pero `screenshot_key` es `NULL`.

#### Scenario: Un reporte con captura devuelve una URL de lectura

- GIVEN un reporte existente con `screenshot_key` no nulo
- WHEN un usuario autenticado hace `GET /feedback/{report_id}/screenshot-url`
- THEN la respuesta HTTP es 200 con `url` (string no vacío) y `expires_at`

#### Scenario: Un reporte sin captura responde 404

- GIVEN un reporte existente con `screenshot_key = NULL`
- WHEN un usuario autenticado hace `GET /feedback/{report_id}/screenshot-url`
- THEN la respuesta HTTP es 404 con body `{"detail": ...}`
- AND no se genera ninguna URL

#### Scenario: Un report_id inexistente responde 404

- GIVEN un UUID que no corresponde a ningún reporte
- WHEN un usuario autenticado hace `GET /feedback/{report_id}/screenshot-url`
- THEN la respuesta HTTP es 404

#### Scenario: Sin sesión se rechaza con 401

- GIVEN una petición sin cookie `session` válida
- WHEN hace `GET /feedback/{report_id}/screenshot-url` sobre cualquier `report_id`
- THEN la respuesta HTTP es 401
