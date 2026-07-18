# Auth Specification — Autenticación Multi-Usuario con Roles

## Purpose

Especifica el comportamiento del sistema de autenticación multi-usuario introducido por este change: registro, login, logout, consulta del perfil propio (`/auth/me`), semántica de roles (`admin`/`viewer`), expiración de sesión (JWT en cookie httpOnly) y la garantía explícita de no-regresión sobre los endpoints existentes de `src/main.py`, que permanecen públicos.

No existe un `openspec/specs/auth/spec.md` previo (dominio nuevo, confirmado por inspección: no hay concepto de usuario, sesión ni autenticación en el sistema hoy). Este documento se redacta como spec completa (no delta) del dominio `auth`, acotada al alcance de este change según `proposal.md` y a las decisiones técnicas fijadas en `design.md`.

## Requirements

### Requirement: Registro de usuario

El sistema MUST exponer `POST /auth/register` que reciba `email`, `password` y `role` (`admin` | `viewer`, default `viewer`), valide unicidad de `email`, hashee el password con bcrypt antes de persistirlo y devuelva el usuario creado sin el hash del password.

El sistema MUST NOT persistir el password en texto plano bajo ninguna circunstancia.

#### Scenario: Registro exitoso con rol explícito

- GIVEN que no existe ningún usuario con `email="ana@example.com"`
- WHEN se hace `POST /auth/register` con `{"email": "ana@example.com", "password": "Sismo2026!", "role": "admin"}`
- THEN la respuesta HTTP es 201
- AND el body contiene `{"id": <uuid>, "email": "ana@example.com", "role": "admin"}`
- AND el body NO contiene el password ni ningún campo de hash
- AND en la tabla `users` existe una fila con ese `email`, `role="admin"` y `password_hash` distinto del password original

#### Scenario: Registro exitoso sin rol explícito usa el default viewer

- GIVEN que no existe ningún usuario con `email="bruno@example.com"`
- WHEN se hace `POST /auth/register` con `{"email": "bruno@example.com", "password": "OtraClave123!"}` (sin `role`)
- THEN la respuesta HTTP es 201
- AND el `role` del usuario creado es `"viewer"`

#### Scenario: Registro rechazado por email duplicado

- GIVEN que ya existe un usuario con `email="ana@example.com"`
- WHEN se hace `POST /auth/register` con `{"email": "ana@example.com", "password": "OtraClave456!", "role": "viewer"}`
- THEN la respuesta HTTP es 409
- AND el body indica que el email ya está registrado
- AND no se crea ninguna fila nueva en `users`

#### Scenario: Registro rechazado por password que no cumple la política mínima

- GIVEN que no existe ningún usuario con `email="carla@example.com"`
- WHEN se hace `POST /auth/register` con `{"email": "carla@example.com", "password": "123", "role": "viewer"}`
- THEN la respuesta HTTP es 422
- AND el body indica que el password no cumple la longitud mínima requerida (MUST ser al menos 8 caracteres)
- AND no se crea ninguna fila nueva en `users`

#### Scenario: Registro rechazado por email con formato inválido

- GIVEN cualquier estado de la tabla `users`
- WHEN se hace `POST /auth/register` con `{"email": "no-es-un-email", "password": "Sismo2026!", "role": "viewer"}`
- THEN la respuesta HTTP es 422
- AND no se crea ninguna fila nueva en `users`

### Requirement: Login

El sistema MUST exponer `POST /auth/login` que reciba `email` y `password`, valide las credenciales contra el hash almacenado con bcrypt, y en caso de éxito emita un JWT firmado (HS256) en una cookie httpOnly llamada `session`. El sistema MUST NOT revelar en la respuesta de error si el email existe o no (mismo mensaje genérico para email inexistente y para password incorrecto).

#### Scenario: Login exitoso emite cookie de sesión

- GIVEN un usuario existente con `email="ana@example.com"` y password `"Sismo2026!"`
- WHEN se hace `POST /auth/login` con `{"email": "ana@example.com", "password": "Sismo2026!"}`
- THEN la respuesta HTTP es 200
- AND el body contiene `{"id": <uuid>, "email": "ana@example.com", "role": "admin"}`
- AND la respuesta incluye un header `Set-Cookie` para la cookie `session` con atributos `HttpOnly`, `Secure` y `SameSite=Lax`
- AND el valor de la cookie es un JWT válido cuyo claim `sub` coincide con el `id` del usuario y cuyo claim `role` coincide con su rol

#### Scenario: Login rechazado por password incorrecto

- GIVEN un usuario existente con `email="ana@example.com"` y password `"Sismo2026!"`
- WHEN se hace `POST /auth/login` con `{"email": "ana@example.com", "password": "PasswordIncorrecto"}`
- THEN la respuesta HTTP es 401
- AND el body contiene un mensaje de error genérico (`"invalid credentials"`), sin indicar cuál de los dos campos falló
- AND la respuesta NO incluye ningún header `Set-Cookie` de sesión

#### Scenario: Login rechazado por email inexistente

- GIVEN que no existe ningún usuario con `email="fantasma@example.com"`
- WHEN se hace `POST /auth/login` con `{"email": "fantasma@example.com", "password": "CualquierCosa123"}`
- THEN la respuesta HTTP es 401
- AND el body contiene el mismo mensaje de error genérico que el escenario de password incorrecto
- AND la respuesta NO incluye ningún header `Set-Cookie` de sesión

### Requirement: Logout

El sistema MUST exponer `POST /auth/logout` que invalide la cookie de sesión del cliente (expirándola vía `Set-Cookie` con `Max-Age=0`), sin requerir que la sesión sea válida para poder ejecutarse.

#### Scenario: Logout con sesión activa limpia la cookie

- GIVEN un cliente con una cookie `session` válida (obtenida por login previo)
- WHEN se hace `POST /auth/logout` enviando esa cookie
- THEN la respuesta HTTP es 204
- AND la respuesta incluye un header `Set-Cookie` para `session` con `Max-Age=0` (o equivalente de expiración inmediata)
- AND una request posterior a `GET /auth/me` reusando la cookie original (ya expirada por el cliente) responde 401

#### Scenario: Logout sin sesión activa no falla

- GIVEN un cliente sin cookie `session` (nunca hizo login, o ya la perdió)
- WHEN se hace `POST /auth/logout` sin cookie de sesión
- THEN la respuesta HTTP es 204
- AND no se produce ningún error 401/403 ni excepción no controlada

### Requirement: Perfil del usuario autenticado (/auth/me)

El sistema MUST exponer `GET /auth/me`, protegido por `Depends(get_current_user)`, que devuelva `id`, `email` y `role` del usuario autenticado a partir del JWT en la cookie `session`, y MUST responder 401 si no hay sesión válida.

#### Scenario: Usuario autenticado consulta su propio perfil

- GIVEN un cliente con una cookie `session` válida correspondiente a un usuario con `email="ana@example.com"` y `role="admin"`
- WHEN se hace `GET /auth/me` enviando esa cookie
- THEN la respuesta HTTP es 200
- AND el body contiene `{"id": <uuid>, "email": "ana@example.com", "role": "admin"}`

#### Scenario: Usuario no autenticado recibe 401

- GIVEN un cliente sin cookie `session`
- WHEN se hace `GET /auth/me`
- THEN la respuesta HTTP es 401
- AND el body indica que no hay sesión autenticada (`"not authenticated"` o equivalente)

#### Scenario: Cookie con JWT corrupto o con firma inválida recibe 401

- GIVEN un cliente con una cookie `session` cuyo valor es un string arbitrario que no es un JWT válido, o un JWT firmado con una clave distinta a `settings.auth_secret_key`
- WHEN se hace `GET /auth/me`
- THEN la respuesta HTTP es 401
- AND no se levanta ninguna excepción no controlada (500)

### Requirement: Roles admin y viewer

El sistema MUST soportar exactamente dos roles: `admin` y `viewer`. El sistema MUST proveer un mecanismo reusable (`require_role`) capaz de restringir un endpoint a un rol específico, para que endpoints futuros de gestión de usuarios y de las iniciativas dependientes (regiones, dashboards personalizados) puedan exigir `role="admin"` donde corresponda. En el alcance de este change, ningún endpoint de datos existente aplica esta restricción — se especifica el comportamiento del mecanismo en sí, listo para uso futuro.

Un usuario con rol `viewer` MUST poder autenticarse, cerrar sesión y consultar su propio perfil (`/auth/me`) igual que un `admin`. El sistema MUST NOT permitir que un `viewer` se autoasigne el rol `admin` vía `/auth/register` sin que exista un control de quién puede invocar ese registro con `role="admin"` (ver escenario de restricción de auto-registro).

#### Scenario: require_role permite el acceso cuando el rol coincide

- GIVEN un endpoint protegido con `require_role("admin")` y un cliente autenticado como `admin`
- WHEN el cliente invoca ese endpoint
- THEN la request se procesa normalmente (no se levanta 403)

#### Scenario: require_role rechaza con 403 cuando el rol no coincide

- GIVEN un endpoint protegido con `require_role("admin")` y un cliente autenticado como `viewer`
- WHEN el cliente invoca ese endpoint
- THEN la respuesta HTTP es 403
- AND el body indica que el rol del usuario no tiene permiso suficiente

#### Scenario: require_role rechaza con 401 cuando no hay sesión

- GIVEN un endpoint protegido con `require_role("admin")` y un cliente sin cookie `session`
- WHEN el cliente invoca ese endpoint
- THEN la respuesta HTTP es 401 (falta de autenticación se resuelve antes que falta de autorización)

#### Scenario: Viewer puede usar /auth/me igual que admin

- GIVEN un usuario con `role="viewer"` autenticado con una cookie `session` válida
- WHEN se hace `GET /auth/me`
- THEN la respuesta HTTP es 200 y el body refleja `role="viewer"`, sin ninguna restricción adicional respecto a un `admin`

### Requirement: Expiración de sesión

El JWT emitido por `/auth/login` MUST incluir un claim `exp` calculado a partir de `settings.auth_token_expire_minutes` (default 1440 minutos / 24h) y el sistema MUST rechazar con 401 cualquier request a un endpoint protegido cuyo token tenga `exp` en el pasado, sin excepción de gracia.

#### Scenario: Token dentro de su ventana de validez es aceptado

- GIVEN un JWT emitido hace 1 hora con `auth_token_expire_minutes=1440`
- WHEN se hace `GET /auth/me` con ese token en la cookie `session`
- THEN la respuesta HTTP es 200

#### Scenario: Token expirado es rechazado

- GIVEN un JWT válido en su firma pero cuyo claim `exp` corresponde a un instante ya pasado
- WHEN se hace `GET /auth/me` con ese token en la cookie `session`
- THEN la respuesta HTTP es 401
- AND el body distingue (a nivel de causa interna, no necesariamente en el mensaje público) que la causa es expiración y no firma inválida, de forma que sea verificable en tests

#### Scenario: Usuario con sesión expirada debe volver a hacer login

- GIVEN un token expirado
- WHEN el cliente recibe 401 en `/auth/me` y vuelve a hacer `POST /auth/login` con credenciales válidas
- THEN el login exitoso emite un nuevo JWT con un nuevo `exp` recalculado desde el momento actual
- AND requests subsiguientes con la nueva cookie vuelven a ser aceptadas

### Requirement: Cookie de sesión httpOnly

La cookie `session` que transporta el JWT MUST fijarse con el atributo `HttpOnly`, de forma que no sea accesible desde JavaScript ejecutado en el navegador (`document.cookie` no debe exponerla), y MUST fijarse con `Secure` y `SameSite=Lax`.

#### Scenario: La cookie de sesión no es accesible vía document.cookie

- GIVEN un login exitoso que setea la cookie `session`
- WHEN el frontend (o cualquier script en el contexto del navegador) evalúa `document.cookie`
- THEN el string resultante NO contiene la cookie `session` ni su valor (verificable indirectamente: la respuesta `Set-Cookie` del login incluye el atributo `HttpOnly`)

#### Scenario: El cliente HTTP del dashboard sigue funcionando sin leer la cookie manualmene

- GIVEN el cliente de auth del dashboard (`dashboard/lib/auth.ts`) usando `fetch` con `credentials: 'include'`
- WHEN se invoca `getMe()` tras un login exitoso
- THEN la cookie se envía automáticamente por el navegador sin que el código de aplicación necesite leer ni manipular su valor
- AND `getMe()` recibe 200 con el perfil del usuario

### Requirement: No regresión sobre endpoints existentes

Ningún endpoint existente de `src/main.py` (`/health`, `/metrics`, `/report`, `/events`, `/alerts`, `/events/search`, `/ws/spectrogram/{channel}`, `/spectrograms/live-channels`, `/spectrograms/{channel}/history`, `/spectrograms/{city_id}`, `/events/{event_id}/detail`, `/events/{event_id}/rupture`, `/`) MUST requerir autenticación como resultado de este change. Todos MUST seguir respondiendo exactamente igual que antes del change ante requests sin cookie de sesión y sin header `Authorization`.

#### Scenario: Endpoints de datos siguen siendo públicos sin sesión

- GIVEN un cliente sin cookie `session` y sin header `Authorization`
- WHEN se hace `GET /report`, `GET /events`, `GET /alerts`, `GET /health` (cada uno por separado)
- THEN cada respuesta es 200, con el mismo shape de body que tenía antes de este change
- AND ninguna de esas requests es rechazada con 401 o 403

#### Scenario: scripts/seismic-cli.py sigue funcionando sin cambios de código

- GIVEN `scripts/seismic-cli.py` en su versión actual (sin ningún header de autorización, `httpx.Client(timeout=10.0)`)
- WHEN el script invoca `/health`, `/report`, `/events`, `/alerts` contra el backend con este change desplegado
- THEN todas las llamadas responden exitosamente igual que antes del change, sin requerir ninguna modificación del script

## Out of Scope (heredado de la propuesta, no se especifica aquí)

- Recuperación de password por email, verificación de email, 2FA, SSO/OAuth con proveedores externos — no forman parte de este change.
- Roles más granulares que `admin`/`viewer` (por ciudad, por fuente de datos) — quedan fuera de alcance.
- Protección de endpoints existentes de datos sísmicos (`/report`, `/events`, `/alerts`, etc.) — decisión explícita del `design.md` (Decisión 2) de mantenerlos públicos; cualquier cambio futuro a esta decisión requiere un change nuevo.
- Rate limiting sobre `/auth/login` — no fue definido en `design.md` como parte del alcance de este change; no se especifica aquí porque no hay decisión técnica que testear. Si se agrega en una iteración futura, requiere su propio requirement con Given/When/Then.
- Endpoints de gestión de usuarios por parte de un admin (listar, editar rol, deshabilitar usuarios) — no están en el alcance de `design.md`; solo se especifica el mecanismo `require_role` como base reusable para cuando esos endpoints existan.
