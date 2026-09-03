# Feedback Specification — Tablero Kanban de feedback para beta testers

> **Versión 2026-09-03.** Reemplaza íntegramente la spec del 2026-09-01 (canal
> binario abierto/resuelto por `resolved_at`, lectura solo-admin, "los testers
> no leen"). Ese modelo quedó retirado por el proposal enmendado el 2026-09-03,
> que es la fuente vigente. Todo requirement que contradiga este documento está
> desactualizado.

## Purpose

Especifica el comportamiento del dominio de feedback de beta: el envío
autenticado de reportes (falla o sugerencia) con captura automática de contexto
técnico, su persistencia en `feedback_reports`, un **tablero de cinco estados**
legible por **cualquier usuario autenticado** (con el email del autor), y la
gestión exclusiva del admin: mover tarjetas entre estados y escribir **un**
comentario opcional y editable por tarjeta. Es un canal de feedback de beta,
NO un sistema de tickets: sin adjuntos, sin threading, sin asignaciones, sin
prioridades, sin historial de transiciones, sin notificaciones.

No existe un `openspec/specs/feedback/spec.md` previo en el repositorio (el
dominio es nuevo — verificado el 2026-09-03 contra `openspec/specs/`), por lo
que este documento se redacta como spec completa (no delta), acotada al alcance
del proposal de `feedback-beta-testers`.

## Decisiones tomadas en esta spec (el proposal las dejó abiertas)

El proposal delegó al design varias decisiones que, en realidad, condicionan
los escenarios de prueba. Para que el design y los tests tengan una sola
fuente, se fijan ACÁ y se marcan como **decidido en spec**. El design puede
argumentar en contra, pero si lo hace debe actualizar esta spec, no
contradecirla en silencio.

| Tema | Decisión | Por qué |
|------|----------|---------|
| **Identificadores de estado en la API** | Enum en inglés `snake_case`: `new`, `in_analysis`, `in_progress`, `done`, `discarded`. Las etiquetas visibles (`Nuevo`, `En análisis`, `En progreso`, `Hecho`, `Descartado`) son i18n del cliente, nunca el valor de la API | Convención del repo (`UserRole` en inglés, `type` ya es `bug`/`suggestion`); la API no habla castellano |
| **Transiciones permitidas** | El admin mueve de **cualquier estado a cualquier otro** de los cinco, incluido salir de `done` o `discarded`. No hay máquina de estados estricta | No existe ninguna máquina de estados en `src/` que sirva de precedente (verificado con `rg`); el proposal fija "último escribe gana" y una beta cerrada de ~4 cuentas con un solo admin; una máquina estricta agrega 4xx y strings de error sin evitar ningún daño real, y un arrastre equivocado se corrige arrastrando de vuelta |
| **Entradas inválidas del movimiento** | Estado fuera del enum ⇒ **422**, sin cambios. Mover al **mismo** estado en el que ya está ⇒ **200 idempotente, no-op** (no cambia `status_changed_at`) | Un drop en la misma columna o un doble click no son errores del usuario; castigarlos con 4xx obliga al cliente a distinguir casos sin valor |
| **Semántica de `discarded`** | Es **terminal en el flujo** (fuera de la secuencia `new → in_analysis → in_progress → done`) y distinto de `done`, pero **no está bloqueado**: el admin puede sacar una tarjeta de `discarded` | "Terminal" describe el significado para el tester, no un candado; el descarte por error debe poder revertirse |
| **Payload del tablero** | Un solo `GET` devuelve **todos** los reportes, sin filtros ni paginación, ordenados por `created_at` descendente, envueltos como `{"reports": [...]}` (shape del design, calco de `comments.py`). Campos obligatorios por item: `id`, `type`, `body`, `route`, `url`, `user_agent`, `status`, `author_email`, `admin_comment` (nullable), `admin_comment_updated_at` (nullable, va en par con `admin_comment`: ambos `null` o ambos con valor), `created_at`, `status_changed_at` (nullable: `null` mientras la tarjeta nunca se movió) | El tablero de 5 columnas reemplaza a los filtros del proposal original; decenas de tarjetas como techo realista; el cliente agrupa por `status`. `author_email` calca `WindowCommentPublic.author_email` |
| **Comentario del admin** | Uno por tarjeta, texto de **1..2000 caracteres** tras recortar espacios; **`null`, cadena vacía o solo espacios ⇒ se vacía** (`admin_comment` y `admin_comment_updated_at` pasan a `null`); la operación **reemplaza** el valor anterior (semántica PUT), es idempotente y responde 200 con la tarjeta actualizada. `admin_comment_updated_at` se setea al `now()` de la base cuando el texto CAMBIA y queda intacto cuando se reenvía el mismo texto (también si solo difiere en espacios exteriores). Más de 2000 ⇒ 422 | Mismo límite que `body` para no inventar un segundo número; "vaciar" es requisito del proposal y se resuelve sin un endpoint DELETE aparte; el timestamp propio del comentario es lo que el test de idempotencia compara |
| **Respuesta de mover y de comentar** | 200 con el item completo de la tarjeta (mismo shape que el item del tablero) | Permite al cliente reemplazar la tarjeta en memoria sin re-fetch del tablero |
| **Ack de creación** | 201 con `{id, created_at}`. El estado inicial es `new` **por contrato** y no viaja en el ack. Nada más | El proposal pide ack mínimo; el widget no necesita otra cosa. **Reconciliado 2026-09-03 con el design** (antes decía `{id, status}`): el design fija el shape y `status` era información redundante |

> **Reconciliación specs ↔ design (2026-09-03)** — el design fija los shapes y
> esta spec los adopta tal cual: mover es `PUT /feedback/{report_id}/status`
> con body `{"status": "<enum>"}`; comentar es `PUT /feedback/{report_id}/comment`
> con body `{"comment": "<texto>" | null}` (el campo del REQUEST se llama
> `comment`; el del item de RESPUESTA sigue siendo `admin_comment`); el tablero
> es `GET /feedback` ⇒ `{"reports": [...]}`; el ack del `POST` es
> `{id, created_at}`. Lo que la spec conserva por ser comportamiento observable:
> `status_changed_at` es `null` hasta el primer movimiento (el design lo tenía
> como `NOT NULL DEFAULT now()`; se anotó allí como reconciliado) y los tres
> campos de contexto son obligatorios en el payload (ausente ⇒ 422, aunque
> `user_agent` admite `""`).

Fuera de esta spec (lo decide el design): SQL, modelado físico del estado
(columna `status` con `CHECK` versus timestamps — con la obligación del
proposal de argumentar contra `src/models/beta.py`), índices, nombre interno
del service.

## Convención de errores (aplica a TODOS los requirements de este spec)

Los endpoints de este dominio viven en un router (`src/api/routers/feedback.py`,
patrón `comments.py`) y rechazan con `HTTPException`, que FastAPI serializa como
`{"detail": "..."}` — verificado contra el comportamiento vigente de los routers
del repo. Por lo tanto: **todo 4xx de los endpoints de este spec MUST tener body
`{"detail": "<mensaje>"}`**. Ningún endpoint de este spec MUST devolver
`{"error": ...}`.

Nota verificada sobre autenticación (`src/api/deps.py`, 2026-09-03):
`get_current_user` rechaza con **401 genérico** tanto la ausencia de sesión
como la sesión de una cuenta desactivada (`deactivated_at` seteado ⇒
`is_active` falso ⇒ 401, no 403; el 401 es genérico a propósito para no
revelar si la cuenta existe). `require_min_role(UserRole.ADMIN)` deja pasar a
`admin` y `superadmin` y rechaza con **403** a `viewer` y `moderador`; sin
sesión sigue siendo 401 porque `get_current_user` corre antes. Los escenarios
de este spec siguen ese comportamiento real, no uno deseado.

## Requirements

### Requirement: Persistencia del reporte con estado de cinco valores

El sistema MUST persistir cada reporte en la tabla `feedback_reports` con:
`id` (UUID), `user_id` (FK a `users` con `ON DELETE CASCADE`), `type`, `body`,
contexto técnico (`route`, `url`, `user_agent` como columnas de texto acotadas,
no JSONB libre), `created_at` con default del servidor de base (`now()`), el
**estado de la tarjeta** restringido a exactamente cinco valores (`new`,
`in_analysis`, `in_progress`, `done`, `discarded` — cualquier otro valor MUST
ser rechazado por la propia base, no solo por la API), el **comentario del
admin** (opcional, uno solo, nullable) con su propio instante de última
edición (`admin_comment_updated_at`, nullable, en par con el comentario: la
base MUST rechazar una fila con uno de los dos en `null` y el otro con valor)
y el instante del **último cambio de estado** (`status_changed_at`, `null`
hasta el primer movimiento).

Un reporte recién creado MUST nacer en estado `new`, sin comentario del admin
(`admin_comment` y `admin_comment_updated_at` en `null`) y con
`status_changed_at` en `null`.

El sistema MUST NOT conservar un historial de transiciones: solo el estado
actual y cuándo cambió por última vez.

La migración `019_feedback_reports.sql` MUST ser idempotente
(`CREATE TABLE IF NOT EXISTS` y equivalentes) y auto-aplicarse por el mecanismo
existente (`scripts/apply_migrations.py` gateado por
`RUN_MIGRATIONS_ON_STARTUP`), sin intervención manual.

#### Scenario: Un reporte recién creado nace en `new`

- GIVEN un beta tester autenticado que envía un reporte válido
- WHEN el sistema lo persiste en `feedback_reports`
- THEN la fila tiene `created_at` asignado por la base (no por el cliente)
- AND su estado es `new`
- AND su comentario del admin es `null` (y `admin_comment_updated_at` también)
- AND su `status_changed_at` es `null`

#### Scenario: La base rechaza un estado fuera de los cinco

- GIVEN la tabla `feedback_reports` creada por la migración 019
- WHEN se intenta escribir directamente (sin pasar por la API) una fila o un
  `UPDATE` con estado `"pending"`
- THEN la base rechaza la escritura por violación de la restricción
- AND ninguna fila queda con un estado fuera de `new`, `in_analysis`,
  `in_progress`, `done`, `discarded`

#### Scenario: Segunda aplicación de la migración es no-op

- GIVEN una base donde la migración 019 ya fue aplicada y la tabla
  `feedback_reports` existe (con o sin filas)
- WHEN el servicio arranca de nuevo y `apply_migrations.py` vuelve a correr
  la migración 019
- THEN el arranque termina sin error
- AND la estructura de la tabla y las filas existentes quedan intactas

#### Scenario: Borrar el usuario borra sus reportes en cascada

- GIVEN un usuario con reportes en `feedback_reports`
- WHEN ese usuario se elimina de `users`
- THEN sus reportes se eliminan en cascada
- AND no quedan filas huérfanas apuntando a un `user_id` inexistente

### Requirement: Envío de feedback autenticado con ack mínimo

`POST /feedback` MUST exigir sesión válida (`get_current_user`): cualquier
usuario autenticado y activo — viewer incluido — puede enviar. Sin sesión
válida, la petición MUST rechazarse con 401 ANTES de tocar la base.

El `user_id` del reporte MUST tomarse de la sesión del servidor. El sistema
MUST NOT aceptar ni honrar un `user_id` provisto en el body: si el body incluye
un campo `user_id`, MUST ignorarse y el reporte MUST atribuirse igualmente al
usuario de la sesión.

El envío exitoso MUST responder **201** con un ack mínimo: exactamente `id`
(UUID del reporte creado) y `created_at` (el timestamp que puso la base). El
estado inicial `new` es contrato y no viaja en el ack. El ack MUST NOT incluir
contenido de ningún otro reporte.

#### Scenario: Un viewer autenticado envía un reporte y recibe el ack mínimo

- GIVEN una sesión válida de un usuario con rol `viewer`
- WHEN hace `POST /feedback` con `type=bug`, un `body` de texto válido y el
  contexto técnico (`route`, `url`, `user_agent`)
- THEN la respuesta HTTP es 201 con body `{"id": <uuid>, "created_at": <timestamp>}`
  y ninguna otra clave
- AND existe una fila nueva en `feedback_reports` con `user_id` igual al id
  del usuario de la sesión, ese mismo `id`, ese mismo `created_at` y
  `status = "new"`

#### Scenario: Sin sesión el envío se rechaza con 401

- GIVEN una petición sin cookie `session` (o con token inválido/expirado)
- WHEN hace `POST /feedback` con un payload válido
- THEN la respuesta HTTP es 401 con body `{"detail": "..."}`
- AND no se crea ninguna fila en `feedback_reports`

#### Scenario: Una cuenta desactivada no puede enviar

- GIVEN una sesión emitida para un usuario que luego fue desactivado
  (`deactivated_at` seteado en la base)
- WHEN hace `POST /feedback` con un payload válido
- THEN la respuesta HTTP es 401 (comportamiento verificado de
  `get_current_user`: cuenta desactivada ⇒ 401 genérico, no 403)
- AND no se crea ninguna fila en `feedback_reports`

#### Scenario: Un user_id en el body se ignora

- GIVEN una sesión válida del usuario A
- WHEN hace `POST /feedback` incluyendo en el body un campo `user_id` con el
  id del usuario B
- THEN la respuesta HTTP es 201
- AND la fila creada tiene `user_id` = A (el de la sesión), nunca B

### Requirement: Validación del tipo de reporte

El campo `type` del envío MUST ser obligatorio y aceptar exactamente dos
valores: `bug` (falla) o `suggestion` (sugerencia). Cualquier otro valor, o su
ausencia, MUST rechazarse con 422 sin crear fila. La base MUST reforzar la
misma restricción con un `CHECK` (defensa en profundidad).

#### Scenario: Tipo inválido se rechaza

- GIVEN una sesión válida
- WHEN hace `POST /feedback` con `type="question"` y el resto del payload
  válido
- THEN la respuesta HTTP es 422 con body `{"detail": ...}`
- AND no se crea ninguna fila en `feedback_reports`

#### Scenario: Ambos tipos válidos se aceptan

- GIVEN una sesión válida
- WHEN hace dos `POST /feedback` válidos, uno con `type="bug"` y otro con
  `type="suggestion"`
- THEN ambas respuestas son 201
- AND cada fila persiste el `type` enviado

### Requirement: Validación del texto del reporte

El campo `body` MUST ser obligatorio, de 1 a 2000 caracteres. El sistema MUST
rechazar con 422, sin crear fila:

- `body` ausente o vacío,
- `body` compuesto únicamente de espacios en blanco (un reporte sin contenido
  no es un reporte),
- `body` de más de 2000 caracteres.

Un `body` de exactamente 2000 caracteres MUST aceptarse. El `body` MUST NOT
truncarse jamás (ni en cliente ni en servidor). La base MUST reforzar el rango
1..2000 con un `CHECK` de longitud (defensa en profundidad frente a escrituras
que no pasen por la API).

#### Scenario: Texto vacío se rechaza

- GIVEN una sesión válida
- WHEN hace `POST /feedback` con `body=""` y el resto del payload válido
- THEN la respuesta HTTP es 422
- AND no se crea ninguna fila

#### Scenario: Texto de solo espacios se rechaza

- GIVEN una sesión válida
- WHEN hace `POST /feedback` con `body="   \n\t  "`
- THEN la respuesta HTTP es 422
- AND no se crea ninguna fila

#### Scenario: Texto gigante se rechaza, el límite exacto se acepta

- GIVEN una sesión válida
- WHEN hace `POST /feedback` con un `body` de 2001 caracteres
- THEN la respuesta HTTP es 422 y no se crea ninguna fila
- AND un `POST /feedback` idéntico con un `body` de exactamente 2000
  caracteres responde 201 y persiste el texto completo, sin truncar

### Requirement: Contexto técnico como datos no confiables del cliente

El contexto técnico (`route`, `url`, `user_agent`) MUST viajar en el body del
`POST /feedback`, armado por el cliente. El backend MUST tratarlo como DATOS no
confiables: los valida (presencia, tipo string, longitud acotada) y los
persiste como texto opaco; MUST NOT interpretarlos, ejecutarlos, ni usarlos
para ninguna decisión de autorización o enrutamiento.

Los tres campos MUST ser obligatorios (el widget los adjunta siempre; un
cliente que no los manda es un payload inválido) y MUST tener longitud máxima
validada en la API y reforzada por el `CHECK` de la columna: `route` hasta 300
caracteres, `url` hasta 2000 caracteres, `user_agent` hasta 400 caracteres.
La defensa es en profundidad, con dos capas que no se reemplazan entre sí: el
widget (spec `dashboard-ui`) trunca los tres campos a esos mismos límites
ANTES de enviar — el contexto es metadata defensiva, no contenido del tester —
y aun así el backend MUST rechazar con 422, sin crear fila, un campo de
contexto ausente, no-string o que excede su máximo (un cliente que saltea el
truncado del widget no obtiene un truncado de cortesía del servidor: la
autoridad de validación es el backend).

El timestamp del reporte (`created_at`) MUST provenir del servidor de base
(`now()`); el sistema MUST NOT aceptar un timestamp de creación provisto por
el cliente.

#### Scenario: El contexto enviado se persiste tal cual, como texto

- GIVEN una sesión válida
- WHEN hace `POST /feedback` con `route="/analytics"`,
  `url="https://app.example/analytics?channel=AK.FIRE..BHZ&start=..."` y un
  `user_agent` de navegador real
- THEN la respuesta HTTP es 201
- AND la fila persiste los tres valores exactamente como llegaron, sin
  normalizar ni truncar

#### Scenario: Contexto ausente se rechaza

- GIVEN una sesión válida
- WHEN hace `POST /feedback` con `type` y `body` válidos pero sin el campo
  `url` (o sin `route`, o sin `user_agent`)
- THEN la respuesta HTTP es 422
- AND no se crea ninguna fila

#### Scenario: Contexto sobredimensionado se rechaza

- GIVEN una sesión válida de un cliente que NO pasa por el widget (el widget
  truncaría antes de enviar)
- WHEN hace `POST /feedback` con una `url` de 2001 caracteres y el resto del
  payload válido
- THEN la respuesta HTTP es 422
- AND no se crea ninguna fila
- AND lo mismo aplica a un `route` de 301 caracteres o un `user_agent` de 401
  caracteres

#### Scenario: Un timestamp del cliente no manda

- GIVEN una sesión válida
- WHEN hace `POST /feedback` incluyendo en el body un campo `created_at` con
  una fecha del pasado
- THEN la respuesta HTTP es 201
- AND el `created_at` persistido es el del servidor de base al momento del
  insert, no el valor enviado

### Requirement: Lectura del tablero por cualquier usuario autenticado

`GET /feedback` MUST exigir sesión válida (`get_current_user`) y MUST responder
**200 a cualquier rol** (`viewer`, `moderador`, `admin`, `superadmin`). Sin
sesión, 401. Cuenta desactivada, 401.

La respuesta MUST ser `{"reports": [...]}` y contener **todos** los reportes
de la tabla — propios y ajenos, en cualquiera de los cinco estados — sin
filtros ni paginación, ordenados por `created_at` descendente (lo más nuevo
primero). Cada item MUST incluir exactamente estos campos como mínimo: `id`,
`type`, `body`, `route`, `url`, `user_agent`, `status` (uno de los cinco
valores del enum), `author_email` (el email del usuario autor, mismo criterio
que `WindowCommentPublic.author_email`), `admin_comment` (texto o `null`),
`admin_comment_updated_at` (timestamp o `null`, siempre en par con
`admin_comment`), `created_at`, `status_changed_at` (timestamp o `null` si
nunca se movió). El item MUST NOT exponer el `user_id` interno ni ningún otro
dato del autor más allá del email.

La lectura MUST ser idéntica para todos los roles: un viewer y un admin
reciben el mismo payload para la misma base. Lo que cambia por rol es qué
operaciones de escritura se aceptan, nunca qué se lee.

#### Scenario: Un viewer lee el tablero completo con autores

- GIVEN una sesión válida de rol `viewer` (usuario A) y tres reportes en la
  base: uno de A en `new`, uno del usuario B en `in_progress` con comentario
  del admin y uno del usuario C en `discarded`
- WHEN A hace `GET /feedback`
- THEN la respuesta HTTP es 200 con los tres reportes
- AND cada item trae `status`, `author_email` (el email de A, B y C
  respectivamente), `admin_comment` (texto en el de B, `null` en los otros),
  `admin_comment_updated_at` (no nulo solo en el de B), `type`, `body`,
  `route`, `url`, `user_agent`, `created_at` y `status_changed_at`
- AND vienen ordenados por `created_at` descendente

#### Scenario: Viewer y admin leen lo mismo

- GIVEN la misma base con reportes de varios autores
- WHEN un `viewer` y un `admin` hacen `GET /feedback`
- THEN ambos reciben 200
- AND los dos payloads son iguales campo a campo (misma cantidad de items,
  mismos valores, mismo orden)

#### Scenario: Sin sesión o desactivado, 401

- GIVEN reportes existentes en la base
- WHEN una petición sin cookie `session` hace `GET /feedback`, y una sesión de
  una cuenta desactivada hace `GET /feedback`
- THEN ambas respuestas son 401 con body `{"detail": "..."}`
- AND ningún body contiene datos de ningún reporte

#### Scenario: El tablero vacío es una lista vacía

- GIVEN una base sin reportes
- WHEN un usuario autenticado hace `GET /feedback`
- THEN la respuesta HTTP es 200 con body `{"reports": []}` (no 404, no `null`)

### Requirement: Mover una tarjeta de estado (solo admin, cualquiera a cualquiera)

El endpoint de mover — `PUT /feedback/{report_id}/status` con body
`{"status": "<enum>"}` (shape fijado por el design) — MUST exigir
`require_min_role(UserRole.ADMIN)`:
`admin` y `superadmin` pueden mover; `viewer` y `moderador` reciben **403**;
sin sesión, **401**. Un 401 o 403 MUST NOT modificar la fila.

El `status` destino MUST ser uno de `new`, `in_analysis`, `in_progress`,
`done`, `discarded`. Cualquier otro valor (o su ausencia) MUST rechazarse con
422 sin modificar la fila.

**Transiciones (decidido en spec)**: el sistema MUST aceptar el movimiento de
cualquier estado a cualquier otro de los cinco, sin máquina de estados. Salir
de `done` o de `discarded` hacia cualquier otro estado MUST estar permitido.

Un movimiento válido a un estado **distinto** del actual MUST persistir el
nuevo `status`, setear `status_changed_at` al `now()` del servidor de base y
responder 200 con el item completo de la tarjeta (mismo shape que el item del
tablero). Un movimiento al **mismo** estado actual MUST responder 200 con el
item sin cambios y MUST NOT modificar `status_changed_at` (no-op idempotente).

Mover un `id` con formato UUID válido pero inexistente MUST responder 404 con
`{"detail": "..."}`. Un `{id}` que no es un UUID MUST rechazarse con 422
(validación del path param, antes de tocar la base).

Concurrencia: dos admins moviendo la misma tarjeta MUST resolverse por
"último escribe gana"; el sistema MUST NOT implementar bloqueo optimista en
esta versión (documentado en el proposal, no mitigado).

#### Scenario: Un admin mueve de `new` a `in_progress` y persiste

- GIVEN una tarjeta en estado `new` con `status_changed_at = null` y una
  sesión de rol `admin`
- WHEN mueve la tarjeta a `in_progress`
- THEN la respuesta HTTP es 200 con el item de la tarjeta con
  `status = "in_progress"` y `status_changed_at` no nulo
- AND la fila en la base tiene `status = "in_progress"` y `status_changed_at`
  asignado por el servidor
- AND un `GET /feedback` posterior de cualquier usuario devuelve la tarjeta en
  `in_progress`

#### Scenario: Cualquier estado a cualquier otro, incluida la vuelta desde terminales

- GIVEN una tarjeta en `discarded` y otra en `done`, y una sesión de rol
  `admin`
- WHEN mueve la primera a `in_analysis` y la segunda a `new`
- THEN ambas respuestas son 200
- AND las filas quedan en `in_analysis` y `new` respectivamente

#### Scenario: Mover al mismo estado es idempotente y no toca el timestamp

- GIVEN una tarjeta en `in_progress` con `status_changed_at = T1` y una
  sesión de rol `admin`
- WHEN mueve la tarjeta a `in_progress`
- THEN la respuesta HTTP es 200 con el item de la tarjeta
- AND el `status_changed_at` de la fila sigue siendo exactamente `T1`

#### Scenario: Estado fuera del enum se rechaza con 422

- GIVEN una tarjeta en `new` y una sesión de rol `admin`
- WHEN intenta moverla a `"resolved"` (o a `"Hecho"`, la etiqueta en
  castellano, o a un `status` ausente)
- THEN la respuesta HTTP es 422 con body `{"detail": ...}`
- AND la fila sigue en `new` con `status_changed_at = null`

#### Scenario: Roles insuficientes reciben 403, sin sesión 401, y nada cambia

- GIVEN una tarjeta en `new`
- WHEN un `viewer` con sesión válida intenta moverla a `done`, un `moderador`
  hace lo mismo, y una petición sin sesión hace lo mismo
- THEN el viewer recibe 403, el moderador recibe 403 y la petición sin sesión
  recibe 401, todos con body `{"detail": "..."}`
- AND la fila sigue en `new`
- AND un `superadmin` con sesión válida que hace el mismo movimiento recibe
  200 (jerarquía: min role admin)

#### Scenario: Tarjeta inexistente o id malformado

- GIVEN una sesión de rol `admin`
- WHEN mueve un UUID bien formado que no existe en la base a `done`
- THEN la respuesta HTTP es 404 con body `{"detail": "..."}`
- AND mover el id `"no-es-un-uuid"` responde 422 sin consultar la base

### Requirement: Comentario único del admin por tarjeta (escribir, editar, vaciar)

El endpoint de comentario — `PUT /feedback/{report_id}/comment` con body
`{"comment": "<texto>" | null}` (shape fijado por el design; el campo del
request se llama `comment`, el del item de respuesta `admin_comment`) — MUST
exigir `require_min_role(UserRole.ADMIN)` con la misma matriz que el
movimiento: 403 para `viewer`/`moderador`, 401 sin sesión, y en ambos casos la
fila no cambia.

La operación MUST tener semántica de **reemplazo completo** (PUT): el valor
enviado pisa el anterior sin conservar historial; repetir la misma llamada
MUST producir el mismo estado (idempotente). Existe **un solo** comentario por
tarjeta: el sistema MUST NOT acumular comentarios ni exponer versiones
anteriores.

Reglas del valor (decidido en spec):

- Texto no vacío tras recortar espacios, de 1 a 2000 caracteres ⇒ se persiste
  y `admin_comment` pasa a ese texto (recortado). Si el texto resultante es
  DISTINTO del actual, `admin_comment_updated_at` pasa al `now()` de la base;
  si es el MISMO texto (reenvío, o la misma cadena con espacios exteriores de
  más), `admin_comment_updated_at` MUST quedar exactamente como estaba
  (no-op idempotente, espejo de `status_changed_at` en el movimiento).
- `null`, cadena vacía o solo espacios ⇒ **vacía** el comentario:
  `admin_comment` y `admin_comment_updated_at` pasan a `null` (par
  consistente). Vaciar un comentario ya `null` MUST responder 200 (no-op).
- Más de 2000 caracteres ⇒ 422 sin modificar la fila. La base MUST reforzar el
  tope con un `CHECK`.

La respuesta exitosa MUST ser 200 con el item completo de la tarjeta. El
comentario MUST ser visible para cualquier usuario autenticado en el `GET
/feedback` inmediatamente posterior (es el único canal de respuesta del admin
al tester). Comentar MUST NOT cambiar el `status` ni el `status_changed_at`
de la tarjeta.

Un `id` UUID válido pero inexistente MUST responder 404; un `id` que no es UUID,
422.

#### Scenario: El admin escribe un comentario y el tester lo ve

- GIVEN una tarjeta del usuario A con `admin_comment = null` y una sesión de
  rol `admin`
- WHEN el admin envía `{"comment": "Reproducido, es el cache del helicorder"}`
- THEN la respuesta HTTP es 200 con el item de la tarjeta con ese
  `admin_comment` y `admin_comment_updated_at` no nulo
- AND A (rol `viewer`) hace `GET /feedback` y ve la tarjeta con exactamente
  ese comentario

#### Scenario: Editar reemplaza sin historial

- GIVEN una tarjeta con `admin_comment = "v1"` y `admin_comment_updated_at = C1`,
  y una sesión de rol `admin`
- WHEN el admin envía `{"comment": "v2"}`
- THEN la respuesta HTTP es 200 con `admin_comment = "v2"` y
  `admin_comment_updated_at = C2 > C1`
- AND el `GET /feedback` de cualquier usuario muestra únicamente `"v2"`; `"v1"`
  no aparece en ningún campo de la respuesta

#### Scenario: Reenviar el mismo comentario no toca su timestamp

- GIVEN una tarjeta con `admin_comment = "hola"` y `admin_comment_updated_at = C1`,
  y una sesión de rol `admin`
- WHEN el admin envía `{"comment": "hola"}` y luego `{"comment": "  hola  "}`
- THEN ambas respuestas son 200 con `admin_comment = "hola"`
- AND `admin_comment_updated_at` de la fila sigue siendo exactamente `C1`
  (comparado como timestamp leído de la base, no solo por el 200)

#### Scenario: Vaciar el comentario con null o con cadena vacía

- GIVEN una tarjeta con `admin_comment = "texto"` y una sesión de rol `admin`
- WHEN el admin envía `{"comment": null}`
- THEN la respuesta HTTP es 200 con `admin_comment = null` y
  `admin_comment_updated_at = null`
- AND si la tarjeta vuelve a tener texto y el admin envía `{"comment": "   "}`
  (solo espacios), la respuesta es 200 y ambos campos quedan en `null`
- AND repetir el vaciado sobre un comentario ya `null` responde 200

#### Scenario: Comentar no mueve la tarjeta

- GIVEN una tarjeta en `in_analysis` con `status_changed_at = T1`
- WHEN un admin escribe o edita su comentario
- THEN la fila sigue en `in_analysis`
- AND `status_changed_at` sigue siendo exactamente `T1`

#### Scenario: Comentario demasiado largo se rechaza

- GIVEN una tarjeta con `admin_comment = "previo"` y una sesión de rol `admin`
- WHEN el admin envía un `comment` de 2001 caracteres
- THEN la respuesta HTTP es 422 con body `{"detail": ...}`
- AND la fila conserva `admin_comment = "previo"` y su
  `admin_comment_updated_at` intacto
- AND un envío de exactamente 2000 caracteres responde 200 y persiste el texto
  completo

#### Scenario: Roles insuficientes no comentan

- GIVEN una tarjeta con `admin_comment = null`
- WHEN un `viewer` con sesión válida envía un comentario, un `moderador` hace
  lo mismo y una petición sin sesión hace lo mismo
- THEN el viewer recibe 403, el moderador recibe 403 y la petición sin sesión
  recibe 401
- AND la fila conserva `admin_comment = null`

#### Scenario: Tarjeta inexistente o id malformado

- GIVEN una sesión de rol `admin`
- WHEN comenta un UUID bien formado que no existe en la base
- THEN la respuesta HTTP es 404 con body `{"detail": "..."}`
- AND comentar el id `"no-es-un-uuid"` responde 422 sin consultar la base

### Requirement: Sin edición ni borrado de reportes

El sistema MUST NOT exponer ningún endpoint para que el autor edite o borre un
reporte enviado, ni para que el admin borre uno: un reporte es un registro. El
único mecanismo de "cierre negativo" MUST ser mover la tarjeta a `discarded`,
que deja rastro visible en el tablero.

#### Scenario: No existe borrado ni edición de reportes

- GIVEN un reporte existente y una sesión de rol `admin`
- WHEN intenta `DELETE` sobre el recurso del reporte, o modificar `body`/`type`
  a través del endpoint de mover o de comentar
- THEN el `DELETE` responde 404 o 405 (la ruta no existe)
- AND `body` y `type` de la fila quedan exactamente como se crearon (los
  endpoints de mover y comentar solo escriben `status`/`status_changed_at` y
  `admin_comment` respectivamente)
