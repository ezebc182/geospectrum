# Delta for Auth — Locale en beta signups y emails de beta por idioma

## Contexto

Este delta EXTIENDE `openspec/changes/email-invitations/specs/auth/spec.md` (invitaciones invitation-only, ya implementado en el branch `feat/email-invitations`) y el flujo de beta existente en el backend (`POST /beta-signups` público con honeypot y rate limit; `GET /beta-signups` y `POST /beta-signups/{id}/approve` admin+; emails de beta en `src/services/email_service.py`, hoy con español hardcodeado). Las invitaciones YA tienen `invitations.locale` (migración 010) y sus emails ya son bilingües; lo que falta — y este delta especifica — es que la CADENA DE BETA sea consciente del idioma: el signup captura el locale elegido en la landing, los emails al interesado salen en ese idioma, y la invitación derivada de la aprobación lo hereda.

Fuera de alcance (decisión cerrada del usuario, 2026-08-12): internacionalizar los `detail=` de error de la API FastAPI — el cliente arma sus propios mensajes y esos se traducen en el delta `dashboard-ui`.

Ningún requirement de `email-invitations` se modifica ni remueve; en particular se PRESERVAN intactos: no-enumeración del alta de beta (respuesta 201 idéntica para email nuevo o repetido), honeypot y rate limit, idempotencia de la aprobación, invariante "una sola invitación pendiente vigente por email", y el envío de emails DESPUÉS del commit (un Resend caído no deshace nada persistido).

## ADDED Requirements

### Requirement: Captura del locale en el alta de beta

El sistema MUST agregar la columna `beta_signups.locale` (valores `es` | `en`, `NOT NULL DEFAULT 'es'`, migración SQL manual patrón `0NN_*.sql` con rollback documentado). `POST /beta-signups` MUST aceptar un campo opcional `locale` en el payload y persistirlo con el alta. Un `locale` ausente o con valor no soportado MUST tratarse como `es` — tolerante, sin 400 (mismo criterio que `dashboard/app/api/invitations/send/route.ts`: un caller viejo sin el campo sigue funcionando). El contrato público del endpoint no cambia en nada más: honeypot, rate limit y respuesta anti-enumeración quedan idénticos. En un repost del mismo email (conflicto), el locale ya guardado MUST NOT sobreescribirse (el repost no reenvía emails ni muta el alta, como hoy).

#### Scenario: Alta desde la landing en inglés persiste el locale

- GIVEN la landing pública en inglés
- WHEN el visitante envía el formulario de beta y llega `POST /beta-signups` con `{"email": "fan@example.com", "locale": "en"}`
- THEN la respuesta es el 201 anti-enumeración de siempre
- AND la fila de `beta_signups` para ese email tiene `locale = 'en'`

#### Scenario: Caller sin locale o con valor inválido cae a español

- GIVEN dos requests a `POST /beta-signups`: una sin campo `locale` y otra con `{"locale": "xx"}`
- WHEN el backend las procesa
- THEN ambas responden 201 (ningún 400 por el locale)
- AND ambas filas quedan con `locale = 'es'`

#### Scenario: El repost no pisa el locale original

- GIVEN una fila existente en `beta_signups` para `fan@example.com` con `locale = 'en'`
- WHEN llega un segundo `POST /beta-signups` para el mismo email con `{"locale": "es"}`
- THEN la respuesta es el mismo 201 anti-enumeración
- AND la fila conserva `locale = 'en'` y no se reenvía ningún email (comportamiento de repost existente)

### Requirement: Emails de beta al interesado en su idioma

Los emails que el sistema envía AL INTERESADO en la cadena de beta MUST salir en el `locale` de su fila de `beta_signups`: (a) el email de confirmación de alta en la lista de espera, y (b) el email de aprobación ("tu acceso está listo"). En ambos, subject y cuerpo MUST estar en ese idioma. El aviso interno al admin ("nuevo interesado") MAY permanecer en español — es tooling interno, no superficie del usuario. La resiliencia existente se preserva: una falla de envío MUST NOT deshacer el alta ni la aprobación ya persistidas.

#### Scenario: Confirmación de lista de espera en inglés

- GIVEN un alta nueva de beta con `locale = 'en'`
- WHEN el sistema dispara los emails post-alta
- THEN el email al interesado tiene subject y cuerpo en inglés
- AND el mismo alta con `locale = 'es'` habría producido el email en español (contenido equivalente, mismo template parametrizado por idioma)

#### Scenario: Email de aprobación en el idioma del signup

- GIVEN una fila de `beta_signups` con `email = "fan@example.com"` y `locale = 'en'`, sin aprobar
- WHEN un admin hace `POST /beta-signups/{id}/approve`
- THEN el email de aprobación enviado a `fan@example.com` tiene subject y cuerpo en inglés, con el mismo link a `/login` de siempre
- AND la aprobación queda persistida aunque el envío falle (email post-commit, comportamiento existente)

### Requirement: La invitación derivada de la aprobación hereda el locale

Cuando `POST /beta-signups/{id}/approve` crea la invitación (rol `viewer`, flujo existente), la invitación MUST crearse con `invitations.locale` igual al `locale` del beta signup — no con el default `es`. Con eso, toda la cadena aguas abajo que ya es bilingüe por `invitations.locale` (página `/invite`, siembra del idioma del primer login — ver delta `dashboard-ui`) queda automáticamente en el idioma que la persona eligió en la landing. La idempotencia existente se preserva: re-aprobar no crea invitaciones duplicadas ni modifica el locale de una invitación pendiente ya creada.

#### Scenario: Aprobación de un signup EN produce invitación EN

- GIVEN una fila de `beta_signups` con `locale = 'en'` sin aprobar y sin invitación pendiente para ese email
- WHEN un admin la aprueba
- THEN la invitación creada tiene `locale = 'en'`, `role = 'viewer'` y la expiración de siempre
- AND cuando esa persona entre por primera vez, su experiencia inicial es en inglés (cascada del delta `dashboard-ui`)

#### Scenario: Re-aprobar no muta la invitación existente

- GIVEN un signup con `locale = 'en'` ya aprobado, cuya invitación pendiente tiene `locale = 'en'`
- WHEN un admin vuelve a aprobar el mismo signup
- THEN la respuesta indica `already_approved` y no se crea una segunda invitación
- AND la invitación existente conserva `locale = 'en'` intacto
