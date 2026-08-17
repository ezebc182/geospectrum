# Tasks: Cambio de rol de usuarios desde la UI de administración

Convenciones de este archivo:

- **Cada fase = un batch** (una sesión enfocada de sub-agente de `sdd-apply`). Orden de
  rollout: backend completo → frontend → verificación y rollout. NO adelantar tareas de
  una fase posterior.
- **AC** = criterio de aceptación, referenciando Requirements/Scenarios de
  `specs/auth/spec.md`, `specs/invitations/spec.md` y `specs/dashboard-ui/spec.md` de este
  change.
- **NUNCA correr `npm run build`** (regla del proyecto). Verificación de frontend: Vitest
  y `tsc --noEmit`.
- **No usar `cat`/`grep`/`find`/`sed`/`ls`** — usar `bat`/`rg`/`fd`/`sd`/`eza`.
- **Postgres del stack local escucha en 5433**, no 5432 (en 5432 hay un Postgres nativo de
  macOS ajeno al proyecto; container `timescaledb`, base y usuario `seismic`). Los tests
  con testcontainers levantan su propio container.
- **Idioma del código**: nombres en inglés, comentarios en español. Los artefactos de
  openspec, en español.
- **Los commits los hace el ORQUESTADOR**, no el sub-agente de apply. Conventional
  commits, sin atribución de IA.
- **El venv está en `./venv`.**
- **SIN MIGRACIÓN DE BASE.** `users.role` existe desde la migración 001 y el `CHECK` de
  `deploy/sql/migrations/002_add_role_hierarchy.sql:17-18` ya cubre los cuatro valores.
  **No crear ningún archivo en `deploy/sql/migrations/`.** Si alguien siente el impulso de
  agregar una migración en este change, está equivocado: no hay DDL.

### Tres trampas nombradas por adelantado (el change se pierde en cualquiera de ellas)

1. **Sobrescribir, no comparar.** `get_current_user()` tiene que DEVOLVER un `CurrentUser`
   con el rol de la base. Una implementación que compare el rol de la base contra el del
   JWT y levante 401 pasa casi todos los tests que uno escribiría, deja el agujero abierto
   (`require_min_role()` lee `CurrentUser.role`) y encima convierte una PROMOCIÓN en un
   deslogueo. La tarea 2.4 y los tests 2.6/2.7 son los únicos que la matan.
2. **El comparador de la UI.** `grantableRoles` (`dashboard/components/admin/InvitationsPanel.tsx:145`)
   usa `<=`. El selector de este change necesita `<` ESTRICTO. Copiar el memo verbatim
   viola la decisión 1 en silencio y sin romper ningún test existente.
3. **`response_model=None` en el endpoint 204.** Sin eso FastAPI **falla al importar** con
   *"Status code 204 must not have a response body"* (ver `src/main.py:1451-1457` y el
   commit `f348eb4`). mypy no lo detecta; el primer test que levanta la app, sí.

### Corrección al design (VERIFICADA — el design está equivocado en este punto)

`design.md` Decision 6 afirma que el body del 409 de auto-gestión puede ser
`"cannot change your own role"` y que `actionErrorKey()` lo clasificaría como `self`.
**Es falso.** Verificado contra el código:

- `dashboard/components/admin/UsersPanel.tsx:86` hace
  `err.message.includes('own account') ? 'self' : 'conflict'`.
- Los bodies actuales del backend son `"cannot deactivate your own account"`
  (`src/main.py:1483`) y `"cannot manage your own account"` (`src/main.py:1536`) — los dos
  contienen literalmente `own account`.
- `"cannot change your own role"` NO contiene `own account`, así que caería en `'conflict'`
  y mostraría el copy equivocado.

⇒ **El body del 409 de self del endpoint de rol DEBE contener la subcadena `own account`.**
Body elegido: `"cannot change your own account role"`. Ver tareas 3.4 y 3.7.

### Decisión 9 del usuario (POSTERIOR al design — PISA a proposal, design y specs)

La decisión 8 (alinear invitaciones de `>` a `>=`) tenía una consecuencia no prevista: con
`>=` a secas **nadie puede crear otro superadmin por ninguna vía** — el bootstrap sólo
dispara con la tabla vacía (`_determine_bootstrap_role()`,
`src/services/auth_service.py:341,356-357`), la invitación quedaría bloqueada y el cambio
de rol ya está bloqueado por la decisión 2. El usuario eligió la opción B:

> **REGLA FINAL DEL GUARD DE INVITACIONES** (`src/services/invitation_service.py:251`):
> Nadie invita un rol de nivel IGUAL O SUPERIOR al propio,
> **EXCEPTO un superadmin invitando a otro superadmin.**

O sea `>=` para todos los casos, con una excepción explícita para
`actor.role == SUPERADMIN and role == SUPERADMIN`.

**ESTA ASIMETRÍA ES DELIBERADA. NO LA "CORRIJAS".**

- Un superadmin **SÍ** puede **INVITAR** a otro superadmin (crear un par).
- Un superadmin **NO** puede **CAMBIARLE EL ROL** a otro superadmin (decisión 2, guard
  dedicado `CannotChangeSuperadminRoleError`).

Crear un par sí; degradar un par, nunca. Eso mantiene intacto el contrato de no-lockout
mientras deja una puerta legítima para nombrar un segundo superadmin sin un `UPDATE` a
mano contra producción. Quien implemente esto y "unifique" las dos reglas por prolijidad
rompe la funcionalidad a propósito.

Artefactos que quedaron DESACTUALIZADOS por la decisión 9 y hay que reconciliar (Fase 6):
`proposal.md` (lista invitaciones en Out of Scope) y `specs/invitations/spec.md` (afirma
que un superadmin YA NO puede invitar a otro superadmin, y su
[Requirement: Impacto operativo] dice que crear un superadmin adicional es imposible por
la aplicación). Los dos se escribieron antes de la decisión 9.

---

## Phase 1: Rename mecánico aislado (`CannotDeactivateSelfError` → `CannotManageSelfError`)

Fase corta y deliberadamente sola: un rename mecánico mezclado con lógica nueva produce un
diff que nadie revisa bien (design.md Decision 5). **Commit propio, primero, tests verdes
antes de seguir.**

- [x] 1.1 `src/services/auth_service.py`: renombrar la clase `CannotDeactivateSelfError`
      (132) a `CannotManageSelfError` y reescribir su docstring (132-139) para hablar de
      "gestionarse a sí mismo (desactivar / reactivar / cambiar de rol)", absorbiendo la
      aclaración que hoy vive duplicada en `reactivate_user()` (1322-1325). Conservar el
      argumento de por qué es 409 y no 403. El `raise` de `_load_manageable_target()`
      (1277) pasa al nombre nuevo.
      **AC**: `rg -n 'CannotDeactivateSelfError' src/ tests/` no devuelve nada.

- [x] 1.2 `src/main.py`: actualizar el import del bloque de users y los dos `except`
      (1477 y 1532) al nombre nuevo.
      **AC**: los bodies de error **NO se tocan** — siguen siendo
      `"cannot deactivate your own account"` (1483) y `"cannot manage your own account"`
      (1536). Ningún contrato público cambia: el nombre de la excepción no sale en ninguna
      respuesta HTTP, los status tampoco, y el frontend no se entera.

- [x] 1.3 Barrer tests e imports con `sd 'CannotDeactivateSelfError' 'CannotManageSelfError'`
      sobre `src/` y `tests/`, revisando a mano cada hit (no confiar en el reemplazo ciego).

- [x] 1.4 Correr `pytest` completo. La suite tiene que quedar verde SIN ningún cambio de
      comportamiento: esta fase no agrega ni saca una sola regla.
      **AC**: cero tests nuevos, cero tests modificados más allá del nombre del símbolo.

---

## Phase 2: Backend — el LECTOR (revalidación del rol en cada request)

Es la mitad del change que arregla el control de acceso. Va antes del escritor porque sin
esto un cambio de rol tarda hasta 24 h (`auth_token_expire_minutes = 1440`) en tener
efecto.

- [x] 2.1 `src/services/auth_service.py`: agregar el dataclass
      `@dataclass(frozen=True) class UserAuthState` con `is_active: bool` y
      `role: Optional[UserRole]`, junto a las excepciones de dominio del módulo. Docstring
      explicando el contrato de `role`: **`None` si y sólo si la fila no existe** — un
      `UserRole.VIEWER` de relleno sería un rol REAL inventado por el lector para una
      cuenta que no existe, y el tipo tiene que ser incapaz de mentir.
      **AC**: [Requirement: El rol efectivo se revalida contra la base en cada request].

- [x] 2.2 `src/services/auth_service.py`: implementar
      `async def get_user_auth_state(self, user_id: UUID) -> UserAuthState` con **UNA**
      query: `SELECT role, deactivated_at FROM users WHERE id = $1`. Misma forma que la
      query actual de `is_user_active()` (1191) con una columna más — no una query nueva,
      no un `get_user_by_id()` (506) que arrastraría `password_hash` y `totp_secret` a
      memoria en cada request autenticado.
      **AC**: fila inexistente ⇒ `UserAuthState(is_active=False, role=None)`.

- [x] 2.3 `src/services/auth_service.py`: reimplementar `is_user_active()` sobre el método
      nuevo (`return (await self.get_user_auth_state(user_id)).is_active`)
      **conservando la firma EXACTA** `(self, user_id: UUID) -> bool`. Decisión 7 del
      usuario: el método nuevo es ADITIVO y este sobrevive intacto porque hay al menos
      tres fakes que lo DEFINEN (`tests/unit/test_deps.py:75`,
      `tests/integration/test_auth_api.py:63`, `tests/integration/test_invitations_api.py:207`).
      **AC**: [Scenario: `is_user_active()` conserva su firma] — los fakes existentes NO se
      reescriben.

- [x] 2.4 `src/api/deps.py`: en `get_current_user()` (40), reemplazar la llamada a
      `is_user_active()` (109) por `get_user_auth_state()`, mantener el 401 genérico
      ("not authenticated") cuando `not state.is_active or state.role is None`, y
      **DEVOLVER `current_user.model_copy(update={"role": state.role})`** en vez del objeto
      armado desde el JWT. Comentario en el código nombrando que es SOBRESCRITURA y no
      comparación, y por qué (`require_min_role()` autoriza leyendo `CurrentUser.role`).
      **NO TOCAR `get_current_user_optional()` (118)**: hereda la revalidación por
      delegación (158) y agregarle un `Depends(_get_auth_service)` propio reintroduce el
      bug documentado de los 500 en `/report` (133-141, 147-151) — un `Depends` se resuelve
      ANTES del cuerpo y su `AttributeError` escapa del `try`. **NO TOCAR
      `require_min_role()` (195)**: queda correcto por construcción.
      **AC**: [Scenario: El `CurrentUser` devuelto lleva el rol de la base, no el del
      token], [Scenario: Una cuenta desactivada sigue bloqueada igual], [Scenario: Una fila
      inexistente sigue produciendo 401].

- [x] 2.5 `tests/unit/test_user_management.py`: agregar tests de `get_user_auth_state()`
      contra Postgres real (`db_pool`/`_migrated`): cuenta activa (estado + rol correcto),
      cuenta desactivada (`is_active=False` y el rol IGUAL presente), fila inexistente
      ⇒ `(False, None)`. Y no-regresión de la reimplementación: `is_user_active()` sigue
      devolviendo lo mismo que antes en los cuatro casos del bloque que ya existe (316-340).

- [x] 2.6 `tests/unit/test_deps.py`: extender el fake de `auth_service` (75) con
      `async def get_user_auth_state(self, user_id) -> UserAuthState` que devuelva valores
      **CONCRETOS** (`UserRole.VIEWER`, `True`/`False`) — **NUNCA `MagicMock`**. Precedente
      directo del proyecto: en `user-management` los `MagicMock` truthy rompieron 65 tests
      porque `deactivated_at` daba truthy.
      **AC**: la suite de deps vuelve a verde. Trabajo planificado, no imprevisto.

- [x] 2.7 `tests/unit/test_deps.py`: **EL TEST QUE DECIDE EL CHANGE**. Token con claim
      `role="admin"`, base con `viewer` ⇒ el `CurrentUser` devuelto tiene
      `role == UserRole.VIEWER`. El assert es sobre **el VALOR devuelto**, no sobre "no
      tiró excepción": una implementación que compare y levante 401 tiene que FALLAR este
      test.
      Y su inverso, que mata la variante "comparar y 401": token con `role="viewer"`, base
      con `moderador` ⇒ el `CurrentUser` sale `moderador` y `require_min_role(MODERADOR)`
      **deja pasar** (una promoción no puede convertirse en un deslogueo).
      **AC**: [Scenario: La degradación es efectiva en el request siguiente],
      [Scenario: La promoción también es efectiva en el request siguiente].

- [x] 2.8 Barrido de fakes en lockstep (`rg -n 'is_user_active|get_user_auth_state' tests/`):
      verificar — no asumir — que `tests/integration/test_auth_api.py:63`,
      `tests/integration/test_invitations_api.py:207`, `tests/integration/test_locale_api.py`
      y `tests/integration/test_areas_api.py` siguen funcionando. Si alguno de esos tests
      atraviesa `get_current_user()`, su fake necesita `get_user_auth_state` con valores
      concretos aunque `is_user_active` haya sobrevivido.
      **AC**: `pytest` completo verde. Si un fake hay que extenderlo, se extiende acá y no
      en la fase siguiente.

- [x] 2.9 Correr `pytest` completo + `ruff`/`black`/`mypy` según el pipeline del proyecto.
      **Sin build de frontend.**

---

## Phase 3: Backend — el ESCRITOR (endpoint de cambio de rol y sus guards)

- [x] 3.1 `src/models/user.py`: agregar `class RoleChangeRequest(BaseModel)` con
      `role: UserRole`, con docstring explicando por qué es un modelo propio y **no**
      `UserProfileUpdate` (228): ese excluye `role` a propósito y lo documenta (233-238) —
      el rol es una decisión de administración sobre OTRO usuario, no un campo del perfil
      propio. Pydantic valida contra el enum: un rol inexistente es 422, no un guard.
      **NO TOCAR `UserProfileUpdate`.**
      **AC**: [Scenario: Un rol inexistente se rechaza con 422], [Scenario: El rol no se
      puede cambiar desde el perfil propio].

- [x] 3.2 `src/services/auth_service.py`: definir las tres excepciones nuevas en el mismo
      bloque y estilo que las existentes — `CannotChangeSuperadminRoleError` (403, guard
      dedicado), `CannotAssignHigherOrEqualRoleError` (403, rol PEDIDO vs. actor),
      `UserAlreadyHasRoleError` (409, no-op explícito). El docstring de la primera tiene
      que decir POR QUÉ es dedicada y no emergente: la regla "a un superadmin no se le
      cambia el rol" debe sobrevivir a un refactor de `ROLE_LEVEL` (`src/models/user.py:42`);
      hoy se cumple sólo por la aritmética de que `SUPERADMIN = 3` es el máximo del dict, y
      el día que alguien agregue un `OWNER: 4` el agujero se abre sin que falle un test.
      **AC**: [Requirement: Un superadmin es intocable por un guard dedicado].

- [x] 3.3 `src/services/auth_service.py`: implementar
      `async def change_user_role(self, actor: CurrentUser, target_id: UUID, new_role: UserRole) -> None`
      con la forma exacta de `deactivate_user()` (1291): `acquire` → `transaction` →
      `_load_manageable_target()` (1251, con su `SELECT ... FOR UPDATE` de 1280) → guards
      propios → `UPDATE users SET role = $2 WHERE id = $1`.
      **Los 6 guards EN ESTE ORDEN, NO reordenables** (design.md Decision 4):
      1. self ⇒ `CannotManageSelfError` (409) — de `_load_manageable_target()` (1276)
      2. fila inexistente ⇒ `UserNotFoundError` (404) — de `_load_manageable_target()` (1283)
      3. `role_level(target.role) >= role_level(actor.role)` ⇒
         `CannotManageHigherOrEqualRoleError` (403) — de `_load_manageable_target()` (1286)
      4. `target.role == SUPERADMIN` ⇒ `CannotChangeSuperadminRoleError` (403)
      5. `role_level(new_role) >= role_level(actor.role)` ⇒
         `CannotAssignHigherOrEqualRoleError` (403)
      6. `target.role == new_role` ⇒ `UserAlreadyHasRoleError` (409)
      **NO tocar `_load_manageable_target()`** (su orden está congelado por el docstring de
      1263-1274). **NO subir el guard 5 al principio** aunque sea gratis y no necesite la
      base: cambiaría la respuesta de un target INEXISTENTE de 404 a 403 y convertiría la
      diferencia en un oráculo de existencia. El `UPDATE` **NO toca ninguna otra columna**:
      `deactivated_at`, `email`, `password_hash`, `google_id` y el resto quedan intactos.
      **AC**: [Requirement: Guards heredados de la gestión de usuarios] y sus 5 escenarios,
      [Requirement: Jerarquía estricta sobre el rol SOLICITADO],
      [Requirement: Asignar el rol que el usuario ya tiene es un conflicto explícito],
      [Scenario: Cambiar el rol de una cuenta desactivada es válido],
      [Scenario: El 409 de no-op no se filtra a quien no tiene permiso].

- [x] 3.4 `src/main.py`: agregar `POST /auth/users/{user_id}/role` en el bloque de users
      (desde 1415), clon estructural de `POST /auth/users/{user_id}/deactivate` (1448):
      `status_code=status.HTTP_204_NO_CONTENT`, **`response_model=None`** (obligatorio, con
      el comentario que explica que sin eso FastAPI falla al IMPORTAR — ver 1451-1457),
      `tags=["auth"]`, `admin: CurrentUser = Depends(require_min_role(UserRole.ADMIN))` y
      `payload: RoleChangeRequest`. Un `except` por excepción de dominio, cada uno con
      `requests_total.labels(endpoint="/auth/users/{id}/role", status="...")` de label
      **LITERAL** — nunca el UUID interpolado (1425-1427). Camino feliz: incrementa `204` y
      `return None` explícito (patrón de 1504-1509).
      **Bodies literales** (contrato de facto, el frontend discrimina por texto):
      | Excepción | Status | Body `error` |
      |---|---|---|
      | `CannotManageSelfError` | 409 | `cannot change your own account role` |
      | `UserNotFoundError` | 404 | `user not found` |
      | `CannotManageHigherOrEqualRoleError` | 403 | `cannot manage a user with an equal or higher role` |
      | `CannotChangeSuperadminRoleError` | 403 | `cannot change the role of a superadmin` |
      | `CannotAssignHigherOrEqualRoleError` | 403 | `cannot assign a role equal to or higher than your own` |
      | `UserAlreadyHasRoleError` | 409 | `user already has that role` |
      **OJO — el design está equivocado acá**: propone `"cannot change your own role"`, que
      NO contiene la subcadena `own account` que `UsersPanel.tsx:86` busca, y caería en la
      clave `conflict` en vez de `self`. Por eso el body es
      `"cannot change your own account role"`. Ver la corrección al design arriba.
      **AC**: [Requirement: Matriz de status del endpoint de cambio de rol],
      [Scenario: La métrica no explota en cardinalidad].

- [x] 3.5 `tests/unit/test_user_management.py`: tests de los 6 guards de
      `change_user_role()` contra Postgres real, **y de su ORDEN**. Para cada par de guards
      que puedan dispararse juntos, exigir la excepción del MÁS ESPECÍFICO. Casos que no
      pueden faltar:
      - target superadmin y actor superadmin ⇒ `CannotChangeSuperadminRoleError`,
        **NO** `CannotManageHigherOrEqualRoleError` (assert sobre el TIPO de excepción, no
        sobre el 403 resultante).
      - actor pidiendo su propio id con un rol que además viola la jerarquía ⇒
        `CannotManageSelfError` (self gana).
      - target inexistente + rol pedido inválido por jerarquía ⇒ `UserNotFoundError`, no el
        403.
      - camino feliz: `deactivated_at` y el resto de las columnas intactas tras el `UPDATE`.
      **AC**: [Scenario: El rechazo viene del guard dedicado, no del general],
      [Scenario: El orden de los guards no se altera].

- [x] 3.6 `tests/unit/test_user_management.py`: concurrencia — dos `change_user_role()`
      simultáneos sobre el MISMO target pidiendo el MISMO rol se serializan por el
      `FOR UPDATE` (1280): exactamente uno responde OK y el otro sale por el guard 6 (409),
      con el rol final correcto. Patrón de
      `test_two_concurrent_deactivations_leave_exactly_one_winner` (294).
      **AC**: [Requirement: Atomicidad del cambio de rol frente a concurrencia] y sus dos
      escenarios.

- [x] 3.7 `tests/integration/test_users_api.py`: agregar
      `("post", f"/auth/users/{uuid4()}/role")` a `PROTECTED_ENDPOINTS` (43-48) — sin eso
      el endpoint se saltea el sweep parametrizado de 401/403 y nadie se entera.
      **AC**: [Scenario: Sin sesión], [Scenario: Un moderador no puede cambiar roles],
      [Scenario: Un viewer no puede cambiar roles].

- [x] 3.8 `tests/integration/test_users_api.py`: matriz completa **por API DIRECTA** (curl
      crudo / cliente de test, nunca "el botón estaba deshabilitado"), con el patrón
      híbrido documentado en 17-24 (`AuthService` REAL contra Postgres real, sólo se
      parchean `decode_access_token`/`decode_token_payload`; *"is_user_active NO se mockea
      nunca"*): admin pidiendo `admin` ⇒ 403; admin pidiendo `superadmin` ⇒ 403; superadmin
      pidiendo `superadmin` ⇒ 403 (nivel igual); superadmin pidiendo `admin` ⇒ 204;
      cualquiera contra un superadmin ⇒ 403; auto-cambio ⇒ 409; no-op ⇒ 409; target
      inexistente ⇒ 404; rol inventado en el body ⇒ 422.
      **AC**: [Scenario: El guard es server-side, no de UI], [Requirement: Matriz de status
      del endpoint de cambio de rol].

- [x] 3.9 `tests/integration/test_users_api.py`: **BODIES LITERALES**. Assert sobre
      `response.json()["error"]` para los seis mensajes de la tabla de 3.4, en particular
      el `"cannot change your own account role"` del 409 de self. Es un test de contrato:
      el frontend discrimina el 409 por el TEXTO (`UsersPanel.tsx:86`), así que si alguien
      reescribe el mensaje en `main.py` tiene que reventar acá — en el backend y ruidoso —
      y no en una traducción silenciosamente equivocada en producción.

- [x] 3.10 `tests/integration/test_users_api.py`: **degradación en caliente end-to-end**.
      Emitir sesión con rol admin, degradar a ese usuario a `viewer` **por la base**, y
      exigir **403** (no 401, no 200) en el request siguiente a un endpoint
      `require_min_role(ADMIN)`, sin re-login y sin esperar los 1440 minutos. Y el gemelo:
      viewer promovido a moderador pasa `require_min_role(MODERADOR)` con su token viejo.
      **AC**: es el criterio de éxito literal del proposal. Una implementación que compare
      en vez de sobrescribir devuelve 401 acá y falla.

- [x] 3.11 Correr `pytest` completo + `ruff`/`black`/`mypy`.

---

## Phase 4: Backend — alineación del guard de invitaciones (decisión 8 + EXCEPCIÓN 9)

Cambio de comportamiento en un flujo que YA ESTÁ EN PRODUCCIÓN. **Commit propio y aislado**,
con el mensaje diciéndolo explícitamente.

- [x] 4.1 **Antes de tocar código**: verificar contra la base de PRODUCCIÓN cuántos admins
      hay y si alguno depende del flujo "admin invita a otro admin". Query de una línea con
      `psql`. (En local, el `timescaledb` escucha en el **puerto 5433**.)
      **AC**: el resultado queda anotado en esta tarea antes de seguir.

      RESUELTA el 2026-08-17 con autorización explícita del usuario para un SELECT de
      sólo lectura (`railway ssh --service timescaledb`). El bloqueo de abajo ya no
      aplica: el acceso lo habilitó el usuario, no el agente por su cuenta.

      **Resultado: CERO admins en producción.** Los cuatro usuarios son 1 superadmin,
      1 moderador y 2 viewers (uno desactivado) — ver el detalle en 6.8. Nadie depende
      hoy del flujo "admin invita a otro admin", así que el rollout de la decisión 9 no
      le rompe el alta a ningún usuario existente.

      Nota operativa para futuras consultas: la base de prod NO tiene
      `DATABASE_PUBLIC_URL` (no está expuesta a internet), así que `railway connect`
      falla. La vía es `railway ssh --service timescaledb` y correr `psql` adentro.

      > **BLOQUEADA — requiere acceso a PRODUCCIÓN, que el agente no tiene ni
      > debe conseguir. Es del USUARIO.** Queda SIN marcar a propósito.
      >
      > No bloquea a 4.2–4.6: el guard de la decisión 9 es una regla fija
      > (`>=` con la excepción superadmin→superadmin), no se deriva de ningún
      > conteo. Lo que este dato condiciona es la decisión de ROLLOUT — si hoy
      > en producción algún admin depende del flujo "admin invita a otro
      > admin", ese flujo se rompe al desplegar y hay que avisarlo antes.
      >
      > Query a correr contra producción antes de mergear la Fase 4:
      > `SELECT role, count(*) FROM users GROUP BY role;` y
      > `SELECT i.role, u.role AS invited_by_role, count(*) FROM invitations i
      >  JOIN users u ON u.id = i.invited_by GROUP BY 1, 2;` — el segundo es el
      > que dice si el flujo admin→admin se usó de verdad alguna vez.

- [x] 4.2 `src/services/invitation_service.py:251`: cambiar el guard a la **regla final de
      la decisión 9**, no a un `>=` pelado:
      ```
      Nadie invita un rol de nivel IGUAL O SUPERIOR al propio,
      EXCEPTO un superadmin invitando a otro superadmin.
      ```
      O sea: rechazar cuando `role_level(role) >= role_level(invited_by.role)`, **salvo**
      cuando `invited_by.role == UserRole.SUPERADMIN and role == UserRole.SUPERADMIN`.
      Comentario en el código explicando la asimetría y por qué NO hay que "arreglarla":
      un superadmin **puede invitar** a otro superadmin (crear un par) pero **no puede
      cambiarle el rol** a otro superadmin (guard dedicado de la tarea 3.3). Sin esta
      excepción, nombrar un segundo superadmin sólo sería posible con un `UPDATE` a mano
      contra producción, porque `_determine_bootstrap_role()` (341, 356-357) sólo dispara
      con la tabla `users` VACÍA.
      `CannotInviteHigherRoleError` (115) **conserva el nombre y el mensaje**; sólo se
      actualiza su docstring (228) para reflejar el `>=` y la excepción.
      **AC**: [Requirement: Creación de invitación] del delta de invitations, **con la
      salvedad de la decisión 9** — el escenario "Un superadmin YA NO puede invitar a otro
      superadmin" de ese spec quedó DESACTUALIZADO y se reconcilia en la Fase 6.

- [x] 4.3 `tests/unit/test_invitation_service.py`: **INVERTIR, no borrar**,
      `test_admin_can_invite_own_level_and_below` (182, parametrizado con
      `[ADMIN, MODERADOR, VIEWER]` en 181). El caso `ADMIN` pasa a ser RECHAZADO
      (`CannotInviteHigherRoleError`); `MODERADOR` y `VIEWER` siguen afirmando el éxito.
      Desdoblar el test si el parametrize no permite expresar el rechazo con claridad — el
      caso límite "propio nivel" tiene que quedar afirmado EXPLÍCITAMENTE, no diluido en un
      parametrize. Renombrar la función acorde (`test_admin_cannot_invite_own_level`, etc.).
      **AC**: [Scenario: El test de "admin invita a su propio nivel" queda invertido],
      [Scenario: La suite completa queda verde] — sin tests borrados ni `skip`.

- [x] 4.4 **NO TOCAR** `test_superadmin_can_invite_superadmin`
      (`tests/unit/test_invitation_service.py:171`) ni
      `test_superadmin_can_invite_superadmin_201`
      (`tests/integration/test_invitations_api.py:346`). **SIGUEN VÁLIDOS TAL CUAL** por la
      excepción de la decisión 9: un superadmin sí invita a otro superadmin. El spec
      `specs/invitations/spec.md` dice lo contrario porque se escribió antes de esa
      decisión — el spec es el que está desactualizado, no los tests.
      **AC**: los dos tests corren verdes sin una sola línea modificada. Esta tarea es una
      verificación, no una edición.

- [x] 4.5 Verificar el resto de la suite de invitaciones:
      `test_admin_cannot_invite_superadmin` (unit 156 / integración 333) sigue verde sin
      cambios, y `test_admin_and_superadmin_can_create_invitation`
      (`tests/integration/test_invitations_api.py:287`, parametrizado con
      `[ADMIN, SUPERADMIN]`) **no se ve afectado** porque invita con `role="viewer"` —
      confirmarlo, no asumirlo.

- [x] 4.6 Correr `pytest` completo.

---

## Phase 5: Frontend — cliente, selector, confirmación, i18n y tests

- [x] 5.1 `dashboard/lib/types.ts`: agregar
      `export const ROLE_ORDER: UserRole[] = ['superadmin', 'admin', 'moderador', 'viewer']`
      y `export interface RoleChangePayload { role: UserRole }`. `UserRole` (116) y
      `ROLE_LEVEL` (120) ya existen y no se tocan.

- [x] 5.2 `dashboard/lib/auth.ts`: agregar
      `changeUserRole(userId: string, role: UserRole): Promise<void>`, clon directo de
      `deactivateUser` (464) / `reactivateUser` (480) más `Content-Type: application/json`
      y `body: JSON.stringify({ role })`. Mismo `credentials: 'include'` y mismo
      `ApiStatusError` vía `readErrorMessage()` (48).

- [x] 5.3 `dashboard/messages/es.json` y `en.json`: agregar las claves nuevas bajo
      `admin.users.*` — label accesible del selector, textos del `AlertDialog` de
      confirmación (con el email y los dos roles), razones de deshabilitado del selector,
      `accessRevoked` (design.md Decision 7) y el fallback de error `roleGeneric`.
      **Reutilizar `admin.roles.*`** para las etiquetas de rol (ya completo en ambos
      idiomas): no crear claves nuevas por rol.
      Copy de `accessRevoked`:
      - ES: *"Tu rol cambió y ya no tenés permisos para ver esta lista. Si creés que es un
        error, contactá a un administrador."*
      - EN: *"Your role changed and you no longer have permission to view this list. If you
        think this is a mistake, contact an administrator."*
      Sin "volvé a iniciar sesión": sería el consejo equivocado y ya lo da `sessionLost`.
      **AC**: [Requirement: Paridad de claves ES/EN para el cambio de rol] y sus dos
      escenarios; `dashboard/messages/parity.test.ts` verde (falla también con valores
      vacíos).

- [x] 5.4 `dashboard/components/admin/UsersPanel.tsx`: agregar el memo `assignableRoles`
      con filtro **`<` ESTRICTO**:
      ```ts
      ROLE_ORDER.filter((r) => ROLE_LEVEL[r] < ROLE_LEVEL[actorRole])
      ```
      con el comentario que nombra la trampa: **NO es el mismo filtro que `grantableRoles`
      de `InvitationsPanel.tsx:145`, que usa `<=`.** Copiar ese memo verbatim viola la
      decisión 1 en silencio y sin romper ningún test. Y decir en voz alta que la UI no es
      el enforcement: el backend rechaza igual con 403 (guard 5); no ofrecer lo imposible
      es UX.
      **AC**: [Requirement: El selector solo ofrece roles de nivel estrictamente menor] y
      sus tres escenarios.

- [x] 5.5 `dashboard/components/admin/UsersPanel.tsx`: columna de rol con **`<select>`
      NATIVO** (no Radix: no hay componente `Select` en `dashboard/components/ui/` y el
      `DropdownMenu` de Radix pelea con inputs porque su typeahead se come las teclas —
      precedente resuelto en `InvitationsPanel.tsx` ~306-318). El `<select>` es
      **controlado y su valor es SIEMPRE `user.role`** (el dato del servidor): el `onChange`
      no muta nada, guarda `pendingChange: { userId, from, to } | null` y abre el
      `AlertDialog`. Cancelar limpia el estado y el select vuelve solo a mostrar el rol
      real, porque nunca dejó de mostrarlo — así el control **no puede** desincronizarse
      cuando el backend rechaza con 409.
      Filas con `disabledReasonFor()` (98) en `'self'` o `'hierarchy'`: el `<select>` se
      renderiza **deshabilitado, no oculto**, con el mismo contrato de a11y que el botón de
      desactivar (`title` + `sr-only` + `aria-describedby`, 289-294 y 340-344).
      **Reutilizar `disabledReasonFor()` tal cual, sin tocarla.**
      **AC**: [Requirement: Selector de rol por fila en la pestaña de usuarios],
      [Requirement: La UI refleja los guards de jerarquía y de auto-gestión] y sus cuatro
      escenarios.

- [x] 5.6 `dashboard/components/admin/UsersPanel.tsx`: `AlertDialog` de confirmación en
      **TODO** cambio de rol (promoción Y degradación, decisión 6 del usuario), nombrando
      los DOS extremos y el email: *"Vas a cambiar el rol de `<email>` de **viewer** a
      **moderador**"*, con `t.rich` y el email en `font-mono`, igual que
      `deactivateDialogDescription` (385-388). El "de X" es lo que permite cancelar cuando
      uno se equivocó de FILA, no de rol. Al confirmar: `setBusyId(target.id)`,
      `changeUserRole()`, `mutate()` de SWR y el mismo `finally` que las otras dos acciones
      (152-154). El fallo va al `outcome` existente con `actionErrorKey(err, 'roleGeneric')`.
      **AC**: [Requirement: Todo cambio de rol pasa por confirmación] y sus cuatro
      escenarios; [Scenario: Solo se bloquea la fila en vuelo].

- [x] 5.7 `dashboard/components/admin/UsersPanel.tsx`: extraer el string discriminante del
      409 a constante de módulo, con el comentario que nombra el acoplamiento:
      ```ts
      /** El backend distingue sus 409 sólo por el TEXTO del body ({"error": ...});
       *  no hay código de error estable en el contrato. Ver design.md Decision 6:
       *  introducirlo es un refactor transversal de la superficie de errores y tiene
       *  que ser su propio change. Mientras tanto, el acoplamiento vive en UN lugar. */
      const SELF_CONFLICT_MARKER = 'own account';
      ```
      y usarla en `actionErrorKey()` (86) en vez del literal inline. **El valor NO cambia**:
      sigue siendo `'own account'`, y por eso el body del 409 de self del endpoint nuevo
      (tarea 3.4) es `"cannot change your own account role"` y no el
      `"cannot change your own role"` que propone el design.
      **AC**: [Scenario: El 409 de "ya tiene ese rol" no se confunde con el de
      auto-gestión].

- [x] 5.8 `dashboard/components/admin/UsersPanel.tsx`: discriminar el error de CARGA de la
      lista en dos claves (design.md Decision 7): 401 ⇒ `sessionLost` (sin cambios),
      403 ⇒ `accessRevoked` (clave nueva). Con la revalidación de rol por request el 403 en
      el listado dejó de ser hipotético: es el caso NORMAL de un admin degradado con la
      pestaña abierta, y decirle "sesión expirada" lo manda a re-loguearse — cosa que va a
      funcionar y no va a arreglar nada. Comentario en el código explicando los dos casos.
      **AC**: el escenario [Un 401/403 del LISTADO sigue tratándose como sesión perdida] de
      `specs/dashboard-ui/spec.md` quedó **superado por la Decision 7 del design**: el 401
      sigue igual, el 403 pasa a `accessRevoked`. Anotarlo para la Fase 6.

- [x] 5.9 `dashboard/components/admin/InvitationsPanel.tsx:145`: alinear `grantableRoles`
      de `<=` a `<` ESTRICTO, **con la excepción de la decisión 9**: un `superadmin` SÍ ve
      `superadmin` entre las opciones (puede invitar a otro superadmin); cualquier otro
      actor sólo ve roles estrictamente menores al propio. Verificar que el rol
      preseleccionado del formulario siga perteneciendo al conjunto de opciones (que no
      quede un default que el backend vaya a rechazar con 403) y que el componente no
      rompa si el conjunto quedara vacío.
      **AC**: [Requirement: Selector de rol al crear una invitación] del delta de
      dashboard-ui, **corregido por la decisión 9** — su escenario "Un superadmin ya no ve
      superadmin al invitar" quedó DESACTUALIZADO y se reconcilia en la Fase 6.

- [x] 5.10 `dashboard/components/admin/UsersPanel.test.tsx`: tests del selector (Vitest +
      Testing Library, patrón del archivo: mockea `@/lib/auth` con `importActual`
      manteniendo `ApiStatusError` REAL, SWR con cache fresca por test):
      - **El test que atrapa el copy-paste del `<=`**: un `admin` NO ve `admin` ni
        `superadmin` entre las opciones (ve exactamente `moderador` y `viewer`); un
        `superadmin` ve `admin`, `moderador` y `viewer` pero NO `superadmin`.
      - Toda selección abre el `AlertDialog`, promoción Y degradación.
      - Cancelar NO llama a la API y el select vuelve a mostrar el rol original.
      - Confirmar llama a `changeUserRole` con el userId y el rol correctos.
      - Selector deshabilitado por `self` y por `hierarchy`, con la razón accesible.
      - `ApiStatusError(409, 'cannot change your own account role')` ⇒ clave `self`;
        `ApiStatusError(409, 'user already has that role')` ⇒ clave `conflict`;
        403 ⇒ `hierarchy`.
      - Error 403 en la CARGA de la lista muestra `accessRevoked`; 401 sigue mostrando
        `sessionLost`.
      **AC**: [Requirement: Errores del cambio de rol traducidos y sin romper la lista].

- [x] 5.11 `dashboard/components/admin/InvitationsPanel.test.tsx` (si existe; si no, en el
      test del panel correspondiente): cubrir el filtro nuevo de 5.9 — un admin NO ve
      `admin`; un superadmin SÍ ve `superadmin` (decisión 9).

      > NO existía. Se CREÓ `dashboard/components/admin/InvitationsPanel.test.tsx`
      > con el patrón de `UsersPanel.test.tsx`. Los dos casos verificados por
      > mutación: con `<=` muere el test del admin; con `<` pelado (sin la
      > excepción de la decisión 9) muere el del superadmin.

- [x] 5.12 Correr los tests del dashboard (Vitest, incluido `messages/parity.test.ts`) y
      `tsc --noEmit`. **NUNCA `npm run build`.**

      > Vitest: **29 archivos / 323 tests verdes** (incluye `messages/parity.test.ts`
      > y el `InvitationsPanel.test.tsx` nuevo). `tsc --noEmit`: sin salida.
      > Sin `npm run build`.

---

## Phase 6: Verificación, reconciliación de artefactos y rollout

- [ ] 6.1 **Reconciliar `proposal.md`** (tarea concreta, no opcional). Quedó desactualizado
      en dos puntos:
      1. Out of Scope dice *"Cambiar el guard de invitaciones a `>` estricto ... merece su
         propio change"* — la decisión 8 del usuario lo METIÓ en este change (design.md
         Decision 10, Fase 4 de este tasks.md). Mover ese ítem de Out of Scope a In Scope.
      2. Agregar la **decisión 9** al bloque "Decisiones del usuario ya tomadas": la
         excepción de superadmin invitando superadmin, con su justificación (sin ella nadie
         puede crear un segundo superadmin por la aplicación, porque
         `_determine_bootstrap_role()` sólo dispara con la tabla vacía).
      3. Actualizar la fila de Risks sobre la "asimetría con invitaciones": ya no es una
         inconsistencia diferida, es una regla alineada CON una excepción deliberada.

- [ ] 6.2 **Reconciliar `specs/invitations/spec.md`** (tarea concreta, no opcional). Se
      escribió antes de la decisión 9 y hoy afirma lo contrario de lo implementado:
      1. [Requirement: Creación de invitación]: el texto *"NADIE invita superadmins"* pasa a
         *"sólo un superadmin invita superadmins"*. El escenario **"Un superadmin YA NO
         puede invitar a otro superadmin"** se INVIERTE: pasa a afirmar 201, sin cambio de
         comportamiento respecto de producción.
      2. [Requirement: Alineación de la suite de tests existente de invitaciones]: sacar el
         escenario "El test de superadmin invita superadmin queda invertido" — ese test NO
         se toca (tarea 4.4). El único que se invierte es el de admin-invita-admin.
      3. [Requirement: Impacto operativo del endurecimiento]: hoy dice que *"crear un
         superadmin adicional ya no es posible por ninguna vía de la aplicación"*. **Es
         falso tras la decisión 9**: sí es posible, por invitación de un superadmin a otro
         superadmin. Reescribir el requirement y su escenario para decir la verdad —
         crear un par sí, degradar un par nunca — y explicar por qué esa asimetría es la
         que preserva el contrato de no-lockout sin obligar a un `UPDATE` manual contra
         producción.

- [ ] 6.3 **Reconciliar `specs/dashboard-ui/spec.md`**: (a) el escenario "Un superadmin ya
      no ve superadmin al invitar" de [Requirement: Selector de rol al crear una
      invitación] se invierte por la decisión 9 (un superadmin SÍ lo ve); (b) el escenario
      "Un 401/403 del LISTADO sigue tratándose como sesión perdida" de [Requirement:
      Errores del cambio de rol...] queda superado por design.md Decision 7 — el 401 sigue
      en `sessionLost`, el 403 pasa a `accessRevoked`.

- [ ] 6.4 **Reconciliar `design.md` Decision 6**: dejar registrado que el body propuesto
      `"cannot change your own role"` era incorrecto (no contiene la subcadena
      `own account` que `UsersPanel.tsx:86` busca, y habría caído en la clave `conflict`) y
      que el body real es `"cannot change your own account role"`. Y agregar la decisión 9
      a Decision 10 (el guard de invitaciones no es un `>=` pelado, tiene la excepción de
      superadmin→superadmin).

- [ ] 6.5 Correr la verificación completa: `pytest` (backend), Vitest (dashboard, incluida
      la paridad ES/EN) y `tsc --noEmit`. **Nunca `npm run build`.**

- [ ] 6.6 Verificación manual **por API directa** (curl crudo, sin pasar por la UI) contra
      la API local, con usuarios de prueba sembrados y borrados al terminar: la matriz
      completa de 3.8 más la degradación y la promoción en caliente. La UI no es el
      mecanismo de seguridad, así que el enforcement se prueba sin ella.
      Nota heredada de `user-management` para reproducirlo: la cookie `session` sale con
      flag `Secure`, así que contra `http://127.0.0.1` curl (y el navegador) la descartan.
      Hay que extraer el token del `Set-Cookie` y mandarlo con `-H "Cookie: session=..."`.
      No es un bug: en producción viaja por HTTPS.

- [ ] 6.7 Verificación manual end-to-end **en la pantalla que usa el usuario**
      (`/admin/access?tab=users`, no sólo por API): promover un viewer a moderador y ver la
      lista reflejarlo tras el `mutate()`; confirmar que el `AlertDialog` aparece en
      promoción Y en degradación y nombra los dos roles; cancelar y ver el select volver al
      rol real; confirmar que un admin no ve `admin` entre las opciones. Y en el panel de
      invitaciones, que un superadmin SÍ ve `superadmin` (decisión 9).
      **Esta tarea es del USUARIO** — requiere navegador y sesión real.

- [x] 6.8 **Antes del deploy**: mirar la tabla `users` de producción. En cuanto sale este
      change, cualquier divergencia PREEXISTENTE entre el rol del JWT y el de la base (por
      algún `UPDATE` manual hecho en su momento) se vuelve efectiva de inmediato. Es
      exactamente lo que queremos, pero conviene no sorprenderse.

      Verificado el 2026-08-17 (`railway ssh --service timescaledb`, SELECT de sólo
      lectura). Cuatro usuarios, sin divergencias que sorprendan:

      | email                   | rol        | estado       |
      | ----------------------- | ---------- | ------------ |
      | `eebarcoch@gmail.com`   | superadmin | activo       |
      | `ceciliacoch@gmail.com` | moderador  | activo       |
      | `jetamclain@gmail.com`  | viewer     | activo       |
      | `eebarcoch+1@gmail.com` | viewer     | desactivado  |

      Lo que se fue a buscar y NO está: ningún usuario de prueba con rol alto. El
      `verify-phase3@example.com` que es superadmin en la base LOCAL no existe en
      producción, así que la separación local/prod está limpia.

      De paso queda demostrado el soft-delete de `user-management` en prod:
      `eebarcoch+1` tiene `deactivated_at` seteado.

- [ ] 6.9 Deploy. **Aprendizaje registrado del change anterior (`user-management`, tarea
      3.4): el orden backend→dashboard NO es controlable con la configuración actual.**
      Railway (servicio `api`, branch `main`) y Vercel (`geospectrum-dashboard`, Production
      sólo desde `main`) deployan **AMBOS automáticamente desde `main`**, así que mergear
      dispara los dos a la vez. Para respetar el orden habría que separar los commits en
      **dos merges** — decisión del usuario, no del agente.
      Acá el riesgo del orden invertido es acotado: si el dashboard llegara primero, el
      `<select>` existiría y el POST daría 404, que el `outcome` del panel muestra como
      error de acción sin romper la lista. Lo que **NO** se puede separar es el lector
      (Fase 2) del escritor (Fase 3): desplegar sólo el escritor produce cambios de rol que
      tardan hasta 24 h en tener efecto con la UI afirmando que ya cambió — peor que no
      tener la feature.
      **Sin migración que aplicar** (no hay DDL en este change), aunque
      `RUN_MIGRATIONS_ON_STARTUP=true` ya esté seteado en el servicio `api`.
      Nota: los pushes a ramas que no son `main` generan un Preview de Vercel aislado;
      `geospectrum.org` no se toca. Sirve para QA sin exponer producción.

- [x] 6.10 Smoke en producción: `POST /auth/users/{uuid}/role` sin sesión ⇒ **401 y no 404**
      (el endpoint existe, el deploy llegó); `/auth/me` ⇒ 401 y no 500 (el canario de que
      `get_user_auth_state()` no reventó contra el esquema real); `/report?area=chile` ⇒ 200
      (sin regresión del bug histórico de los 500 en el endpoint público con
      personalización, que atraviesa `get_current_user_optional()`).

      Los tres verdes el 2026-08-17 contra `api.geospectrum.org`:

      | smoke                                      | esperado     | obtenido               |
      | ------------------------------------------ | ------------ | ---------------------- |
      | `POST /auth/users/{uuid-de-ceros}/role`     | 401, no 404  | **401** `not authenticated` |
      | `GET /auth/me`                             | 401, no 500  | **401** `not authenticated` |
      | `GET /report?area=chile`                   | 200          | **200**, 109 KB, 1.6 s |

      El POST se corrió con un UUID de ceros justamente para no tocar ningún usuario
      real: lo que se mide es que el guard rechace ANTES de ir a la base. Que devuelva
      401 y no 404 prueba eso — con 404 el servidor estaría filtrando a un anónimo qué
      usuarios existen.

      El body `{"detail": ...}` (y no `{"error": ...}`) confirma de paso que el rechazo
      sale del guard en `Depends()` y no de un handler, que es la distinción de formatos
      ya documentada en el proyecto.

- [ ] 6.11 Verificación en producción con sesión de admin (**del USUARIO**): promover una
      cuenta de prueba de viewer a moderador y confirmar acceso inmediato **sin re-login**;
      degradarla y confirmar el 403 inmediato con la pestaña abierta, verificando que el
      copy que aparece sea `accessRevoked` y no `sessionLost`. Después limpiar la cuenta de
      prueba.
