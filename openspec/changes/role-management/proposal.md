# Proposal: Cambio de rol de usuarios desde la UI de administración

## Intent

`user-management` cerró la brecha de "no se puede sacar el acceso a una cuenta ya creada"
(desactivar/reactivar), pero dejó abierta la que su propio proposal difirió de forma
explícita: *"Cambio de rol de un usuario existente desde la lista (gestión de roles = otro
change)"* (`openspec/changes/user-management/proposal.md`, Out of Scope). Este change es
ese otro change.

Hoy el rol de un usuario ya creado SOLO se cambia con un `UPDATE users SET role = ...`
a mano contra la base de producción. La única vez que el sistema decide un rol es al
momento del alta: `POST /invitations` acepta un rol para la invitación y el usuario nace
con él. Después de eso el rol es inmutable por API. Consecuencias concretas:

- Promover a alguien a moderador o degradar a un admin que dejó el proyecto requiere
  abrir una consola de Postgres contra producción. Sin guards, sin trazabilidad, sin
  jerarquía: ahí adentro un `UPDATE` mal escrito crea un superadmin.
- El error se paga caro y en silencio, porque no hay ningún guard de dominio del lado
  de la base: el `CHECK` de `deploy/sql/migrations/002_add_role_hierarchy.sql:17-18`
  valida que el string sea uno de los cuatro roles, no QUIÉN lo asignó ni si podía.
- El docstring de `ROLE_LEVEL` (`src/models/user.py:36-41`) ya declara la regla —
  *"un usuario de nivel N solo puede gestionar (crear/ASIGNAR ROL A) usuarios de nivel
  ESTRICTAMENTE menor que N"* — y "asignar rol a" nunca se implementó. La regla existe
  escrita en el código desde `multi-user-auth` y no tiene enforcement.

Agravante verificado, y es el que convierte esto en algo más grande que una pantalla de
admin: **el rol viaja en el JWT y NO se revalida contra la base**.
`decode_access_token()` (`src/services/auth_service.py:805`) arma el `CurrentUser`
100% de los claims del token, con `role=UserRole(payload["role"])` en la línea 825.
`require_min_role()` (`src/api/deps.py:195`) autoriza comparando `role_level(current_user.role)`
(línea 217) sobre ESE objeto. Con `auth_token_expire_minutes = 1440`
(`src/config/settings.py:98`), degradar a un admin hoy no le saca nada: conserva permisos
de admin hasta 24 horas. Un cambio de rol que no es efectivo al instante no es un control
de acceso, es una sugerencia.

`user-management` ya pagó la mitad del costo de arreglarlo: `get_current_user()`
(`src/api/deps.py:40`) ya hace un round-trip a la base en cada request autenticado
(`await auth_service.is_user_active(current_user.id)`, línea 109), y su docstring
(60-78) ya argumenta ese round-trip con exactamente el mismo razonamiento. Falta traer el
ROL en esa misma query y sobrescribirlo.

### Decisiones del usuario ya tomadas (2026-08-16, no reabrir)

1. **Jerarquía ESTRICTA en la asignación.** Un actor solo asigna roles de nivel
   ESTRICTAMENTE MENOR al suyo. Un admin (nivel 2) promueve como máximo hasta moderador
   (1) y NUNCA a admin. Solo un superadmin crea admins.
2. **Superadmin intocable, con guard explícito PROPIO.** Nadie le cambia el rol a un
   superadmin, ni siquiera otro superadmin. Esto se implementa como un guard dedicado con
   su propia excepción de dominio (`CannotChangeSuperadminRoleError`), NO como
   consecuencia emergente del guard general `role_level(target) >= role_level(actor)`.
   Razón del usuario: que la regla sobreviva a un refactor de `ROLE_LEVEL`.
3. **Revalidación del rol en cada request.** El rol se lee de la base en
   `get_current_user()` y se SOBRESCRIBE en el `CurrentUser` devuelto. Chequear no
   alcanza: `require_min_role()` autoriza sobre `CurrentUser.role`, así que si se valida
   el rol de la base pero se devuelve el objeto armado desde el JWT, el agujero sigue
   abierto y todos los tests pasan igual.
4. **Prohibido el auto-cambio de rol.** Nadie se cambia el rol a sí mismo (contrato de
   no-lockout, mismo espíritu que el guard de auto-desactivación).
5. **Endpoint `POST /auth/users/{user_id}/role`** con body JSON `{"role": "..."}` y
   respuesta 204 sin cuerpo. Simétrico con `deactivate`/`reactivate`; la UI refetchea con
   `mutate()` de SWR.
6. **Confirmación SIEMPRE.** CUALQUIER cambio de rol (promoción o degradación) abre un
   `AlertDialog`. El usuario eligió esto por encima de la recomendación de "confirmar solo
   al degradar": es una acción sobre permisos y un click errado no debe cambiar quién
   administra el sistema.
7. **Método ADITIVO en `auth_service`.** NO se cambia la firma de `is_user_active()`
   (`src/services/auth_service.py:1191`). Se agrega un método nuevo que devuelve estado +
   rol en UNA sola query y se mantiene `is_user_active()` (o se reimplementa sobre el
   nuevo) para no romper los fakes existentes.

## Scope

### In Scope

- **SIN MIGRACIÓN.** `users.role` existe desde la migración 001 y el `CHECK` de
  `deploy/sql/migrations/002_add_role_hierarchy.sql:17-18` ya cubre los cuatro valores.
  No hay DDL en este change.
- **Modelo del request**: `RoleChangeRequest` nuevo en `src/models/user.py` para el body
  `{"role": "..."}`. `UserProfileUpdate` (línea 228) NO se toca: excluye `role` a
  propósito y lo documenta (233-238) — el rol es una decisión de administración, no de
  perfil propio.
- **`change_user_role()` en `AuthService`**, con la misma forma que `deactivate_user()`
  (1291) / `reactivate_user()` (1315): `acquire` → `transaction` →
  `_load_manageable_target()` (1251, el `SELECT ... FOR UPDATE` de la línea 1280) →
  guards → `UPDATE`. El orden self → 404 → jerarquía de `_load_manageable_target()`
  (1263-1274) se reutiliza tal cual y NO se reordena.
- **Guards nuevos**, que son reglas distintas de las que ya existen:
  - **Rol SOLICITADO vs. actor** (decisión 1): `_load_manageable_target()` valida el rol
    ACTUAL del target (1286); el cambio de rol necesita además rechazar cuando
    `role_level(new_role) >= role_level(actor.role)`. Precedente a imitar:
    `CannotInviteHigherRoleError` (`src/services/invitation_service.py:115`), que ya
    valida un rol solicitado.
  - **Target superadmin** (decisión 2): `CannotChangeSuperadminRoleError`, guard dedicado
    y explícito.
  - **No-op** (target ya tiene ese rol): rechazo explícito con 409, por el precedente de
    `UserAlreadyDeactivatedError` (`auth_service.py:153`, *"rechazo explícito y no un
    no-op silencioso"*).
  - **Auto-cambio** (decisión 4): heredado del guard self de `_load_manageable_target()`.
- **Revalidación del rol en el camino caliente** (decisión 3 + 7): método aditivo en
  `AuthService` que devuelve `(activa, rol)` en una query, y `get_current_user()`
  (`deps.py:40`) devolviendo un `CurrentUser` con el rol de la BASE, no el del JWT.
  `require_min_role()` (195) NO se toca: queda correcto por construcción si y solo si
  `get_current_user()` sobrescribe. `get_current_user_optional()` (118) NO SE TOCA:
  hereda la revalidación por delegación (158) y tiene un bug documentado de 500 en
  `/report` por un `Depends()` propio (133-141, 147-151).
- **Endpoint `POST /auth/users/{user_id}/role`** en `src/main.py`, dentro del bloque de
  users que arranca en 1415, con `require_min_role(UserRole.ADMIN)`, `status_code=204` Y
  `response_model=None` (el comentario de 1451-1456 explica que sin eso FastAPI FALLA AL
  IMPORTAR con *"Status code 204 must not have a response body"*; mypy no lo detecta).
  Labels de métrica siempre literales, nunca el UUID interpolado (1425-1427).
- **UI en `dashboard/components/admin/UsersPanel.tsx`**: selector de rol por fila +
  `AlertDialog` de confirmación en TODO cambio (decisión 6). Se respetan los patrones ya
  establecidos del panel: outcome como `kind` + datos y nunca texto resuelto (61-64),
  `actionErrorKey()` (77) para mapear status → clave i18n, `disabledReasonFor()` (98,
  exportada y testeada directo), `busyId` (132) para deshabilitar solo la fila afectada, y
  el contrato de accesibilidad `title` + `sr-only` + `aria-describedby` (289-294, 340-344).
- **Selector con `<select>` NATIVO**, no Radix: no hay componente `Select` en
  `dashboard/components/ui/` y el proyecto ya resolvió esto en `InvitationsPanel.tsx`
  (~306-318), con comentario explicando que un `DropdownMenu` de Radix pelea con inputs
  (el typeahead se come las teclas).
- **Cliente**: `changeUserRole(userId, role)` en `dashboard/lib/auth.ts`, copia directa de
  `deactivateUser` (464) / `reactivateUser` (480) más body JSON y `Content-Type`.
- **i18n**: claves nuevas en `admin.users.*` con paridad ES/EN exacta
  (`dashboard/messages/parity.test.ts` la exige). Las etiquetas de rol se heredan gratis:
  `admin.roles.*` ya tiene las cuatro.
- **Tests**: unit contra Postgres real siguiendo `tests/unit/test_user_management.py`
  (incluye ORDEN de guards y concurrencia, ver `test_two_concurrent_deactivations_leave_exactly_one_winner`
  en 294 y `test_a_superadmin_is_unreachable_by_every_actor` en 239); integración en
  `tests/integration/test_users_api.py` **agregando el endpoint nuevo a `PROTECTED_ENDPOINTS`
  (línea 43)**, que maneja el sweep parametrizado de 401/403; frontend en
  `dashboard/components/admin/UsersPanel.test.tsx`.

### Out of Scope

- **Migración de base de datos**: no hace falta ninguna (ver arriba).
- **Cambiar el guard de invitaciones a `>` estricto.** Verificado:
  `src/services/invitation_service.py:251` usa `role_level(role) > role_level(invited_by.role)`,
  o sea que hoy un admin PUEDE invitar a otro admin. Esa asimetría con la decisión 1
  (asignar exige `<` estricto) es real y queda documentada, pero cambiarla es tocar un
  flujo en producción y merece su propio change.
- **Renombrar `CannotDeactivateSelfError`** (`auth_service.py:132`). Con un tercer caller
  el nombre queda engañoso; la decisión entre renombrar a `CannotManageSelfError` (toca
  endpoints y tests existentes) o agregar una excepción hermana se toma en `design.md`,
  no acá.
- **Audit log de quién cambió el rol de quién.** No hay columnas `role_changed_by` /
  `role_changed_at`; misma postura que `user-management` tomó con `deactivated_by`.
- **Notificación por email al usuario promovido o degradado.**
- **Mensaje de éxito en el panel.** Hoy `UsersPanel` refetchea en silencio; agregar
  feedback positivo sería un patrón nuevo para TODAS las acciones del panel, no solo esta.
- **Cambio de rol masivo / multi-selección.**
- **Redirect en caliente del dashboard ante 401/403.** Limitación conocida y preexistente
  del middleware (solo corre en navegación); este change la expone más, no la introduce.
- **Cache/TTL para evitar el round-trip por request.** Ya está diferido explícitamente en
  `user-management` design.md Decision 4 y la query no cambia de costo: es la MISMA query,
  con una columna más.

## Approach

Dos piezas que se necesitan mutuamente: el **escritor** y el **lector**.

**Escritor** — un método más en `AuthService` con la forma exacta de sus dos hermanos, que
reutiliza `_load_manageable_target()` para el `FOR UPDATE` y los guards de self / 404 /
jerarquía-sobre-rol-actual, y le suma tres guards propios en orden explícito: superadmin
intocable (dedicado, decisión 2), rol solicitado `>=` al del actor (decisión 1), y no-op.
El endpoint es un clon estructural de `deactivate`: 204, `response_model=None`, mapeo de
excepción de dominio → status, métricas con labels literales.

**Lector** — el rol deja de ser un claim en el que se confía. `is_user_active()` hoy
responde un booleano; se agrega al lado un método que devuelve estado + rol en la MISMA
query (decisión 7: aditivo, la firma vieja no se toca porque hay al menos tres fakes que
la definen). `get_current_user()` usa el nuevo y devuelve un `CurrentUser` con el rol de
la base. El punto fino que decide si esto sirve o no: hay que SOBRESCRIBIR el campo, no
solo compararlo. Un `if db_role != token_role: raise` seguido de `return current_user`
(el objeto del JWT) deja el sistema exactamente igual de roto y con los tests en verde,
porque `require_min_role()` lee `CurrentUser.role`. Por eso el criterio de éxito se
escribe sobre el comportamiento observable — un token viejo con rol viejo recibe 403 en
el request siguiente — y no sobre "se chequea el rol".

Sin el lector, el escritor produce un cambio de rol que tarda hasta 24 horas en tener
efecto. Sin el escritor, el lector es un round-trip que no sirve para nada. Van juntos en
el mismo change y en el mismo deploy.

**UI** — una columna más en la tabla del panel: un `<select>` nativo con los roles
otorgables. El cálculo de "otorgables" es donde está la trampa: `grantableRoles` en
`InvitationsPanel.tsx:145` filtra con `ROLE_LEVEL[r] <= ROLE_LEVEL[user.role]`. Copiar ese
memo verbatim viola la decisión 1 en la UI, en silencio y sin romper ningún test. Acá el
filtro es `<` ESTRICTO. Igual, la UI no es el enforcement: el backend rechaza y la UI solo
evita ofrecer lo imposible.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `deploy/sql/migrations/` | **Sin cambios** | `users.role` y su `CHECK` ya existen (001 + 002) |
| `src/models/user.py` | Modified | `RoleChangeRequest` nuevo. `UserListItem` (129) ya expone `role` (154); `UserProfileUpdate` (228) NO se toca |
| `src/services/auth_service.py` | Modified | `CannotChangeSuperadminRoleError`, `CannotAssignHigherOrEqualRoleError`, `UserAlreadyHasRoleError`, `change_user_role()`, método aditivo estado+rol junto a `is_user_active()` (1191) |
| `src/api/deps.py` | Modified | `get_current_user()` (40) SOBRESCRIBE `CurrentUser.role` con el rol de la base. `get_current_user_optional()` (118) y `require_min_role()` (195) sin cambios |
| `src/main.py` | Modified | `POST /auth/users/{user_id}/role` en el bloque de users (desde 1415), 204 + `response_model=None`, mapeo de las excepciones nuevas |
| `dashboard/components/admin/UsersPanel.tsx` | Modified | Columna de rol con `<select>` nativo, `AlertDialog` en todo cambio, `grantableRoles` con `<` estricto, outcome/`busyId`/a11y existentes |
| `dashboard/lib/auth.ts` | Modified | `changeUserRole(userId, role)` |
| `dashboard/lib/types.ts` | Modified | Tipo del payload de cambio de rol (`UserRole` en 116 y `ROLE_LEVEL` en 120 ya existen) |
| `dashboard/messages/{es,en}.json` | Modified | Claves nuevas bajo `admin.users.*` con paridad; `admin.roles.*` se reutiliza |
| `tests/unit/test_user_management.py` | Modified | Guards, orden de guards y concurrencia del cambio de rol |
| `tests/integration/test_users_api.py` | Modified | Endpoint nuevo en `PROTECTED_ENDPOINTS` (43) + casos de jerarquía por API directa |
| `tests/unit/test_deps.py` | Modified | Que `get_current_user()` devuelva el rol de la BASE, no el del token |
| `dashboard/components/admin/UsersPanel.test.tsx` | Modified | Selector, confirmación, deshabilitados y errores |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| **El agujero silencioso**: implementar la revalidación como "chequeo" y no como sobrescritura del campo. Todos los tests pasan y el sistema queda igual de roto. | **High** | Es el riesgo principal del change y por eso es la decisión 3. Se mitiga con un test que NO mira la implementación: emitir un token con rol admin, degradar al usuario en la base, y exigir 403 en el próximo request a un endpoint `require_min_role(ADMIN)`. Un chequeo-sin-sobrescritura no puede pasar ese test. |
| **Blast radius en el camino caliente**: `get_current_user()` lo atraviesa TODA la app autenticada, no solo `/admin`. Un bug acá no rompe una pantalla, rompe el login efectivo de todos. | High (alcance), Low (probabilidad) | El round-trip ya existe desde `user-management`; este change agrega una columna al `SELECT`, no una query. La cobertura de `deps` es la red: `tests/unit/test_deps.py` más el sweep parametrizado de `PROTECTED_ENDPOINTS`. |
| **Romper los fakes de `is_user_active`**: `tests/unit/test_deps.py:75`, `tests/integration/test_auth_api.py:63` e `tests/integration/test_invitations_api.py:207` (estos dos con `AsyncMock(return_value=True)`) definen el método. Cambiarle la firma rompe todo. | High (certeza si se cambia la firma) | Decisión 7: el método nuevo es ADITIVO y `is_user_active()` sobrevive. Igual hay que barrer `test_locale_api.py` y `test_areas_api.py` por si definen su propio fake. |
| **MagicMock truthy**: precedente directo de este proyecto — en `user-management` los `MagicMock` rompieron 65 tests porque `deactivated_at` daba truthy. Un fake que devuelva un `MagicMock` donde ahora se espera un rol produce el mismo tipo de falla en cascada. | Medium | Los fakes nuevos devuelven valores concretos (`UserRole`), nunca `MagicMock`. El patrón híbrido de `tests/integration/test_users_api.py` (documentado en 17-24: `AuthService` REAL contra Postgres real, *"is_user_active NO se mockea nunca"*) es el que evita esto de raíz. |
| **Degradación instantánea + dashboard sin redirect en caliente**: el usuario degradado empieza a comer 403 en pantallas que ya tiene abiertas y no se lo redirige. Peor: el copy `sessionLost` (`UsersPanel.tsx:137-138`) dice "sesión expirada", que en este caso es engañoso. | Medium | Es la limitación conocida y preexistente del middleware (solo corre en navegación). Se acota al copy: revisar si `sessionLost` cubre el caso de degradación o si hace falta una clave propia — decisión de `design.md`. El redirect en caliente sigue fuera de alcance. |
| **`actionErrorKey()` discrimina el 409 por el TEXTO del mensaje** (`UsersPanel.tsx:86`). El change agrega un 409 nuevo (no-op de rol) sobre un mapeo ya acoplado a strings del backend. | Medium | Acoplamiento frágil preexistente. `design.md` decide si el 409 nuevo entra en ese `switch` por texto o si conviene un código de error estable; en cualquier caso, test que cubra el 409 nuevo llegando a la clave i18n correcta. |
| **Copiar `grantableRoles` verbatim** de `InvitationsPanel.tsx:145` (`<=`) viola la decisión 1 en la UI sin romper nada visible. | Medium | Llamado por nombre en el proposal, en `design.md` y en un test de `UsersPanel.test.tsx` que exija que un admin NO vea "admin" entre las opciones otorgables. El backend rechaza igual, así que el impacto es UX, no seguridad. |
| **Asimetría con invitaciones**: invitar usa `>` (un admin invita a otro admin), asignar va a usar `>=`. Dos reglas distintas para "quién puede tener rol X". | Low (impacto) | Documentada explícitamente en Out of Scope. Es una inconsistencia real y conocida, no un descuido; se resuelve en un change propio para no tocar un flujo productivo de rebote. |
| **Olvidar `response_model=None`** en el endpoint 204. | Low | FastAPI FALLA AL IMPORTAR, así que revienta en el primer test que levanta la app. Ruidoso, barato, imposible de mergear sin verlo. |

## Rollback Plan

1. **Sin migración, sin rollback de datos.** Este change no toca el esquema. Los cambios
   de rol ya aplicados quedan como están: son valores válidos de `users.role` y el `CHECK`
   de la 002 los acepta. Si hiciera falta deshacer una asignación puntual, es un `UPDATE`
   manual, exactamente el mismo mecanismo que existe hoy.
2. **Código**: revertir los commits del change. El sistema vuelve al estado actual
   (`user-management` en producción): sin endpoint de rol, y `get_current_user()`
   volviendo a confiar el rol al JWT. Estado conocido y hoy en producción.
3. **Cuidado con el orden en un revert parcial**: revertir SOLO la revalidación de
   `deps.py` dejando el endpoint vivo produce lo peor de los dos mundos — se puede cambiar
   el rol pero tarda hasta 24 horas en tener efecto, con la UI diciendo que ya cambió. El
   revert es del change completo o de nada.
4. **UI/i18n**: se revierten con el código; las claves nuevas desaparecen de ambos
   diccionarios a la vez y la paridad no se rompe.

## Dependencies

- `multi-user-auth`, `email-invitations` y `user-management` mergeados y en producción:
  `ROLE_LEVEL`/`require_min_role`, la jerarquía del rol invitado, el bloque de endpoints
  `/auth/users*`, `_load_manageable_target()` con su `FOR UPDATE`, `UsersPanel` y su
  suite de tests.
- Sin dependencias npm ni Python nuevas. Sin componente `Select` de Radix: se usa
  `<select>` nativo, como ya hace `InvitationsPanel`.
- Sin migración de base de datos.

## Success Criteria

- [ ] Un admin puede promover a un viewer a moderador desde `/admin/access?tab=users`, y
      la lista refleja el rol nuevo tras el `mutate()`.
- [ ] Un admin NO puede asignar el rol admin: ni por UI (no aparece entre las opciones) ni
      por API directa (403 verificado con request crudo, no solo con botón deshabilitado).
- [ ] Nadie puede cambiarle el rol a un superadmin, incluido otro superadmin, y el rechazo
      viene del guard dedicado (`CannotChangeSuperadminRoleError`) — no como efecto lateral
      del guard general de jerarquía.
- [ ] Nadie puede cambiarse el rol a sí mismo (403), verificado por API directa.
- [ ] Asignar a un usuario el rol que YA tiene responde 409 explícito, no un 204 silencioso.
- [ ] **La prueba que decide el change**: emitir un token con rol admin, degradar a ese
      usuario a viewer en la base, y verificar que el SIGUIENTE request a un endpoint
      `require_min_role(ADMIN)` devuelve 403 — sin esperar los 1440 minutos de expiración
      y sin re-login.
- [ ] Promover en caliente también es efectivo al instante: un viewer promovido a moderador
      pasa los `require_min_role(MODERADOR)` con su token viejo.
- [ ] `is_user_active()` conserva su firma y los fakes existentes de `tests/unit/test_deps.py`,
      `tests/integration/test_auth_api.py` y `tests/integration/test_invitations_api.py`
      siguen funcionando sin reescribirse.
- [ ] El endpoint nuevo está en `PROTECTED_ENDPOINTS` (`tests/integration/test_users_api.py:43`)
      y pasa el sweep parametrizado de 401/403.
- [ ] Todo cambio de rol (promoción Y degradación) pasa por el `AlertDialog`.
- [ ] Paridad ES/EN verde (`dashboard/messages/parity.test.ts`) con las claves nuevas.
- [ ] Verificación: `pytest` verde, `vitest` verde y `tsc --noEmit` limpio. No se corre
      `npm run build`.
