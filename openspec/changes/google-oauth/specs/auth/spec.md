# Delta for Auth — Login/Registro con Google (OAuth)

## Contexto

Este delta EXTIENDE `openspec/changes/multi-user-auth/specs/auth/spec.md` (spec base del sistema de auth actual, ya en `main`). No reemplaza ninguno de sus requirements — todos los requirements de esa spec (Registro de usuario, Login, Logout, `/auth/me`, Roles jerárquicos, Bootstrap del primer superadmin, Expiración de sesión, Cookie de sesión httpOnly, No regresión sobre endpoints existentes) siguen vigentes sin modificación. El Requirement "Bootstrap del primer superadmin" de la spec base se reutiliza tal cual (misma regla de conteo/transacción) para el flujo de Google — no se duplica su texto aquí; los escenarios nuevos abajo verifican que el flujo de Google converge en esa misma regla.

## ADDED Requirements

### Requirement: Login/registro vía Google para email nuevo

El sistema MUST exponer un flujo OAuth 2.0 Authorization Code con Google que, cuando el `email` devuelto por Google en el ID token no coincide con ninguna fila existente en `users`, cree una nueva fila con `google_id` seteado al `sub` del ID token de Google, `password_hash` en `NULL`, y `email` igual al del ID token. El sistema MUST emitir, para este caso, la misma cookie `session` httpOnly que emite `POST /auth/login`, generada con `AuthService.create_access_token()` — no un mecanismo de sesión distinto.

#### Scenario: Registro exitoso vía Google con email nuevo

- GIVEN que no existe ninguna fila en `users` con `email="nueva@example.com"` y que la tabla `users` ya tiene al menos una fila (caso no-bootstrap)
- WHEN el usuario completa el consentimiento de Google en `GET /auth/google/login` y Google redirige a `GET /auth/google/callback` con un `code` válido cuyo ID token resuelve `email="nueva@example.com"` y `email_verified=true`
- THEN se crea una fila nueva en `users` con `email="nueva@example.com"`, `google_id` igual al `sub` del ID token, y `password_hash IS NULL`
- AND la respuesta incluye un header `Set-Cookie` para la cookie `session` con los mismos atributos (`HttpOnly`, `Secure`, `SameSite=Lax`) que los que emite `POST /auth/login`
- AND el valor de la cookie es un JWT válido cuyo claim `sub` coincide con el `id` (UUID interno) del usuario recién creado y cuyo claim `role` coincide con su rol
- AND una request posterior a `GET /auth/me` con esa cookie responde 200 con `{"id": <uuid>, "email": "nueva@example.com", "role": "viewer"}`

### Requirement: Auto-link por email con usuario existente de password

Cuando el `email` del ID token de Google coincide con una fila existente en `users` que tiene `password_hash IS NOT NULL` (usuario creado originalmente por `/auth/register`), el sistema MUST vincular `google_id` a esa fila existente en lugar de crear una fila nueva o rechazar el login, y ÚNICAMENTE si el ID token de Google trae el claim `email_verified=true`. Si `email_verified=false` (o el claim está ausente), el sistema MUST rechazar el login y MUST NOT vincular ni crear ninguna fila.

#### Scenario: Auto-link exitoso con email verificado por Google

- GIVEN una fila existente en `users` con `email="ana@example.com"`, `password_hash` no nulo (creada originalmente vía `/auth/register`) y `google_id IS NULL`
- WHEN se completa el flujo `GET /auth/google/callback` con un ID token cuyo `email="ana@example.com"` y `email_verified=true`
- THEN NO se crea ninguna fila nueva en `users`
- AND la fila existente de `ana@example.com` queda con `google_id` seteado al `sub` del ID token, y su `password_hash` original permanece sin modificar
- AND la respuesta incluye la cookie `session` httpOnly correspondiente a esa misma fila (mismo `id` de usuario y mismo `role` que tenía antes del link)

#### Scenario: Login por Google rechazado cuando el email no está verificado por Google

- GIVEN una fila existente en `users` con `email="bruno@example.com"` y `password_hash` no nulo
- WHEN se completa el flujo `GET /auth/google/callback` con un ID token cuyo `email="bruno@example.com"` pero `email_verified=false`
- THEN el login MUST rechazarse (redirect a `/login` con mensaje de error, sin emitir cookie `session`)
- AND NO se vincula `google_id` a la fila existente de `bruno@example.com`
- AND NO se crea ninguna fila nueva en `users`

### Requirement: Bootstrap del primer superadmin vía Google

Cuando la tabla `users` está vacía (`COUNT(*) = 0`) en el momento de resolver el callback de Google, el sistema MUST asignar `role="superadmin"` a la fila creada, aplicando exactamente la misma regla de bootstrap especificada en `openspec/changes/multi-user-auth/specs/auth/spec.md` (Requirement: Bootstrap del primer superadmin) y la misma lógica de conteo/transacción que usa `AuthService.create_user()` — no un `if/else` paralelo ni un `WHERE` distinto.

#### Scenario: El primer registro del sistema vía Google se convierte en superadmin

- GIVEN que la tabla `users` no tiene ninguna fila
- WHEN el primer usuario del sistema completa el flujo `GET /auth/google/callback` con un ID token válido y `email_verified=true`
- THEN se crea una fila en `users` con `role="superadmin"`, `google_id` seteado y `password_hash IS NULL`
- AND la respuesta emite la cookie `session` cuyo claim `role` es `"superadmin"`
- AND una request posterior a `GET /auth/me` con esa cookie responde `{"id": <uuid>, "email": <email de Google>, "role": "superadmin"}`

#### Scenario: Un registro posterior vía Google siempre crea viewer

- GIVEN que la tabla `users` ya tiene al menos una fila (ej. el `superadmin` del bootstrap, sin importar si fue creado por password o por Google)
- WHEN un usuario nuevo (email no visto antes) completa el flujo `GET /auth/google/callback` con un ID token válido y `email_verified=true`
- THEN la fila creada tiene `role="viewer"`, no `"superadmin"`

### Requirement: Login indistinto por password o Google para cuentas vinculadas

Un usuario cuya fila en `users` tiene tanto `password_hash` no nulo como `google_id` no nulo (por haber pasado por el auto-link, o por haberse registrado por Google y luego —fuera de alcance de este change— haber seteado password) MUST poder autenticarse indistintamente vía `POST /auth/login` (password) o vía `GET /auth/google/login` → `GET /auth/google/callback` (Google), y ambos caminos MUST resolver a la misma fila de usuario (mismo `id`, mismo `role`).

#### Scenario: Usuario vinculado se loguea por password después de haber sido vinculado por Google

- GIVEN una fila en `users` con `email="carla@example.com"`, `password_hash` no nulo y `google_id` no nulo (ya vinculada previamente)
- WHEN se hace `POST /auth/login` con `{"email": "carla@example.com", "password": "<password original>"}`
- THEN la respuesta HTTP es 200 y emite la cookie `session` correspondiente al mismo `id` de usuario que tiene ese `google_id` asociado

#### Scenario: Usuario vinculado se loguea por Google después de haberse logueado antes por password

- GIVEN la misma fila del escenario anterior (`email="carla@example.com"`, `password_hash` y `google_id` ambos no nulos)
- WHEN se completa el flujo `GET /auth/google/callback` con un ID token cuyo `email="carla@example.com"` y `email_verified=true`
- THEN la respuesta HTTP redirige exitosamente y emite la cookie `session` correspondiente al mismo `id` de usuario (no se crea una fila duplicada)

### Requirement: Manejo de errores del flujo OAuth de Google

El sistema MUST manejar de forma explícita, sin producir un 500 no controlado, al menos los siguientes casos de error en `GET /auth/google/callback`: (a) el usuario cancela el consentimiento en Google y Google redirige de vuelta sin parámetro `code`; (b) Google redirige con un parámetro `error` (ej. `access_denied`); (c) el intercambio `authorization code → token` contra Google falla (error de red, código inválido/expirado, `client_id`/`client_secret` incorrectos); (d) el ID token recibido no puede validarse (firma inválida, `iss`/`aud` incorrectos, expirado). En todos estos casos el sistema MUST redirigir al usuario a `/login` con un mensaje de error claro (vía query param o mecanismo equivalente legible por el frontend), y MUST NOT emitir cookie `session` ni crear/modificar ninguna fila en `users`.

#### Scenario: Usuario cancela el consentimiento de Google

- GIVEN un usuario que inició el flujo en `GET /auth/google/login`
- WHEN Google redirige a `GET /auth/google/callback` sin el parámetro `code` (el usuario canceló el consentimiento)
- THEN la respuesta es un redirect a `/login` con un mensaje de error indicando que el login con Google fue cancelado o falló
- AND no se emite cookie `session`
- AND no se crea ni modifica ninguna fila en `users`

#### Scenario: Google devuelve un parámetro de error explícito

- GIVEN un usuario que inició el flujo en `GET /auth/google/login`
- WHEN Google redirige a `GET /auth/google/callback` con `error=access_denied` (u otro valor de error de OAuth) en lugar de `code`
- THEN la respuesta es un redirect a `/login` con un mensaje de error claro
- AND no se emite cookie `session`
- AND no se produce una excepción no controlada (no hay 500)

#### Scenario: El intercambio de token con Google falla

- GIVEN un `code` recibido en `GET /auth/google/callback` que es sintácticamente válido
- WHEN el intercambio `authorization code → access token` contra los endpoints de Google falla (timeout, código ya usado/expirado, o credenciales `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` inválidas)
- THEN la respuesta es un redirect a `/login` con un mensaje de error claro
- AND no se emite cookie `session`
- AND no se crea ni modifica ninguna fila en `users`
- AND el servidor no responde 500

#### Scenario: El ID token de Google no puede validarse

- GIVEN que el intercambio de token contra Google fue exitoso y devolvió un ID token
- WHEN la validación del ID token falla (firma inválida, `iss` distinto de Google, `aud` distinto del `client_id` configurado, o `exp` en el pasado)
- THEN la respuesta es un redirect a `/login` con un mensaje de error claro
- AND no se emite cookie `session`
- AND no se crea ni modifica ninguna fila en `users`

### Requirement: No regresión sobre login/registro por email y password

El flujo existente `POST /auth/register` + `POST /auth/login` (especificado en `openspec/changes/multi-user-auth/specs/auth/spec.md`) MUST seguir funcionando exactamente igual después de este change, sin ningún cambio de contrato (mismos status codes, mismo shape de request/response, misma cookie `session`). Este delta es aditivo: agrega una segunda vía de autenticación, no modifica ni reemplaza la vía existente.

#### Scenario: Registro por password sigue funcionando igual que antes de este change

- GIVEN que no existe ningún usuario con `email="dario@example.com"` y la tabla `users` ya tiene al menos una fila
- WHEN se hace `POST /auth/register` con `{"email": "dario@example.com", "password": "Sismo2026!"}`
- THEN la respuesta HTTP es 201 y el body es `{"id": <uuid>, "email": "dario@example.com", "role": "viewer"}`, igual que en el comportamiento especificado antes de este change
- AND la fila creada tiene `password_hash` no nulo y `google_id IS NULL`

#### Scenario: Login por password sigue funcionando igual que antes de este change

- GIVEN un usuario existente con `email="dario@example.com"` y password `"Sismo2026!"`, sin `google_id` asociado
- WHEN se hace `POST /auth/login` con `{"email": "dario@example.com", "password": "Sismo2026!"}`
- THEN la respuesta HTTP es 200, emite la cookie `session` httpOnly, y el comportamiento es idéntico al especificado en `multi-user-auth/specs/auth/spec.md` (Requirement: Login)

### Requirement: Endpoints OAuth de Google

El sistema MUST exponer `GET /auth/google/login`, que no requiere autenticación previa ni body, y responde con un redirect HTTP (302) hacia el endpoint de autorización de Google (`accounts.google.com/o/oauth2/...`) incluyendo `client_id`, `redirect_uri`, `scope` (al menos `openid email profile`) y un parámetro `state` para mitigar CSRF.

El sistema MUST exponer `GET /auth/google/callback`, que recibe como query params `code` y `state` (o `error` en los casos de fallo del Requirement: Manejo de errores), valida `state` contra el valor emitido en `/auth/google/login`, intercambia el `code` por tokens con Google, valida el ID token, resuelve/crea el usuario según los Requirements anteriores de este documento, y en el caso exitoso responde con un redirect (302) a la aplicación (dashboard autenticado) junto con el header `Set-Cookie` de `session` — el mismo tipo de cookie httpOnly que emite `POST /auth/login`, sin exponer el JWT en la URL de redirect ni en el body.

#### Scenario: GET /auth/google/login redirige a Google con los parámetros correctos

- GIVEN cualquier cliente, autenticado o no
- WHEN se hace `GET /auth/google/login`
- THEN la respuesta HTTP es una redirección (302) cuya URL de destino apunta al endpoint de autorización OAuth de Google
- AND la URL de destino incluye `client_id`, `redirect_uri` apuntando a `/auth/google/callback`, `scope` incluyendo `openid` y `email`, y un parámetro `state`

#### Scenario: GET /auth/google/callback exitoso redirige a la aplicación con la cookie seteada

- GIVEN un `state` previamente emitido por `/auth/google/login` y un `code` válido cuyo intercambio y validación de ID token son exitosos, con `email_verified=true`
- WHEN se hace `GET /auth/google/callback?code=<code>&state=<state>`
- THEN la respuesta HTTP es una redirección (302) hacia la aplicación (dashboard)
- AND la respuesta incluye el header `Set-Cookie` para `session` con los mismos atributos que emite `POST /auth/login` (`HttpOnly`, `Secure`, `SameSite=Lax`)
- AND el JWT de la cookie no aparece en la URL de redirect ni en ningún query param de la respuesta

#### Scenario: GET /auth/google/callback rechaza un state inválido o ausente

- GIVEN que no hay un `state` previamente emitido que coincida con el recibido (ausente, reutilizado, o manipulado)
- WHEN se hace `GET /auth/google/callback?code=<code>&state=<state-invalido>`
- THEN la respuesta es un redirect a `/login` con un mensaje de error claro
- AND no se emite cookie `session`
- AND no se crea ni modifica ninguna fila en `users`
