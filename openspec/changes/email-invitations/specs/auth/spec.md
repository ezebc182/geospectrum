# Delta for Auth — Registro por invitación (invitation-only)

## Contexto

Este delta EXTIENDE `openspec/changes/multi-user-auth/specs/auth/spec.md` (spec base de auth) y `openspec/changes/google-oauth/specs/auth/spec.md` (delta de Google OAuth), ambos implementados y en producción. Los requirements de esas specs siguen vigentes salvo los dos que este documento lista explícitamente en **MODIFIED Requirements** (Registro de usuario, y Login/registro vía Google para email nuevo). En particular, los siguientes requirements existentes NO cambian y este delta los referencia como precondiciones:

- **Bootstrap del primer superadmin** (multi-user-auth): la regla "tabla `users` vacía → primer registro es superadmin" se PRESERVA como excepción explícita al cierre del registro, en ambos caminos (password y Google). Es la salvaguarda anti-lockout de ambientes frescos (dev, staging, disaster recovery).
- **Auto-link por email con usuario existente de password** (google-oauth): sigue funcionando sin requerir invitación — el auto-link opera sobre cuentas EXISTENTES, y este delta solo restringe la CREACIÓN de cuentas nuevas.
- **Login indistinto por password o Google para cuentas vinculadas** (google-oauth): sin cambios.
- **Roles jerárquicos** y `require_min_role` (multi-user-auth): los endpoints nuevos de invitaciones reutilizan ese mecanismo con mínimo `admin`.

Regla transversal de este delta: en todo camino de autenticación, el orden de chequeo MUST ser **existencia de cuenta PRIMERO, invitación DESPUÉS**. Ningún usuario ya existente (password, Google, o vinculado) necesita invitación para nada.

## ADDED Requirements

### Requirement: Creación de invitación

El sistema MUST exponer `POST /auth/invitations`, protegido con rol mínimo `admin` (vía el mecanismo `require_min_role` existente), que crea una invitación con `email` y `role` (restringido al enum `UserRole` existente). La respuesta de creación MUST incluir el token de invitación en claro — y esa MUST ser la única vez que el sistema lo devuelve (junto con la respuesta de reenvío, ver Requirement: Reenvío de invitación). La invitación MUST tener una expiración (`expires_at`), con default de 7 días desde la creación. El rol asignado a la invitación MUST NOT ser de nivel superior al rol de quien la crea (un `admin` no puede invitar un `superadmin`).

#### Scenario: Un admin crea una invitación exitosamente

- GIVEN una sesión activa de un usuario con `role="admin"` y que no existe cuenta ni invitación pendiente para `email="invitada@example.com"`
- WHEN se hace `POST /auth/invitations` con `{"email": "invitada@example.com", "role": "viewer"}`
- THEN la respuesta es 201 y el body incluye el `id` de la invitación, el `email`, el `role`, el `expires_at` y el token en claro
- AND el `expires_at` es aproximadamente 7 días posterior al momento de creación
- AND la fila creada registra `invited_by` con el `id` del admin creador

#### Scenario: Un viewer o moderador no puede crear invitaciones

- GIVEN una sesión activa de un usuario con `role="viewer"` (o `role="moderador"`)
- WHEN se hace `POST /auth/invitations` con un payload válido
- THEN la respuesta es 403
- AND no se crea ninguna fila en `invitations`

#### Scenario: Sin sesión no se puede crear invitación

- GIVEN una request sin cookie `session` válida
- WHEN se hace `POST /auth/invitations` con un payload válido
- THEN la respuesta es 401
- AND no se crea ninguna fila en `invitations`

#### Scenario: Un admin no puede invitar con rol superadmin

- GIVEN una sesión activa de un usuario con `role="admin"`
- WHEN se hace `POST /auth/invitations` con `{"email": "otra@example.com", "role": "superadmin"}`
- THEN la respuesta es un rechazo (403 o 422, sin crear la invitación)
- AND un `superadmin` haciendo la misma request SÍ puede crear la invitación con `role="superadmin"`

#### Scenario: Invitación rechazada si el email ya tiene cuenta

- GIVEN una fila existente en `users` con `email="ana@example.com"`
- WHEN un admin hace `POST /auth/invitations` con `{"email": "ana@example.com", "role": "viewer"}`
- THEN la respuesta es 409 con un mensaje que indica que el email ya tiene cuenta
- AND no se crea ninguna fila en `invitations`

#### Scenario: Invitación rechazada si ya existe una pendiente no expirada para el mismo email

- GIVEN una invitación pendiente (no aceptada, no revocada, no expirada) para `email="invitada@example.com"`
- WHEN un admin hace `POST /auth/invitations` con el mismo email
- THEN la respuesta es 409 con un mensaje que indica que ya hay una invitación pendiente (el camino correcto es reenviar o revocar)
- AND no se crea una segunda invitación

### Requirement: Token de invitación almacenado solo como hash

El sistema MUST NOT almacenar el token de invitación en claro: la base MUST guardar únicamente un hash (el token es de alta entropía, generado server-side). El token en claro MUST aparecer solamente en la respuesta de `POST /auth/invitations` y de `POST /auth/invitations/{id}/resend`. Ningún otro endpoint (listado, validación, detalle) MUST exponer ni el token en claro ni su hash.

#### Scenario: La base no contiene el token en claro

- GIVEN una invitación recién creada cuyo token en claro es `T`
- WHEN se consulta directamente la fila en la tabla `invitations`
- THEN ninguna columna contiene el valor `T` en claro
- AND la validación de `T` vía `GET /auth/invitations/validate` sigue resolviendo a esa fila (comparación por hash)

#### Scenario: El listado no expone tokens

- GIVEN al menos una invitación pendiente
- WHEN un admin hace `GET /auth/invitations`
- THEN ningún elemento de la respuesta incluye el token en claro ni el hash del token

### Requirement: Listado de invitaciones con estado

El sistema MUST exponer `GET /auth/invitations`, protegido con rol mínimo `admin`, que lista las invitaciones con un estado derivado: `pending` (no aceptada, no revocada, no expirada), `accepted`, `revoked`, o `expired` (no aceptada, no revocada, con `expires_at` en el pasado). La expiración MUST evaluarse al momento de la consulta — no existe un job que marque expiradas.

#### Scenario: El listado refleja los cuatro estados

- GIVEN cuatro invitaciones: una pendiente vigente, una aceptada, una revocada, y una pendiente cuyo `expires_at` ya pasó
- WHEN un admin hace `GET /auth/invitations`
- THEN la respuesta incluye las cuatro, con estados `pending`, `accepted`, `revoked` y `expired` respectivamente
- AND cada elemento incluye al menos `email`, `role`, `expires_at`, estado y quién la creó

#### Scenario: Un viewer no puede listar invitaciones

- GIVEN una sesión activa de un usuario con `role="viewer"`
- WHEN se hace `GET /auth/invitations`
- THEN la respuesta es 403

### Requirement: Revocación de invitación

El sistema MUST exponer `DELETE /auth/invitations/{id}`, protegido con rol mínimo `admin`, que revoca una invitación pendiente. Una invitación revocada MUST NOT poder validarse ni consumirse, aunque su `expires_at` esté en el futuro. Una invitación ya aceptada MUST NOT poder revocarse (la revocación no desactiva cuentas ya creadas — la gestión de usuarios existentes está fuera de alcance).

#### Scenario: Revocar una invitación pendiente

- GIVEN una invitación pendiente vigente con token en claro `T`
- WHEN un admin hace `DELETE /auth/invitations/{id}`
- THEN la respuesta es exitosa y el estado de la invitación pasa a `revoked`
- AND una request posterior a `GET /auth/invitations/validate?token=T` responde que el token no es válido
- AND un `POST /auth/register` posterior con `invitation_token=T` es rechazado sin crear usuario

#### Scenario: No se puede revocar una invitación ya aceptada

- GIVEN una invitación con estado `accepted` (ya consumida por un registro)
- WHEN un admin hace `DELETE /auth/invitations/{id}`
- THEN la respuesta es 409 con un mensaje claro
- AND el usuario creado a partir de esa invitación sigue pudiendo hacer login normalmente

### Requirement: Reenvío de invitación con regeneración de token

El sistema MUST exponer `POST /auth/invitations/{id}/resend`, protegido con rol mínimo `admin`, que regenera el token y la expiración de una invitación pendiente o expirada (no aceptada, no revocada). El token anterior MUST quedar invalidado en el mismo acto. La respuesta MUST incluir el nuevo token en claro (única vez, igual que en la creación). Una invitación aceptada o revocada MUST NOT poder reenviarse.

#### Scenario: Reenviar invalida el link anterior

- GIVEN una invitación pendiente con token en claro `T1`
- WHEN un admin hace `POST /auth/invitations/{id}/resend`
- THEN la respuesta incluye un token nuevo `T2` distinto de `T1` y un `expires_at` renovado
- AND `GET /auth/invitations/validate?token=T1` responde que el token no es válido
- AND `GET /auth/invitations/validate?token=T2` responde con el `email` y `role` de la invitación

#### Scenario: Reenviar una invitación expirada la revive con token nuevo

- GIVEN una invitación no aceptada y no revocada cuyo `expires_at` ya pasó (estado `expired`)
- WHEN un admin hace `POST /auth/invitations/{id}/resend`
- THEN la invitación vuelve a estado `pending` con token nuevo y expiración futura
- AND el token nuevo permite completar el registro normalmente

#### Scenario: No se puede reenviar una invitación aceptada o revocada

- GIVEN una invitación con estado `accepted` (o `revoked`)
- WHEN un admin hace `POST /auth/invitations/{id}/resend`
- THEN la respuesta es 409
- AND no se regenera ningún token

### Requirement: Validación pública del token de invitación

El sistema MUST exponer `GET /auth/invitations/validate?token=...`, público (sin autenticación), que para un token válido (pendiente, no expirado, no revocado, no aceptado) responde el `email` y el `role` asociados a la invitación — y nada más (sin `id` interno de la invitación, sin datos del invitador, sin token/hash). La validación MUST NOT consumir la invitación: validarla N veces la deja igual de pendiente. Para un token inválido por cualquier causa (inexistente, expirado, revocado, ya aceptado), la respuesta MUST indicar que el token no es válido sin distinguir la causa exacta (no filtrar si un token existió o no).

#### Scenario: Token válido devuelve email y rol

- GIVEN una invitación pendiente vigente para `email="invitada@example.com"` con `role="moderador"` y token en claro `T`
- WHEN se hace `GET /auth/invitations/validate?token=T` sin ninguna cookie de sesión
- THEN la respuesta es 200 con `{"email": "invitada@example.com", "role": "moderador"}` (y opcionalmente `expires_at`)
- AND la invitación sigue en estado `pending` (validar no consume)

#### Scenario: Token expirado, revocado, aceptado o inexistente responden igual

- GIVEN cuatro tokens: uno de invitación expirada, uno de invitación revocada, uno de invitación ya aceptada, y una cadena aleatoria que nunca fue token
- WHEN se hace `GET /auth/invitations/validate?token=...` con cada uno
- THEN las cuatro respuestas indican token no válido con el mismo status code y el mismo shape de error
- AND ninguna respuesta revela cuál de las causas aplica

### Requirement: Consumo single-use y transaccional de la invitación

El consumo de una invitación (marcarla aceptada y crear el usuario) MUST ser atómico y single-use: la marca de aceptación y la creación de la fila en `users` MUST ocurrir en la misma transacción, con una condición de guarda sobre el estado pendiente (patrón `UPDATE ... WHERE ... AND accepted_at IS NULL RETURNING` o equivalente), de modo que ante requests concurrentes exactamente una gane. Esto aplica a AMBOS caminos de consumo: `POST /auth/register` y el callback de Google. Este comportamiento MUST verificarse contra la base real, no con mocks.

#### Scenario: Dos registros concurrentes con el mismo token — solo uno gana

- GIVEN una invitación pendiente vigente con token `T` para `email="invitada@example.com"`
- WHEN dos requests `POST /auth/register` con `invitation_token=T` llegan concurrentemente
- THEN exactamente una responde con éxito y crea la única fila en `users` para ese email
- AND la otra responde con rechazo (token ya consumido) sin crear fila
- AND la tabla `users` queda con exactamente una fila para `invitada@example.com` y la invitación con estado `accepted`

#### Scenario: Aceptación por password y por Google en paralelo — solo un camino gana

- GIVEN una invitación pendiente vigente con token `T` para `email="invitada@example.com"`
- WHEN llega concurrentemente un `POST /auth/register` con `invitation_token=T` y un callback de Google (`GET /auth/google/callback`) cuyo ID token resuelve `email="invitada@example.com"` con `email_verified=true`
- THEN exactamente uno de los dos caminos crea la cuenta y consume la invitación
- AND el otro no crea una segunda fila en `users`
- AND la invitación queda con estado `accepted` una sola vez

#### Scenario: Fallo posterior en la transacción no quema la invitación

- GIVEN una invitación pendiente vigente con token `T`
- WHEN un intento de consumo falla después de marcar la aceptación pero antes de confirmar la creación del usuario (ej. violación de constraint en `users`)
- THEN la transacción completa se revierte: no queda usuario creado Y la invitación sigue en estado `pending`
- AND un reintento posterior con el mismo token `T` puede completar el registro

### Requirement: Registro con invitación asigna el rol de la invitación y valida el email

Cuando `POST /auth/register` se ejecuta con un `invitation_token` válido, el rol del usuario creado MUST ser el `role` de la invitación — nunca un rol enviado por el cliente en el payload (que MUST ignorarse o rechazarse). El `email` del payload MUST coincidir (case-insensitive) con el `email` de la invitación; si no coincide, el registro MUST rechazarse sin consumir la invitación.

#### Scenario: Registro exitoso con invitación hereda el rol invitado

- GIVEN una invitación pendiente vigente para `email="mod@example.com"` con `role="moderador"` y token `T`, y la tabla `users` con al menos una fila
- WHEN se hace `POST /auth/register` con `{"email": "mod@example.com", "password": "Sismo2026!", "invitation_token": "T"}`
- THEN la respuesta es 201 y el usuario creado tiene `role="moderador"`
- AND la invitación queda `accepted` y registra qué usuario la consumió
- AND un `POST /auth/login` posterior con esas credenciales funciona y `GET /auth/me` devuelve `role="moderador"`

#### Scenario: El payload no puede pisar el rol de la invitación

- GIVEN una invitación pendiente vigente para `email="v@example.com"` con `role="viewer"` y token `T`
- WHEN se hace `POST /auth/register` con `{"email": "v@example.com", "password": "Sismo2026!", "invitation_token": "T", "role": "superadmin"}`
- THEN si el registro procede, el usuario creado tiene `role="viewer"` (el de la invitación)
- AND en ningún caso se crea un usuario con `role="superadmin"`

#### Scenario: Registro rechazado si el email no coincide con el de la invitación

- GIVEN una invitación pendiente vigente para `email="invitada@example.com"` con token `T`
- WHEN se hace `POST /auth/register` con `{"email": "otra-persona@example.com", "password": "Sismo2026!", "invitation_token": "T"}`
- THEN la respuesta es un rechazo con mensaje claro
- AND no se crea ninguna fila en `users`
- AND la invitación sigue en estado `pending` (no se consumió)

### Requirement: Persistencia del estado de onboarding

El sistema MUST agregar la columna nullable `users.onboarding_completed_at` y exponerla en la respuesta de `GET /auth/me`. El sistema MUST exponer `POST /auth/me/onboarding-complete` (cualquier usuario autenticado, sin restricción de rol) que setea `onboarding_completed_at` al timestamp actual. El endpoint MUST ser idempotente: llamadas repetidas no fallan y no pisan el timestamp original.

#### Scenario: Usuario nuevo tiene onboarding pendiente

- GIVEN un usuario recién creado (por invitación, por cualquier camino)
- WHEN hace `GET /auth/me` con su cookie de sesión
- THEN la respuesta incluye `"onboarding_completed_at": null`

#### Scenario: Completar onboarding persiste y es idempotente

- GIVEN un usuario autenticado con `onboarding_completed_at IS NULL`
- WHEN hace `POST /auth/me/onboarding-complete` y luego lo repite una segunda vez
- THEN ambas respuestas son exitosas
- AND `GET /auth/me` devuelve un `onboarding_completed_at` no nulo cuyo valor corresponde a la PRIMERA llamada
- AND no requiere rol `admin` — un `viewer` puede hacerlo

#### Scenario: Sin sesión no se puede marcar onboarding

- GIVEN una request sin cookie `session` válida
- WHEN se hace `POST /auth/me/onboarding-complete`
- THEN la respuesta es 401

### Requirement: No-lockout — ningún usuario existente ni el bootstrap se ven afectados

El cierre del registro MUST NOT afectar a ningún usuario ya existente ni a la regla de bootstrap. Concretamente: (a) el login por password de cuentas existentes sigue igual; (b) el login por Google de cuentas existentes sigue igual, incluido el auto-link por email sobre cuentas de password existentes, SIN requerir invitación; (c) con la tabla `users` vacía, el primer registro (por password O por Google) sigue produciendo el superadmin de bootstrap SIN invitación; (d) el único camino que se cierra es la creación de cuenta nueva sin invitación en un sistema no vacío. El orden de chequeo MUST ser: existencia de cuenta PRIMERO, invitación DESPUÉS.

#### Scenario: No-lockout (1) — usuario existente de password se loguea igual que siempre

- GIVEN una fila existente en `users` con `email="dario@example.com"` y `password_hash` no nulo, creada antes de este change, y CERO invitaciones en el sistema
- WHEN se hace `POST /auth/login` con `{"email": "dario@example.com", "password": "<password correcto>"}`
- THEN la respuesta es 200 y emite la cookie `session`, idéntico al comportamiento previo a este change
- AND en ningún momento se consulta ni exige una invitación

#### Scenario: No-lockout (2) — usuario existente de Google se loguea igual, y el auto-link sigue intacto

- GIVEN una fila existente en `users` con `email="carla@example.com"` y `google_id` no nulo, y otra fila con `email="ana@example.com"`, `password_hash` no nulo y `google_id IS NULL` — ambas sin ninguna invitación asociada
- WHEN Carla completa el callback de Google con `email_verified=true`, y luego Ana completa el callback de Google por primera vez con `email_verified=true`
- THEN Carla recibe su cookie `session` sobre su fila existente, sin crear filas nuevas
- AND la fila de Ana queda auto-vinculada (`google_id` seteado) y recibe cookie `session`, exactamente como especifica el Requirement "Auto-link por email" de `google-oauth` — sin exigir invitación en ninguno de los dos casos

#### Scenario: No-lockout (3) — tabla users vacía: bootstrap de superadmin sin invitación

- GIVEN la tabla `users` sin ninguna fila y la tabla `invitations` sin ninguna fila
- WHEN se hace `POST /auth/register` con `{"email": "primera@example.com", "password": "Sismo2026!"}` SIN `invitation_token`
- THEN la respuesta es 201 y el usuario creado tiene `role="superadmin"` (misma regla de conteo/transacción de `AuthService._determine_bootstrap_role` — no una copia paralela)
- AND el mismo comportamiento aplica si en lugar de register el primer acceso es un callback de Google con `email_verified=true`: se crea el superadmin de bootstrap sin invitación (preservando el Requirement "Bootstrap del primer superadmin vía Google" de `google-oauth`)

#### Scenario: No-lockout (4) — Google sin cuenta y sin invitación es rechazado con mensaje claro

- GIVEN la tabla `users` con al menos una fila, ninguna fila en `users` con `email="intrusa@example.com"`, y ninguna invitación pendiente para ese email
- WHEN se completa `GET /auth/google/callback` con un ID token válido cuyo `email="intrusa@example.com"` y `email_verified=true`
- THEN la respuesta es un redirect (302) a `/login` con un parámetro de error que el frontend puede traducir a "necesitás una invitación para crear una cuenta"
- AND no se emite cookie `session`
- AND no se crea ni modifica ninguna fila en `users` ni en `invitations`
- AND el servidor no responde 500 (el rechazo viaja como redirect, no como JSON, porque el callback es un flujo de navegación)

## MODIFIED Requirements

### Requirement: Registro de usuario

(Modifica el Requirement "Registro de usuario" de `openspec/changes/multi-user-auth/specs/auth/spec.md`. Previamente: `POST /auth/register` abierto — cualquier email podía crear cuenta `viewer`.)

`POST /auth/register` MUST exigir un campo `invitation_token` correspondiente a una invitación pendiente, no expirada y no revocada, cuyo email coincida con el del payload — con UNA única excepción: cuando la tabla `users` está vacía (bootstrap, ver Requirement: No-lockout, escenario 3). Fuera del caso bootstrap, un register sin token, con token inválido, expirado, revocado o ya consumido MUST rechazarse sin crear usuario y sin revelar si el token existió alguna vez. Las validaciones existentes (formato de email, política de password, email duplicado) siguen vigentes sin cambios y se evalúan además de la invitación.

#### Scenario: Registro sin token es rechazado en un sistema no vacío

- GIVEN la tabla `users` con al menos una fila
- WHEN se hace `POST /auth/register` con `{"email": "nueva@example.com", "password": "Sismo2026!"}` sin `invitation_token`
- THEN la respuesta es un rechazo (4xx) con mensaje claro de que el registro es solo por invitación
- AND no se crea ninguna fila en `users`

#### Scenario: Registro con token expirado es rechazado

- GIVEN una invitación para `email="tarde@example.com"` con token `T` y `expires_at` en el pasado
- WHEN se hace `POST /auth/register` con `{"email": "tarde@example.com", "password": "Sismo2026!", "invitation_token": "T"}`
- THEN la respuesta es un rechazo con mensaje claro
- AND no se crea ninguna fila en `users`
- AND la invitación puede reenviarse después (`resend`) para completar el alta con un token nuevo

#### Scenario: Registro con token ya consumido es rechazado

- GIVEN una invitación con estado `accepted` cuyo token en claro fue `T`
- WHEN se hace `POST /auth/register` con `invitation_token=T` (mismo email de la invitación)
- THEN la respuesta es un rechazo
- AND la tabla `users` no gana una segunda fila para ese email

### Requirement: Login/registro vía Google para email nuevo

(Modifica el Requirement "Login/registro vía Google para email nuevo" de `openspec/changes/google-oauth/specs/auth/spec.md`. Previamente: cualquier email nuevo con `email_verified=true` creaba cuenta `viewer`.)

Cuando el `email` del ID token de Google no coincide con ninguna fila existente en `users` y la tabla `users` no está vacía, el sistema MUST crear la cuenta ÚNICAMENTE si existe una invitación pendiente, no expirada y no revocada para ese email (comparación case-insensitive). En ese caso MUST consumir la invitación (mismo consumo transaccional single-use del Requirement correspondiente) y asignar al usuario el `role` de la invitación — no `viewer` por default. El resto del contrato original se preserva: `google_id` seteado al `sub`, `password_hash IS NULL`, misma cookie `session` httpOnly, y `email_verified=true` como condición obligatoria. Sin invitación válida, aplica el rechazo del Requirement: No-lockout, escenario 4.

#### Scenario: Google con invitación pendiente crea la cuenta con el rol invitado

- GIVEN la tabla `users` con al menos una fila, ninguna cuenta para `email="geo@example.com"`, y una invitación pendiente vigente para ese email con `role="admin"`
- WHEN se completa `GET /auth/google/callback` con un ID token cuyo `email="geo@example.com"` y `email_verified=true`
- THEN se crea una fila en `users` con `email="geo@example.com"`, `google_id` seteado, `password_hash IS NULL` y `role="admin"` (el de la invitación)
- AND la invitación queda con estado `accepted`
- AND la respuesta emite la cookie `session` httpOnly cuyo claim `role` es `"admin"`, y redirige al dashboard

#### Scenario: Google con invitación expirada es rechazado sin crear cuenta

- GIVEN ninguna cuenta para `email="tarde@example.com"` y una invitación para ese email con `expires_at` en el pasado
- WHEN se completa el callback de Google con `email="tarde@example.com"` y `email_verified=true`
- THEN la respuesta es un redirect a `/login` con parámetro de error claro
- AND no se emite cookie `session`, no se crea fila en `users`, y la invitación NO pasa a `accepted`

#### Scenario: Google con email no verificado no consume la invitación

- GIVEN una invitación pendiente vigente para `email="sinverificar@example.com"` y ninguna cuenta para ese email
- WHEN se completa el callback de Google con `email="sinverificar@example.com"` pero `email_verified=false`
- THEN el login se rechaza (redirect a `/login` con error), igual que en la spec de `google-oauth`
- AND la invitación sigue en estado `pending` (podrá usarse después por password o por un login de Google verificado)
