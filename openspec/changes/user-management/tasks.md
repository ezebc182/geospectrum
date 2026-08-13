# Tasks: Gestión de usuarios con desactivación/reactivación (soft-delete)

Convenciones de este archivo:

- **Cada fase = un batch** (una sesión enfocada de sub-agente de `sdd-apply`). Orden de
  rollout: backend completo → frontend → verificación en producción. NO adelantar tareas
  de una fase posterior.
- **AC** = criterio de aceptación, referenciando escenarios de `specs/auth/spec.md` y
  `specs/dashboard-ui/spec.md` de este change.
- **NUNCA correr `npm run build`** (regla del proyecto). Verificación de frontend: tests
  con Vitest y `tsc --noEmit` si hace falta chequear tipos.
- **Postgres del stack local escucha en 5433**, no 5432 (en 5432 hay un Postgres nativo
  de macOS ajeno al proyecto). Los tests con testcontainers levantan container propio.
- **Los commits los hace el ORQUESTADOR**, no el sub-agente de apply. Conventional
  commits, sin atribución de IA.
- **Contrato de no-lockout** (transversal, no negociable): nadie puede desactivarse a sí
  mismo ni desactivar un rol igual o superior ⇒ es imposible dejar el sistema sin
  superadmin activo. La Fase 1 lo verifica con tests dedicados.

## Phase 1: Backend — migración, servicio, enforcement y endpoints (+ tests)

- [ ] 1.1 Crear `deploy/sql/migrations/012_user_deactivation.sql`:
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;` con header
      de contexto (formato de 001–011: por qué nullable, qué significa NULL) y el rollback
      documentado al pie (`DROP COLUMN IF EXISTS`, advirtiendo que revertir reactiva a
      todos). Sin CHECK ni índice (design.md Decision 2).
      **AC**: re-ejecutarla dos veces seguidas no falla; `tests/conftest.py::_migrated` la
      toma sola por glob alfabético.

- [ ] 1.2 `src/models/user.py`: agregar `deactivated_at: Optional[datetime] = None` a
      `UserInDB` (con default, mismo criterio que `totp_enabled`) y el modelo nuevo
      `UserListItem` (id, email, role, name, avatar_url, has_google, has_password,
      created_at, deactivated_at) — design.md Decision 9. Docstring explicando por qué NO
      se reusa `UserPublic`.
      **AC**: `UserListItem` no tiene forma de expresar `password_hash` ni `totp_secret`.

- [ ] 1.3 `src/services/auth_service.py`: definir las 6 excepciones de dominio
      (`AccountDeactivatedError`, `UserNotFoundError`, `CannotDeactivateSelfError`,
      `CannotManageHigherOrEqualRoleError`, `UserAlreadyDeactivatedError`,
      `UserNotDeactivatedError`), en el mismo bloque y estilo que las existentes.

- [ ] 1.4 `src/services/auth_service.py`: agregar `deactivated_at` al `SELECT` de
      `get_user_by_email()` y `get_user_by_id()` (el guard del login password lo lee de
      `UserInDB`).
      **AC**: los tests existentes de login siguen verdes (columna nueva, sin cambio de
      comportamiento para activos).

- [ ] 1.5 `src/services/auth_service.py`: implementar `is_user_active(user_id) -> bool`
      (`SELECT deactivated_at FROM users WHERE id = $1`; fila inexistente ⇒ False).

- [ ] 1.6 `src/services/auth_service.py`: implementar `list_users() -> list[UserListItem]`
      derivando `has_google`/`has_password` en la query (`google_id IS NOT NULL`,
      `password_hash IS NOT NULL`), orden `created_at DESC`.
      **AC**: [Requirement: Listado de usuarios para administración / Scenario: Un admin
      lista los usuarios].

- [ ] 1.7 `src/services/auth_service.py`: implementar `deactivate_user(actor, target_id)`
      con los 4 guards EN ORDEN (self → not found → jerarquía → ya desactivado), dentro de
      una transacción con `SELECT ... FOR UPDATE` sobre la fila objetivo para serializar
      dos desactivaciones concurrentes.
      **AC**: [Scenario: Desactivar una cuenta activa], [Scenario: Desactivar una cuenta
      ya desactivada es rechazado explícitamente] (el timestamp original NO se pisa),
      [Scenario: Nadie puede desactivarse a sí mismo], [Scenario: Un admin no puede
      desactivar a otro admin ni a un superadmin].

- [ ] 1.8 `src/services/auth_service.py`: implementar `reactivate_user(actor, target_id)`
      (guards de existencia y jerarquía; 409 si ya está activa).
      **AC**: [Requirement: Reactivación de cuenta] y sus dos escenarios.

- [ ] 1.9 `src/services/auth_service.py`: guard en `resolve_or_create_google_user()` —
      levantar `AccountDeactivatedError` DESPUÉS de resolver al usuario (por `google_id` o
      por email) y ANTES de cualquier `UPDATE` (refresco de name/avatar y auto-link de
      `google_id`).
      **AC**: [Scenario: Auto-link no se aplica a cuentas desactivadas] — `google_id`
      sigue en NULL tras el intento.

- [ ] 1.10 `src/api/deps.py`: en `get_current_user()`, tras `decode_access_token()`,
      llamar a `auth_service.is_user_active(user.id)` y responder el 401 genérico
      existente ("not authenticated") si es False. NO tocar
      `get_current_user_optional()` — hereda el bloqueo por delegación, y agregarle un
      `Depends` propio reintroduciría el bug de los 500 en `/report` (docstring existente).
      Docstring explicando el porqué del round-trip (design.md Decision 4).
      **AC**: [Scenario: Sesión viva muere al desactivar la cuenta], [Scenario: JWT válido
      de una cuenta borrada también muere], [Scenario: Endpoint público con
      personalización trata al desactivado como anónimo].

- [ ] 1.11 `src/main.py`: guard en `POST /auth/login` entre el bloque de credenciales
      inválidas y el de `totp_enabled` — 403 `{"error": "account deactivated"}` SOLO con
      password verificada; con password incorrecta, el 401 genérico intacto. Métrica
      `requests_total.labels(endpoint="/auth/login", status="403")`.
      **AC**: [Scenario: Login con password correcta de cuenta desactivada], [Scenario:
      Login con password incorrecta de cuenta desactivada no filtra estado], [Scenario:
      Cuenta desactivada con 2FA habilitado tampoco recibe pre-auth].

- [ ] 1.12 `src/main.py`: capturar `AccountDeactivatedError` en `google_callback()` y
      devolver `_google_error_redirect("account_deactivated")`, junto al `except
      InvitationRequiredError` existente.
      **AC**: [Scenario: Google login de cuenta desactivada] — 302, sin Set-Cookie.

- [ ] 1.13 `src/main.py`: agregar `GET /auth/users` con
      `require_min_role(UserRole.ADMIN)` y `response_model=list[UserListItem]`, con
      métricas del patrón existente.

- [ ] 1.14 `src/main.py`: agregar `POST /auth/users/{user_id}/deactivate` y
      `POST /auth/users/{user_id}/reactivate` (204 en éxito), mapeando las excepciones a
      la matriz de status de design.md (404/403/409) con shape `{"error": ...}`. Labels de
      métrica literales (`/auth/users/{id}/deactivate`), sin interpolar el UUID.
      **AC**: matriz completa de `design.md` § Interfaces / Contracts.

- [ ] 1.15 `tests/unit/test_deps.py`: extender los fakes de `auth_service` con
      `is_user_active` y agregar casos de cuenta desactivada / fila inexistente.
      **AC**: la suite existente de deps vuelve a verde (esta tarea es trabajo
      planificado, no un imprevisto: todo fake de auth_service necesita el método nuevo).

- [ ] 1.16 `tests/unit/test_user_management.py` (nuevo, Postgres real vía `db_pool` de
      `tests/conftest.py`): guards de jerarquía y self, transiciones, doble desactivación,
      `is_user_active` con fila inexistente, y el contrato de no-lockout (imposible dejar
      el sistema sin superadmin activo).

- [ ] 1.17 `tests/integration/test_users_api.py` (nuevo): los 3 endpoints con la matriz
      completa de status; bloqueo de login password (403 vs 401 no-enumerante, y el caso
      2FA); sesión viva que muere en el request siguiente; `/report` tratando al
      desactivado como anónimo; callback de Google con `account_deactivated` sin
      Set-Cookie ni UPDATE.

- [ ] 1.18 Correr la suite backend completa (`pytest`) + `ruff`/`black`/`mypy` según el
      pipeline del proyecto. Sin build de frontend en esta fase.

## Phase 2: Frontend — pestaña Usuarios, i18n y tests

- [ ] 2.1 `dashboard/lib/types.ts`: agregar la interface `UserListItem` (espejo exacto del
      modelo Python, fechas como `string` ISO).

- [ ] 2.2 `dashboard/lib/auth.ts`: agregar `listUsers()`, `deactivateUser(id)` y
      `reactivateUser(id)` siguiendo el patrón existente de las funciones de invitaciones
      (`credentials: 'include'`, `ApiStatusError` con el status para que la UI mapee copy).

- [ ] 2.3 `dashboard/messages/es.json` y `en.json`: agregar `admin.access.tabs.users`,
      el bloque `admin.users.*` (título, descripción, vacío, error de carga, columnas,
      estados activa/desactivada, origen Google/password, acciones, copy del diálogo de
      confirmación, razones de deshabilitado, errores por status 403/404/409) y
      `auth.oauthErrors.accountDeactivated`. Reusar `admin.roles.*` existente.
      **AC**: [Requirement: Paridad de claves ES/EN / Scenario: El test de paridad pasa].

- [ ] 2.4 `dashboard/components/admin/UsersPanel.tsx` (nuevo): lista con SWR, badges de
      estado y origen, `AlertDialog` de confirmación para desactivar, acción directa para
      reactivar, botones deshabilitados por jerarquía (`ROLE_LEVEL` de `lib/types.ts`) y
      por self, con explicación accesible. El estado guarda el OUTCOME (kind + datos), no
      el texto resuelto — patrón de `InvitationsPanel` para que el cambio de idioma en
      caliente re-traduzca.
      **AC**: [Requirement: Desactivar una cuenta requiere confirmación explícita],
      [Requirement: La UI refleja los guards de jerarquía].

- [ ] 2.5 `dashboard/app/(app)/admin/access/page.tsx`: agregar la tercera pestaña `users`
      al array `TABS` (con ícono de lucide, ej. `Users`) y al render del `tabpanel`;
      mantener el fallback a `waitlist` para valores desconocidos de `?tab=`.
      **AC**: [Scenario: Un admin abre la pestaña de usuarios], [Scenario: Deep-link a una
      pestaña desconocida].

- [ ] 2.6 (OPCIONAL, sujeto a decisión del usuario — Open Question del design) Crear
      `dashboard/app/(app)/admin/users/page.tsx` como redirect a
      `/admin/access?tab=users`, mismo patrón que las redirecciones de `/beta` y
      `/admin/invitations`.

- [ ] 2.7 `dashboard/app/login/page.tsx`: mapear `account_deactivated` en
      `resolveGoogleOAuthError` y mostrar el mismo copy cuando `POST /auth/login` responde
      403 por cuenta desactivada.
      **AC**: [Requirement: Mensaje de cuenta desactivada en el login] y sus dos
      escenarios.

- [ ] 2.8 `dashboard/components/admin/UsersPanel.test.tsx` (nuevo, Vitest): confirmar
      dispara la llamada, cancelar NO la dispara, deshabilitados por self y por jerarquía,
      error del backend traducido sin romper la lista.

- [ ] 2.9 Correr los tests del dashboard (Vitest, incluido `messages/parity.test.ts`).
      **NUNCA** `npm run build`.

## Phase 3: Verificación y rollout

- [ ] 3.1 Aplicar la migración 012 en local (Postgres del stack, puerto **5433**) y
      confirmar que `scripts/apply_migrations.py` la toma al arranque de la API sin errores
      ni downtime.

- [ ] 3.2 Verificación manual end-to-end en local, en la pantalla que usa el usuario
      (`/admin/access?tab=users`, no solo por API): desactivar una cuenta de prueba y
      comprobar los TRES bloqueos — (a) login password, (b) login Google, (c) sesión ya
      abierta en otra pestaña muere al siguiente request. Después reactivarla y verificar
      que ambos caminos de login vuelven a funcionar.

- [ ] 3.3 Verificar por API directa (curl, sin pasar por la UI) que los guards de
      jerarquía y auto-desactivación rechazan aunque los botones estén deshabilitados —
      la UI no es el mecanismo de seguridad.

- [ ] 3.4 Deploy: backend (Railway) primero, dashboard (Vercel) después — la columna y los
      endpoints deben existir antes de que la UI los llame.

- [ ] 3.5 Smoke en producción: listar usuarios como admin, desactivar y reactivar una
      cuenta de prueba, y confirmar que ningún usuario legítimo perdió acceso
      (`deactivated_at IS NULL` para todas las filas preexistentes).
