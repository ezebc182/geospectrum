# Delta for Auth (role-management)

Delta sobre el dominio auth existente (multi-user-auth, google-oauth,
email-invitations, user-management). Convención heredada: errores de negocio como
`{"error": "..."}` con status explícito; métricas `requests_total` por endpoint/status
con labels literales; guards de dominio server-side (la UI deshabilitando controles no
es el mecanismo de seguridad).

Contexto imprescindible para leer estos requirements: hoy el rol de un usuario ya creado
es INMUTABLE por API (solo se cambia con un `UPDATE` a mano contra producción) y el rol
viaja en el JWT sin revalidarse, con `auth_token_expire_minutes = 1440`. Este delta
agrega el ESCRITOR (endpoint de cambio de rol con sus guards) y arregla el LECTOR
(revalidación del rol en cada request). Van juntos: sin el lector, un cambio de rol tarda
hasta 24 horas en tener efecto.

## ADDED Requirements

### Requirement: Cambio de rol de un usuario existente

El sistema MUST exponer `POST /auth/users/{user_id}/role`, protegido con
`require_min_role(ADMIN)`, que acepta un body JSON `{"role": "<uno de los cuatro roles>"}`
y actualiza `users.role` del usuario objetivo. La respuesta exitosa MUST ser 204 sin
cuerpo (simétrica con `deactivate`/`reactivate`). El cambio MUST NOT alterar ninguna otra
columna del usuario: email, `password_hash`, `google_id`, `deactivated_at`,
`onboarding_completed_at` y el resto quedan intactos. Un `role` que no pertenezca al enum
`UserRole` MUST rechazarse con 422 antes de llegar al servicio (validación del modelo del
request).

El rol NO MUST poder cambiarse por la vía de actualización de perfil propio: el modelo de
`PATCH /auth/me` (`UserProfileUpdate`) MUST seguir excluyendo `role`. El rol es una
decisión de administración, no un campo del perfil.

#### Scenario: Un admin promueve a un viewer a moderador

- GIVEN un `admin` autenticado y un usuario con rol `viewer`
- WHEN llama a `POST /auth/users/{id}/role` con `{"role": "moderador"}`
- THEN el sistema responde 204 sin cuerpo
- AND `users.role` de ese usuario queda en `moderador`
- AND ninguna otra columna del usuario cambió

#### Scenario: Un superadmin degrada a un admin a viewer

- GIVEN un `superadmin` autenticado y un usuario con rol `admin`
- WHEN llama a `POST /auth/users/{id}/role` con `{"role": "viewer"}`
- THEN el sistema responde 204
- AND `users.role` de ese usuario queda en `viewer`

#### Scenario: Cambiar el rol de una cuenta desactivada es válido

- GIVEN un `admin` autenticado y un usuario `viewer` DESACTIVADO
  (`deactivated_at IS NOT NULL`)
- WHEN llama a `POST /auth/users/{id}/role` con `{"role": "moderador"}`
- THEN el sistema responde 204
- AND el rol queda en `moderador`
- AND `deactivated_at` conserva su timestamp original (la cuenta sigue desactivada)

#### Scenario: Un rol inexistente se rechaza con 422

- GIVEN un `admin` autenticado
- WHEN llama a `POST /auth/users/{id}/role` con `{"role": "root"}`
- THEN el sistema responde 422 (validación del enum) y `users.role` no cambia

#### Scenario: El rol no se puede cambiar desde el perfil propio

- GIVEN un `viewer` autenticado
- WHEN intenta `PATCH /auth/me` incluyendo `{"role": "admin"}` en el payload
- THEN el rol del usuario NO cambia (el campo se ignora o se rechaza, comportamiento
  existente de `UserProfileUpdate`)

### Requirement: Jerarquía estricta sobre el rol SOLICITADO

Un actor MUST poder asignar únicamente roles de nivel ESTRICTAMENTE MENOR al propio
(`ROLE_LEVEL`: superadmin 3, admin 2, moderador 1, viewer 0). Asignar un rol de nivel
IGUAL o SUPERIOR al del actor MUST rechazarse con 403. Consecuencia deliberada: un `admin`
promueve como máximo hasta `moderador` y NUNCA a `admin`; solo un `superadmin` crea
admins, y NADIE crea superadmins por esta vía.

Este guard es DISTINTO del guard de jerarquía sobre el rol ACTUAL del target (que ya
existe y también aplica, ver [Requirement: Guards heredados de la gestión de usuarios]):
uno mira a quién se toca, el otro mira en qué se lo convierte. Los dos MUST evaluarse.

#### Scenario: Un admin no puede promover a nadie a admin

- GIVEN un `admin` autenticado y un usuario `viewer`
- WHEN llama a `POST /auth/users/{id}/role` con `{"role": "admin"}`
- THEN el sistema responde 403 con `{"error": ...}`
- AND el usuario objetivo sigue siendo `viewer`

#### Scenario: Un admin no puede promover a nadie a superadmin

- GIVEN un `admin` autenticado y un usuario `viewer`
- WHEN llama a `POST /auth/users/{id}/role` con `{"role": "superadmin"}`
- THEN el sistema responde 403 y el usuario objetivo sigue siendo `viewer`

#### Scenario: Ni siquiera un superadmin puede crear otro superadmin por esta vía

- GIVEN un `superadmin` autenticado y un usuario `admin`
- WHEN llama a `POST /auth/users/{id}/role` con `{"role": "superadmin"}`
- THEN el sistema responde 403 (nivel igual al propio, no estrictamente menor)
- AND el usuario objetivo sigue siendo `admin`

#### Scenario: Un superadmin sí puede asignar el rol admin

- GIVEN un `superadmin` autenticado y un usuario `viewer`
- WHEN llama a `POST /auth/users/{id}/role` con `{"role": "admin"}`
- THEN el sistema responde 204 y el usuario queda como `admin`

#### Scenario: El guard es server-side, no de UI

- GIVEN un `admin` autenticado que construye la request a mano (curl / fetch directo,
  sin pasar por la pantalla de administración)
- WHEN envía `{"role": "admin"}`
- THEN el sistema responde 403 igual (el botón deshabilitado no es el enforcement)

### Requirement: Un superadmin es intocable por un guard dedicado

Nadie MUST poder cambiar el rol de un usuario cuyo rol ACTUAL es `superadmin` — ni un
`admin`, ni otro `superadmin`, ni el propio interesado. El rechazo MUST ser 403 y MUST
provenir de un guard DEDICADO y explícito con su propia excepción de dominio
(`CannotChangeSuperadminRoleError`), NO como efecto lateral emergente del guard general de
jerarquía (`role_level(target) >= role_level(actor)`).

Razón: la regla "a un superadmin no se le toca el rol" debe sobrevivir a un refactor de
`ROLE_LEVEL`. Si dependiera del guard general, alguien que agregue un nivel por encima de
superadmin abriría el agujero sin darse cuenta y sin romper ningún test.

#### Scenario: Un superadmin no puede degradar a otro superadmin

- GIVEN un `superadmin` A autenticado y otro `superadmin` B
- WHEN A llama a `POST /auth/users/{B}/role` con `{"role": "admin"}`
- THEN el sistema responde 403 con `{"error": ...}`
- AND B sigue siendo `superadmin`

#### Scenario: El rechazo viene del guard dedicado, no del general

- GIVEN un `superadmin` A y otro `superadmin` B
- WHEN A intenta cambiarle el rol a B
- THEN la excepción de dominio levantada es la específica de superadmin intocable
  (`CannotChangeSuperadminRoleError`), distinguible de la de jerarquía general
- AND el test que lo verifica MUST afirmar sobre el TIPO de excepción, no solo sobre
  el 403 resultante

#### Scenario: Un admin tampoco puede tocar a un superadmin

- GIVEN un `admin` autenticado y un usuario `superadmin`
- WHEN llama a `POST /auth/users/{id}/role` con cualquier rol
- THEN el sistema responde 403 y el objetivo sigue siendo `superadmin`

### Requirement: Guards heredados de la gestión de usuarios

El cambio de rol MUST reutilizar, sin reordenar, los guards ya establecidos por
desactivar/reactivar: (1) auto-gestión → 409, (2) usuario inexistente → 404, (3) rol
ACTUAL del target de nivel igual o superior al del actor → 403. El orden MUST ser
self → 404 → jerarquía: un actor autenticado siempre existe, así que si el id coincide con
el suyo la causa real es "te estás gestionando a vos mismo", no "no existe".

En particular, NADIE MUST poder cambiarse el rol a sí mismo, ni siquiera un `superadmin`
(contrato de no-lockout: nadie se saca a sí mismo del sistema por error, y nadie se
auto-promueve). El rechazo del auto-cambio MUST ser 409, no 403: un superadmin tiene todo
el permiso del mundo y aun así no puede — es un conflicto con el estado, no una
autorización faltante.

#### Scenario: Nadie puede cambiarse el rol a sí mismo

- GIVEN un `superadmin` autenticado (el rol más alto: ningún guard de jerarquía lo frena)
- WHEN llama a `POST /auth/users/{su propio id}/role` con `{"role": "viewer"}`
- THEN el sistema responde 409 con `{"error": ...}`
- AND su rol sigue siendo `superadmin`

#### Scenario: Un admin tampoco puede auto-promoverse

- GIVEN un `admin` autenticado
- WHEN llama a `POST /auth/users/{su propio id}/role` con `{"role": "superadmin"}`
- THEN el sistema responde 409 (guard de self, que corre ANTES que el de jerarquía sobre
  el rol solicitado)
- AND su rol sigue siendo `admin`

#### Scenario: Usuario inexistente

- GIVEN un `admin` autenticado
- WHEN llama a `POST /auth/users/{uuid que no existe}/role` con un rol válido
- THEN el sistema responde 404 con `{"error": ...}`

#### Scenario: Un admin no puede cambiarle el rol a otro admin

- GIVEN un `admin` autenticado y otro usuario `admin`
- WHEN llama a `POST /auth/users/{id}/role` con `{"role": "viewer"}`
- THEN el sistema responde 403 (rol ACTUAL del target de nivel igual al propio)
- AND el objetivo sigue siendo `admin`

#### Scenario: El orden de los guards no se altera

- GIVEN un `admin` autenticado
- WHEN llama a `POST /auth/users/{su propio id}/role` con `{"role": "superadmin"}`
  (un caso que viola SIMULTÁNEAMENTE self y jerarquía-sobre-rol-solicitado)
- THEN el status es 409 (self gana), no 403

### Requirement: Asignar el rol que el usuario ya tiene es un conflicto explícito

Asignar a un usuario el rol que YA tiene MUST rechazarse con 409 y una excepción de
dominio propia, NO responder 204 en silencio. Mismo criterio que ya aplica la
desactivación de una cuenta ya desactivada y la revocación de una invitación ya aceptada:
rechazo explícito, no un no-op engañoso.

El no-op MUST evaluarse DESPUÉS de los guards de autorización: un actor que no tenía
permiso para tocar a ese usuario recibe el error de permisos, no el de conflicto (no se le
filtra el rol actual del objetivo a través del código de status).

#### Scenario: Asignar el rol actual responde 409

- GIVEN un `admin` autenticado y un usuario con rol `moderador`
- WHEN llama a `POST /auth/users/{id}/role` con `{"role": "moderador"}`
- THEN el sistema responde 409 con `{"error": ...}`
- AND `users.role` sigue en `moderador`

#### Scenario: El 409 de no-op no se filtra a quien no tiene permiso

- GIVEN un `admin` autenticado y otro usuario `admin`
- WHEN llama a `POST /auth/users/{id}/role` con `{"role": "admin"}` (el rol que ese
  usuario ya tiene)
- THEN el sistema responde 403 (jerarquía), NO 409 — el actor no llega a enterarse del
  estado del objetivo

### Requirement: Atomicidad del cambio de rol frente a concurrencia

La lectura del rol actual del objetivo y su `UPDATE` MUST ocurrir dentro de la misma
transacción, sobre la fila ya lockeada con `SELECT ... FOR UPDATE` (mismo mecanismo que
desactivar/reactivar). Dos cambios de rol concurrentes sobre el MISMO usuario MUST
serializarse, y el estado final MUST ser consistente con haberlos aplicado en algún orden
— nunca una lectura sucia ni un guard evaluado sobre un rol que ya cambió.

#### Scenario: Dos cambios concurrentes al mismo rol dejan exactamente un ganador

- GIVEN un usuario con rol `viewer` y dos admins que lanzan simultáneamente
  `POST /auth/users/{id}/role` con `{"role": "moderador"}`
- WHEN ambas requests se procesan
- THEN exactamente una responde 204 y la otra responde 409 (no-op: ve el rol ya escrito
  por la ganadora)
- AND el rol final es `moderador`

#### Scenario: Un cambio concurrente no salta el guard de jerarquía

- GIVEN un usuario `viewer` que otro actor está promoviendo a `admin` en paralelo
- WHEN un `admin` intenta cambiarle el rol
- THEN su guard de jerarquía se evalúa sobre el rol leído bajo lock, no sobre una
  lectura previa a la transacción

### Requirement: El rol efectivo se revalida contra la base en cada request

`get_current_user()` MUST leer el rol del usuario desde la base en CADA request
autenticado y MUST SOBRESCRIBIR con ese valor el campo `role` del `CurrentUser` devuelto.
No alcanza con compararlo contra el claim del JWT: `require_min_role()` autoriza leyendo
`CurrentUser.role`, así que validar el rol de la base y devolver igual el objeto armado
desde el token deja el agujero abierto con todos los tests en verde.

Un cambio de rol MUST ser efectivo en el request SIGUIENTE, no al vencimiento del token
(hoy 1440 minutos). Esto aplica en las DOS direcciones: la degradación quita permisos al
instante y la promoción los otorga al instante, sin re-login.

El rol MUST leerse en la MISMA query que ya resuelve el estado de la cuenta (un solo
round-trip por request, una columna más en el `SELECT` existente — no una query nueva).
La firma de `is_user_active()` MUST NOT cambiar: el método que devuelve estado + rol es
ADITIVO, para no romper los fakes existentes en la suite.

`get_current_user_optional()` MUST heredar este comportamiento por delegación, sin
modificarse. `require_min_role()` MUST NOT modificarse: queda correcto por construcción si
y solo si `get_current_user()` sobrescribe el campo.

#### Scenario: La degradación es efectiva en el request siguiente

- GIVEN un usuario con un token válido emitido con `role="admin"` (sin vencer)
- WHEN un superadmin lo degrada a `viewer` y el usuario hace luego un request a un
  endpoint protegido con `require_min_role(ADMIN)` presentando ESE MISMO token
- THEN el sistema responde 403 (insufficient role)
- AND no hace falta esperar los 1440 minutos de expiración ni un re-login

#### Scenario: La promoción también es efectiva en el request siguiente

- GIVEN un usuario con un token válido emitido con `role="viewer"`
- WHEN un admin lo promueve a `moderador` y el usuario hace luego un request a un
  endpoint protegido con `require_min_role(MODERADOR)` con ese mismo token viejo
- THEN el sistema responde con éxito (el rol de la base manda sobre el claim)

#### Scenario: El `CurrentUser` devuelto lleva el rol de la base, no el del token

- GIVEN un token cuyo claim `role` dice `admin` y una fila en `users` que dice `viewer`
- WHEN se resuelve `get_current_user()`
- THEN el `CurrentUser` devuelto tiene `role == viewer`
- AND este comportamiento es observable sin inspeccionar la implementación (un endpoint
  que expone el rol del usuario autenticado reporta `viewer`)

#### Scenario: Una cuenta desactivada sigue bloqueada igual

- GIVEN un usuario desactivado con cookie `session` vigente
- WHEN hace cualquier request autenticado
- THEN el sistema responde el 401 genérico existente ("not authenticated"), sin
  regresión respecto de user-management
- AND el orden importa: el estado de la cuenta se evalúa igual que hoy, la revalidación
  del rol no lo debilita

#### Scenario: Una fila inexistente sigue produciendo 401

- GIVEN un JWT válido de una cuenta cuya fila en `users` ya no existe
- WHEN presenta ese JWT en un request autenticado
- THEN el sistema responde 401 (comportamiento existente de user-management, preservado)

#### Scenario: Endpoint público con personalización no rompe

- GIVEN un usuario autenticado cuyo rol cambió en la base
- WHEN hace `GET /report` (endpoint público que usa `get_current_user_optional`)
- THEN responde 200 sin 500, con el rol vigente de la base

#### Scenario: `is_user_active()` conserva su firma

- GIVEN los fakes existentes de `is_user_active` en la suite de tests
- WHEN corre la suite completa tras este change
- THEN esos fakes siguen funcionando sin reescribirse (el método nuevo es aditivo)

### Requirement: Matriz de status del endpoint de cambio de rol

El endpoint MUST devolver exactamente estos códigos, y cada uno MUST ser distinguible
del resto por el cliente:

| Situación | Status |
|---|---|
| Cambio aplicado | 204 (sin cuerpo) |
| Sin cookie `session` / token inválido / vencido / cuenta desactivada o inexistente | 401 |
| Rol del actor menor a `admin` | 403 |
| Rol ACTUAL del target de nivel >= al del actor | 403 |
| Target `superadmin` (guard dedicado) | 403 |
| Rol SOLICITADO de nivel >= al del actor | 403 |
| Target inexistente | 404 |
| Auto-cambio de rol | 409 |
| El target ya tiene ese rol | 409 |
| `role` fuera del enum o body inválido | 422 |

El endpoint MUST estar incluido en el sweep parametrizado de endpoints protegidos de la
suite de integración (401 sin sesión, 403 con rol insuficiente), igual que
`deactivate`/`reactivate`. Las métricas del endpoint MUST usar labels LITERALES; el
`user_id` MUST NOT interpolarse en el label (cardinalidad no acotada).

#### Scenario: Sin sesión

- GIVEN un cliente sin cookie `session`
- WHEN llama a `POST /auth/users/{id}/role`
- THEN el sistema responde 401

#### Scenario: Un moderador no puede cambiar roles

- GIVEN un usuario `moderador` autenticado
- WHEN llama a `POST /auth/users/{id}/role` sobre un `viewer`
- THEN el sistema responde 403 (del `require_min_role(ADMIN)` existente)

#### Scenario: Un viewer no puede cambiar roles

- GIVEN un usuario `viewer` autenticado
- WHEN llama a `POST /auth/users/{id}/role` sobre otro `viewer`
- THEN el sistema responde 403

#### Scenario: La métrica no explota en cardinalidad

- GIVEN cualquier request al endpoint
- WHEN se registra la métrica `requests_total`
- THEN el label de endpoint es una cadena literal fija, nunca la ruta con el UUID
  interpolado
