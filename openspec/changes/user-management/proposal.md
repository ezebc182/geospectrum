# Proposal: Gestión de usuarios con desactivación/reactivación de cuentas (soft-delete)

## Intent

Hoy NO existe ninguna forma de sacarle el acceso a una cuenta ya creada. La brecha quedó
expuesta por diseño en `email-invitations`: revocar una invitación ya aceptada responde 409
("revocar una invitación consumida no des-crea al usuario" — `src/main.py`,
`revoke_invitation()`). El usuario resultante es un usuario pleno para siempre: no hay
listado de usuarios en el dashboard, no hay endpoint de administración de cuentas, y el
único camino destructivo es `DELETE /account` — que solo puede ejecutar el PROPIO usuario
sobre sí mismo.

Agravante verificado en el código: `get_current_user()` (`src/api/deps.py`) resuelve la
identidad SOLO del JWT, sin round-trip a la base, y el token dura
`auth_token_expire_minutes = 1440` (24 horas, `src/config/settings.py:98`). Incluso si
mañana se borrara la fila de `users` a mano en la base, la sesión emitida seguiría siendo
válida hasta 24 horas más.

Decisiones del usuario ya tomadas (2026-08-12, no reabrir):

1. Sección **/admin/users** con la lista de usuarios (se resuelve en design como tercera
   pestaña de `/admin/access` — misma sección, ver design.md Decision 7).
2. Desactivar/reactivar cuentas como **SOFT-DELETE**: columna `users.deactivated_at`
   (nullable; `NULL` = activa) que bloquea el login. Nada se borra.
3. Guard de **no auto-desactivación**: un admin no puede desactivarse a sí mismo.

## Scope

### In Scope

- **Migración `012_user_deactivation.sql`** (manual, mismo formato idempotente que
  001–011, `deploy/sql/migrations/`): `ALTER TABLE users ADD COLUMN IF NOT EXISTS
  deactivated_at TIMESTAMPTZ` (nullable, sin default). Rollback documentado en el archivo.
- **Bloqueo de TODOS los caminos de acceso** de una cuenta desactivada:
  - `POST /auth/login` (password): rechazo ANTES de emitir cookie/pre-auth 2FA.
  - `GET /auth/google/callback`: rechazo dentro de `resolve_or_create_google_user()`,
    con redirect a `/login?error=account_deactivated` (patrón existente de códigos).
  - **Sesiones YA emitidas**: `get_current_user()` pasa a verificar contra la base que la
    cuenta siga existiendo y activa en cada request autenticado (hoy es JWT-only — la
    desactivación debe ser efectiva al instante, no "cuando venza el token de 24 h").
- **Endpoints de administración** en `src/main.py` (patrón monolítico existente), los tres
  con `require_min_role(UserRole.ADMIN)`:
  - `GET /auth/users`: lista de usuarios con rol, origen (google/password), fecha de alta
    y estado activa/desactivada.
  - `POST /auth/users/{id}/deactivate`: setea `deactivated_at = now()`.
  - `POST /auth/users/{id}/reactivate`: vuelve `deactivated_at` a `NULL`.
- **Guards de jerarquía** (coherentes con `ROLE_LEVEL` de `src/models/user.py`): solo se
  puede desactivar/reactivar a usuarios de rol ESTRICTAMENTE inferior al propio; nunca a
  uno mismo. Consecuencia deliberada: nadie puede desactivar a un superadmin, con lo que
  el guard de "último superadmin" (existente en `delete_account()`) acá no hace falta por
  construcción.
- **UI**: tercera pestaña "Usuarios" en `/admin/access` (junto a "Lista de espera" e
  "Invitaciones"), con confirmación (`AlertDialog`) antes de desactivar, botón de
  reactivar, y botones deshabilitados cuando la jerarquía no permite la acción.
- **i18n**: claves nuevas en `dashboard/messages/{es,en}.json` con paridad exacta
  (`messages/parity.test.ts` la exige) + código de error `account_deactivated` en el
  mapeo de `/login`.
- **Tests**: backend contra Postgres real (fixtures de `tests/conftest.py`,
  testcontainers — la migración 012 entra sola al glob de `_migrated`), frontend Vitest.

### Out of Scope

- Hard-delete de cuentas ajenas por un admin (el soft-delete es la decisión; `DELETE
  /account` propio sigue igual).
- Cambio de rol de un usuario existente desde la lista (gestión de roles = otro change).
- Email de notificación al usuario desactivado/reactivado.
- Audit log de quién desactivó a quién más allá de `deactivated_at` (sin columna
  `deactivated_by`; si hiciera falta trazabilidad, es una extensión trivial futura).
- Paginación/búsqueda en la lista de usuarios (beta: decenas de usuarios, no miles).
- Redirect en caliente del dashboard cuando una sesión muere por 401 (limitación conocida
  y preexistente del middleware — memoria del proyecto; no la introduce este change).

## Approach

Una columna nullable + un chequeo central. `deactivated_at IS NOT NULL` bloquea:
(a) el login por password con un 403 explícito SOLO tras verificar la password (mensaje
claro sin regalar enumeración: con password incorrecta la respuesta sigue siendo el 401
genérico de siempre); (b) el callback de Google vía una excepción nueva de dominio
(`AccountDeactivatedError`) mapeada al patrón de redirect con código; y (c) las sesiones
vivas, agregando en `get_current_user()` una verificación liviana contra la base
(`SELECT deactivated_at FROM users WHERE id = $1`) que además cierra el agujero de las
cuentas borradas con JWT todavía válido. `get_current_user_optional()` hereda el bloqueo
gratis porque delega en `get_current_user()` (patrón documentado en `deps.py`).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `deploy/sql/migrations/012_user_deactivation.sql` | New | Columna `users.deactivated_at TIMESTAMPTZ NULL` |
| `src/models/user.py` | Modified | `UserInDB.deactivated_at`, modelo nuevo `UserListItem` |
| `src/services/auth_service.py` | Modified | `AccountDeactivatedError`, chequeo en `resolve_or_create_google_user()`, `is_user_active()`, `list_users()`, `deactivate_user()`, `reactivate_user()` |
| `src/api/deps.py` | Modified | `get_current_user()` verifica cuenta existente y activa contra la base |
| `src/main.py` | Modified | Bloqueo en `/auth/login`, catch en callback Google, 3 endpoints nuevos `/auth/users*` |
| `dashboard/components/admin/UsersPanel.tsx` | New | Panel de la pestaña Usuarios |
| `dashboard/app/(app)/admin/access/page.tsx` | Modified | Tercera pestaña `users` |
| `dashboard/lib/auth.ts`, `dashboard/lib/types.ts` | Modified | `listUsers`/`deactivateUser`/`reactivateUser` + tipos |
| `dashboard/app/login/page.tsx` | Modified | Código `account_deactivated` en el mapeo de errores |
| `dashboard/messages/{es,en}.json` | Modified | Claves `admin.users.*`, `admin.access.tabs.users`, `auth.oauthErrors.accountDeactivated` |
| `tests/…` | Modified/New | Unit + integración contra Postgres real; actualización de stubs de `auth_service` en tests de deps |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| El chequeo por request en `get_current_user()` agrega un round-trip a Postgres a cada request autenticado. | Medium (costo), Low (impacto) | Lookup por PK indexado, escala beta; `/auth/me` ya hace un round-trip por request hoy. Alternativas (cache Redis con TTL) documentadas como diferidas en design.md Decision 4. |
| Blast radius en tests: todo test que ejercita `get_current_user` con un `auth_service` fake necesita el método nuevo (`tests/unit/test_deps.py` y las apps de integración). | High (certeza) | No es riesgo sino trabajo planificado: tarea de primera clase en tasks.md Fase 1. |
| Un admin desactivado que conserva sesión podría desactivar a otros antes del fix de sesiones vivas. | Low | No existe la ventana: el chequeo de sesiones vivas y los endpoints nuevos entran en el MISMO change/deploy. |
| El mensaje de "cuenta desactivada" filtra existencia de cuentas (enumeración). | Low | El 403 explícito SOLO se emite con credenciales correctas (password verificada) o identidad verificada por Google; con credenciales malas la respuesta es el 401 genérico de siempre. |

## Rollback Plan

1. **Código**: revertir los commits del change — el sistema vuelve al estado actual
   (sin gestión de usuarios, sesiones JWT-only). Conocido y en producción.
2. **Migración 012**: `ALTER TABLE users DROP COLUMN IF EXISTS deactivated_at;` — sin
   condicionales: la columna es nullable, sin FKs ni constraints entrantes. Efecto
   lateral: los usuarios desactivados vuelven a poder entrar (aceptable en rollback:
   es exactamente el comportamiento pre-change).
3. **UI/i18n**: se revierte con el código; las claves nuevas desaparecen de ambos
   diccionarios a la vez (la paridad no se rompe).

## Dependencies

- `multi-user-auth`, `google-oauth` y `email-invitations` ya mergeados y en producción
  (roles + `require_min_role`, callback de Google con patrón de error-redirect, página
  `/admin/access` con pestañas).
- Sin dependencias npm ni Python nuevas.

## Success Criteria

- [ ] Un admin+ ve la lista de usuarios en `/admin/access?tab=users`, con estado
      activa/desactivada; un viewer/moderador no puede (ni por UI ni por API directa).
- [ ] Desactivar una cuenta bloquea el login por password, el login por Google y mata
      las sesiones ya emitidas EN EL PRÓXIMO REQUEST (no al vencer el token de 24 h).
- [ ] El mensaje de bloqueo es claro para el dueño legítimo de la cuenta y no habilita
      enumeración de emails para terceros.
- [ ] Nadie puede desactivarse a sí mismo ni desactivar/reactivar a un rol igual o
      superior (verificado por API directa, no solo por botones deshabilitados).
- [ ] Reactivar restaura el acceso completo por ambos caminos de login.
- [ ] La migración 012 es idempotente, reversible, y lo documenta en el propio SQL.
- [ ] Paridad ES/EN verde (`messages/parity.test.ts`) con las claves nuevas.
