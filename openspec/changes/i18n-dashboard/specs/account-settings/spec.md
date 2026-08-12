# Delta for Account Settings — Preferencia de idioma en la cuenta (`users.locale`)

## Contexto

Este delta EXTIENDE `openspec/specs/account-settings/spec.md` (spec vigente del dominio, fusionada desde el change `account-settings`). Agrega la preferencia de idioma persistida en la cuenta: columna `users.locale`, exposición y edición vía el perfil extendido existente (`GET/PATCH /account/profile`, Requirements "Consulta del perfil extendido propio" y "Edición del perfil extendido propio"). La semántica de esos requirements (PATCH parcial, aislamiento respecto de `/auth/me` y del JWT) se PRESERVA — este delta solo suma un campo.

Cómo se usa la preferencia (cascada cookie → `users.locale` → `Accept-Language` → `es`, selectores de header/Settings) está especificado en el delta `dashboard-ui` de este change; acá se especifica el contrato de datos y API.

## ADDED Requirements

### Requirement: Columna `users.locale` y exposición en el perfil

El sistema MUST agregar la columna nullable `users.locale` (migración SQL manual, patrón `0NN_*.sql` del repo, con rollback documentado en el propio archivo). Los valores permitidos MUST ser `es` y `en` (constraint en la base); `NULL` significa "sin preferencia guardada" y es el estado de toda cuenta preexistente y de toda cuenta nueva que no haya elegido idioma. `GET /account/profile` MUST incluir el campo `locale` en su respuesta. El campo MUST NOT agregarse al JWT de sesión ni a la respuesta de `GET /auth/me` (mismo aislamiento que el resto del perfil extendido).

#### Scenario: Cuenta preexistente sin preferencia

- GIVEN un usuario creado antes de este change, que nunca eligió idioma
- WHEN hace `GET /account/profile`
- THEN la respuesta incluye `"locale": null`
- AND su experiencia de UI se resuelve por el resto de la cascada (cookie, navegador, default `es`) sin error alguno

#### Scenario: El locale no viaja en el JWT ni en /auth/me

- GIVEN un usuario con `users.locale = 'en'`
- WHEN se inspeccionan los claims de su cookie `session` y la respuesta de `GET /auth/me`
- THEN ninguno contiene `locale` (la UI lo obtiene del perfil, no de la sesión)

### Requirement: Edición del locale vía PATCH /account/profile

`PATCH /account/profile` MUST aceptar el campo opcional `locale` con valores `es` o `en`, preservando la semántica parcial existente: un PATCH sin `locale` MUST NOT tocar la preferencia guardada, y un PATCH con `locale` MUST NOT tocar los demás campos del perfil. Un valor no soportado (ej. `fr`, cadena vacía, número) MUST rechazarse con 422 sin modificar nada. El endpoint MUST seguir requiriendo sesión autenticada y operando solo sobre el perfil propio.

#### Scenario: Guardar la preferencia en inglés

- GIVEN un usuario autenticado con `"locale": null` y `full_name` ya cargado
- WHEN hace `PATCH /account/profile` con `{"locale": "en"}`
- THEN la respuesta es exitosa y un `GET /account/profile` posterior devuelve `"locale": "en"`
- AND `full_name` y el resto del perfil quedan intactos

#### Scenario: Valor no soportado es rechazado

- GIVEN un usuario autenticado con `"locale": "en"` guardado
- WHEN hace `PATCH /account/profile` con `{"locale": "fr"}`
- THEN la respuesta es 422
- AND `GET /account/profile` sigue devolviendo `"locale": "en"`

#### Scenario: PATCH de otros campos no pisa la preferencia

- GIVEN un usuario con `"locale": "en"` guardado
- WHEN hace `PATCH /account/profile` con `{"full_name": "Nueva Firma"}` (sin `locale`)
- THEN el nombre se actualiza y `"locale"` sigue siendo `"en"`

### Requirement: La preferencia de cuenta viaja entre dispositivos

La preferencia guardada en `users.locale` MUST ser efectiva en cualquier navegador/dispositivo donde el usuario inicie sesión sin haber elegido idioma explícitamente en ese navegador (eslabón 2 de la cascada del delta `dashboard-ui`): es la garantía de que la elección hecha en un dispositivo no muere con la cookie local.

#### Scenario: Preferencia elegida en un dispositivo aparece en otro

- GIVEN un usuario que en el dispositivo A cambió el idioma a inglés (cookie + `PATCH` con `locale: "en"`)
- WHEN inicia sesión en el dispositivo B, que no tiene cookie de locale
- THEN el dashboard se renderiza en inglés desde el primer render post-login
- AND si en el dispositivo B luego elige explícitamente español, ese navegador queda en español (cookie local) sin deshacer la preferencia hasta que un cambio explícito vuelva a persistirse
