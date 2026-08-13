# Delta for Auth (user-management)

Delta sobre el dominio auth existente (multi-user-auth, google-oauth,
email-invitations). Convención heredada: errores de negocio como
`{"error": "..."}` con status explícito; métricas `requests_total` por
endpoint/status; mensajes de login no-enumerantes.

## ADDED Requirements

### Requirement: Desactivación de cuenta (soft-delete)

El sistema MUST permitir marcar una cuenta como desactivada sin borrar ninguna fila:
`users.deactivated_at TIMESTAMPTZ` nullable, donde `NULL` significa cuenta activa y un
timestamp significa desactivada desde ese momento. La desactivación MUST ser reversible
(reactivar = volver a `NULL`) y MUST NOT alterar email, rol, password_hash, google_id ni
ningún otro dato de la cuenta.

#### Scenario: Desactivar una cuenta activa

- GIVEN un admin autenticado y un usuario `viewer` activo
- WHEN el admin llama a `POST /auth/users/{id}/deactivate`
- THEN el sistema responde 204
- AND `users.deactivated_at` queda seteado a `now()` para ese usuario
- AND el resto de las columnas del usuario no cambian

#### Scenario: Desactivar una cuenta ya desactivada es rechazado explícitamente

- GIVEN un usuario ya desactivado
- WHEN un admin llama a `POST /auth/users/{id}/deactivate` sobre él
- THEN el sistema responde 409 con `{"error": ...}`
- AND `deactivated_at` conserva su timestamp ORIGINAL (no se pisa)

(Mismo criterio que la revocación de una invitación aceptada: rechazo explícito, no un
no-op engañoso.)

#### Scenario: Desactivar un usuario inexistente

- GIVEN un admin autenticado
- WHEN llama a `POST /auth/users/{id}/deactivate` con un UUID que no existe en `users`
- THEN el sistema responde 404 con `{"error": ...}`

### Requirement: Reactivación de cuenta

El sistema MUST permitir reactivar una cuenta desactivada (`deactivated_at` vuelve a
`NULL`), restaurando el acceso completo por todos los caminos de login. Reactivar una
cuenta que ya está activa MUST ser rechazado con 409 (simetría con el 409 de
desactivar-dos-veces).

#### Scenario: Reactivar restaura el login

- GIVEN un usuario desactivado
- WHEN un admin llama a `POST /auth/users/{id}/reactivate` y responde 204
- AND el usuario intenta luego `POST /auth/login` con credenciales correctas
- THEN el login emite la cookie `session` normalmente, igual que antes de la
  desactivación

#### Scenario: Reactivar una cuenta activa

- GIVEN un usuario activo
- WHEN un admin llama a `POST /auth/users/{id}/reactivate` sobre él
- THEN el sistema responde 409 con `{"error": ...}`

### Requirement: Guards de jerarquía y de auto-desactivación

Los endpoints de desactivar/reactivar MUST exigir `require_min_role(ADMIN)` (401 sin
sesión, 403 para viewer/moderador). Además, el actor MUST NOT poder desactivar ni
reactivar a un usuario de rol de nivel IGUAL O SUPERIOR al propio (`ROLE_LEVEL`,
comparación estricta: solo gestiona niveles estrictamente por debajo), y MUST NOT poder
desactivarse a sí mismo. La violación de jerarquía responde 403; la auto-desactivación
responde 409. Estos guards MUST aplicarse server-side (la UI deshabilitando botones no
es el mecanismo de seguridad).

Nota de diseño derivada: como nadie puede actuar sobre un rol igual o superior, un
superadmin es inalcanzable por estos endpoints — el guard de "último superadmin"
(existente en `DELETE /account`) no es necesario acá por construcción.

#### Scenario: Un moderador no puede desactivar a nadie

- GIVEN un usuario `moderador` autenticado
- WHEN llama a `POST /auth/users/{id}/deactivate` sobre un `viewer`
- THEN el sistema responde 403 (insufficient role, del `require_min_role` existente)

#### Scenario: Un admin no puede desactivar a otro admin ni a un superadmin

- GIVEN un `admin` autenticado
- WHEN llama a `POST /auth/users/{id}/deactivate` sobre otro usuario de rol `admin`
  (o `superadmin`)
- THEN el sistema responde 403 con `{"error": ...}`
- AND el usuario objetivo sigue activo

#### Scenario: Un superadmin puede desactivar a un admin

- GIVEN un `superadmin` autenticado y un `admin` activo
- WHEN llama a `POST /auth/users/{id}/deactivate` sobre ese admin
- THEN el sistema responde 204 y la cuenta queda desactivada

#### Scenario: Nadie puede desactivarse a sí mismo

- GIVEN un `superadmin` autenticado (el rol más alto — ningún guard de jerarquía lo
  frena)
- WHEN llama a `POST /auth/users/{id}/deactivate` con su PROPIO id
- THEN el sistema responde 409 con `{"error": ...}`
- AND su cuenta sigue activa

### Requirement: Bloqueo del login por password para cuentas desactivadas

`POST /auth/login` MUST rechazar a un usuario desactivado ANTES de emitir cualquier
cookie (ni `session` ni la pre-auth de 2FA). El rechazo MUST ser no-enumerante: con
credenciales incorrectas la respuesta sigue siendo el 401 genérico de siempre
(indistinguible de "email no existe"); el 403 explícito de cuenta desactivada MUST
emitirse ÚNICAMENTE cuando la password verificó correcta (solo el dueño legítimo de la
cuenta puede ver ese mensaje).

#### Scenario: Login con password correcta de cuenta desactivada

- GIVEN un usuario desactivado con password válida
- WHEN hace `POST /auth/login` con email y password CORRECTOS
- THEN el sistema responde 403 con `{"error": "account deactivated"}`
- AND no se setea ninguna cookie (`session` ni `pending_2fa_session`)

#### Scenario: Login con password incorrecta de cuenta desactivada no filtra estado

- GIVEN un usuario desactivado
- WHEN alguien hace `POST /auth/login` con ese email y una password INCORRECTA
- THEN el sistema responde el 401 genérico `{"error": "invalid credentials"}`
- AND la respuesta es byte-a-byte indistinguible de la de un email inexistente

#### Scenario: Cuenta desactivada con 2FA habilitado tampoco recibe pre-auth

- GIVEN un usuario desactivado con `totp_enabled = true` y password correcta
- WHEN hace `POST /auth/login`
- THEN el sistema responde 403 (cuenta desactivada), NUNCA `{"requires_2fa": true}`
- AND no se emite la cookie `pending_2fa_session`

### Requirement: Bloqueo del login por Google para cuentas desactivadas

`GET /auth/google/callback` MUST rechazar el login de una cuenta desactivada (resuelta
por google_id o por email/auto-link) redirigiendo a
`/login?error=account_deactivated` — mismo patrón de error-redirect que el resto de las
ramas del callback: sin `Set-Cookie`, sin 500. El rechazo MUST ocurrir ANTES de
cualquier escritura sobre `users` (ni refresco de name/avatar ni auto-link de
google_id para una cuenta desactivada).

#### Scenario: Google login de cuenta desactivada

- GIVEN un usuario desactivado que se registró vía Google
- WHEN completa el consentimiento de Google y llega el callback
- THEN el sistema redirige 302 a `{dashboard_url}/login?error=account_deactivated`
- AND no se setea la cookie `session`
- AND la fila de `users` no se modifica

#### Scenario: Auto-link no se aplica a cuentas desactivadas

- GIVEN un usuario desactivado creado por password (sin `google_id`) con email E
- WHEN llega el callback de Google con email verificado E
- THEN el sistema redirige con `error=account_deactivated`
- AND `users.google_id` sigue en `NULL` (el auto-link no ocurrió)

### Requirement: Invalidación inmediata de sesiones ya emitidas

`get_current_user()` MUST verificar contra la base, en cada request autenticado, que la
cuenta del `sub` del JWT (a) siga existiendo y (b) no esté desactivada; en caso
contrario MUST responder el 401 genérico existente ("not authenticated" — sin
distinguir causa, igual que token vencido/corrupto). La desactivación MUST ser efectiva
en el request SIGUIENTE al `deactivate`, no al vencimiento del token (hoy 1440
minutos). `get_current_user_optional()` MUST heredar este comportamiento (usuario
desactivado ⇒ tratado como anónimo), lo que ocurre por construcción porque delega en
`get_current_user()`.

#### Scenario: Sesión viva muere al desactivar la cuenta

- GIVEN un usuario con sesión válida emitida (cookie `session` vigente, JWT sin vencer)
- WHEN un admin lo desactiva y el usuario hace luego cualquier request autenticado
  (ej. `GET /auth/me`)
- THEN el sistema responde 401 `{"detail"/"error": "not authenticated"}` (el shape
  genérico existente de `get_current_user`)

#### Scenario: JWT válido de una cuenta borrada también muere

- GIVEN un usuario que ejecutó `DELETE /account` (o cuya fila ya no existe) pero cuyo
  JWT todavía no venció
- WHEN presenta ese JWT en un request autenticado
- THEN el sistema responde 401 (hoy ese JWT seguiría siendo válido hasta 24 h — este
  requirement cierra ese agujero como efecto del mismo chequeo)

#### Scenario: Endpoint público con personalización trata al desactivado como anónimo

- GIVEN un usuario desactivado con cookie `session` todavía vigente
- WHEN hace `GET /report` (endpoint público que usa `get_current_user_optional`)
- THEN el endpoint responde 200 con el comportamiento de usuario ANÓNIMO (preset por
  defecto), nunca 500 ni personalización de la cuenta desactivada

### Requirement: Listado de usuarios para administración

`GET /auth/users` MUST exigir `require_min_role(ADMIN)` y devolver la lista completa de
usuarios con: id, email, rol, name, avatar_url, si tiene Google vinculado, fecha de
alta y `deactivated_at` (null = activa). El response model MUST NOT poder contener
`password_hash`, `totp_secret` ni ningún secreto, por construcción del tipo (mismo
criterio que `InvitationPublic` respecto de tokens). El listado SHOULD ordenar de forma
estable y útil para el admin (activos primero no es requisito; orden por fecha de alta
descendente es suficiente).

#### Scenario: Un admin lista los usuarios

- GIVEN un `admin` autenticado y usuarios activos y desactivados en la base
- WHEN llama a `GET /auth/users`
- THEN responde 200 con TODOS los usuarios (incluidos superadmins y él mismo)
- AND cada item incluye rol y `deactivated_at` (con timestamp para los desactivados,
  null para los activos)
- AND ningún item contiene password_hash ni secretos

#### Scenario: Un viewer no puede listar usuarios

- GIVEN un `viewer` autenticado
- WHEN llama a `GET /auth/users`
- THEN responde 403 (del `require_min_role(ADMIN)` existente)

#### Scenario: Sin sesión no hay listado

- GIVEN un cliente sin cookie `session`
- WHEN llama a `GET /auth/users`
- THEN responde 401

## MODIFIED Requirements

### Requirement: Login

El login por password conserva su contrato existente (mensaje genérico e
indistinguible entre "email no existe" y "password incorrecto") y AGREGA el bloqueo de
cuentas desactivadas descripto en [Bloqueo del login por password para cuentas
desactivadas]. (Previously: el login solo verificaba existencia + password + 2FA; no
existía el concepto de cuenta desactivada.)

#### Scenario: Login de usuario activo no cambia

- GIVEN un usuario activo con credenciales correctas
- WHEN hace `POST /auth/login`
- THEN el comportamiento es EXACTAMENTE el actual (cookie `session` o flujo 2FA) — sin
  regresión

### Requirement: Manejo de errores del flujo OAuth de Google

La matriz de códigos de error del callback agrega `account_deactivated` a los códigos
existentes (`google_no_invitation`, `google_oauth_cancelled`, etc.), con el mismo
contrato: 302 a `/login?error=<código>`, sin Set-Cookie, nunca 500. (Previously: la
matriz no contemplaba cuentas desactivadas porque el concepto no existía.)

#### Scenario: Código nuevo en la matriz de redirects

- GIVEN el flujo de callback rechaza por cuenta desactivada
- WHEN se construye el redirect
- THEN usa `_google_error_redirect("account_deactivated")` (URL absoluta de
  `settings.dashboard_url`, patrón existente)
