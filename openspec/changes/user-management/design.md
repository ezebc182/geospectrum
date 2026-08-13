# Design: Gestión de usuarios con desactivación/reactivación (soft-delete)

## Technical Approach

Una columna nullable (`users.deactivated_at`) como única fuente de verdad, más UN punto
central de enforcement por cada superficie de entrada:

1. **Login password** (`POST /auth/login`, `src/main.py:1014`): guard después de verificar
   la password, antes de la rama de 2FA y de cualquier `set_cookie`.
2. **Login Google** (`GET /auth/google/callback`, `src/main.py:1734`): guard dentro de
   `AuthService.resolve_or_create_google_user()`, que levanta `AccountDeactivatedError`;
   el endpoint la mapea al error-redirect existente.
3. **Sesiones ya emitidas** (`get_current_user()`, `src/api/deps.py:40`): verificación
   contra la base en cada request autenticado.

Los tres endpoints de administración se suman al bloque de auth de `src/main.py` con
`require_min_role(UserRole.ADMIN)` — la dependencia ya existe y ya cubre admin+superadmin
(mismo criterio que usó `email-invitations`: `deps.py` no se toca por permisos).

## Hallazgo que condiciona TODO el diseño

`get_current_user()` **NO pega a la base hoy**. Verificado en `src/api/deps.py:60-87`: el
flujo completo es `request.cookies.get("session")` → `decode_token_payload()` → guard de
`pending_2fa` → `decode_access_token()` → `CurrentUser`. Todo se resuelve del JWT, sin
`asyncpg`. El único endpoint que hace un round-trip por request es `/auth/me`, que llama
a `auth_service.get_onboarding_status()` — y lo hace por la razón exacta que aplica acá:
un dato mutable no puede viajar como claim porque queda stale hasta el re-login
(`src/models/user.py`, docstring de `MeResponse`).

Consecuencia dura: con `auth_token_expire_minutes = 1440` (`src/config/settings.py:98`),
una cuenta desactivada sin este chequeo seguiría teniendo acceso pleno hasta **24 horas**.
Un soft-delete que no invalida las sesiones vivas no es un soft-delete, es un cartel.

## Architecture Decisions

### Decision 1: Soft-delete con `deactivated_at TIMESTAMPTZ` nullable, no un booleano

**Choice**: columna `deactivated_at TIMESTAMPTZ` nullable; `NULL` = activa.
**Alternatives considered**: `is_active BOOLEAN NOT NULL DEFAULT true`; tabla de estados.
**Rationale**: el timestamp lleva la misma información que el booleano MÁS el cuándo, sin
costo. Un booleano obliga a agregar después una columna de fecha cuando alguien pregunte
"¿desde cuándo?". Además la nulabilidad es idéntica en semántica a la que el proyecto ya
usa para `users.onboarding_completed_at` (migración 007) y a `invitations.revoked_at`
(007): "NULL = todavía no pasó". Es el patrón de la casa, no una invención.

Sin `deactivated_by`: la trazabilidad de quién actuó es deseable pero el usuario no la
pidió, y agregarla es un `ADD COLUMN` trivial después. Se documenta como out of scope.

### Decision 2: Migración `012_user_deactivation.sql`, manual e idempotente

**Choice**: archivo nuevo `deploy/sql/migrations/012_user_deactivation.sql`, con
`ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;` y el rollback
documentado como comentario al pie.
**Alternatives considered**: Alembic (no existe en el proyecto); editar una migración
previa (prohibido: es historia ya aplicada, ver header de 002 y 003).
**Rationale**: 012 es el próximo número libre (verificado: el directorio llega a
`011_user_and_beta_locale.sql`). Las migraciones se aplican solas al arranque de la API
(`scripts/apply_migrations.py`, commit `0a335ef`) y los tests las corren enteras por glob
alfabético (`tests/conftest.py::_migrated`) — la 012 entra en ambos lados sin tocar nada.

Rollback limpio, sin las advertencias condicionales de 002/003: la columna es nullable,
sin constraint ni FK entrante. `ALTER TABLE users DROP COLUMN IF EXISTS deactivated_at;`
y listo (efecto: los desactivados vuelven a entrar, que es exactamente el estado
pre-change).

**Sin CHECK ni índice**: no hay valores inválidos que restringir, y la consulta caliente
es por PK (`WHERE id = $1`), ya indexada. Un índice sobre `deactivated_at` para "listar
desactivados" es innecesario con decenas de filas.

### Decision 3: Bloqueo del login password DESPUÉS de verificar la password (no-enumerante)

**Choice**: en `POST /auth/login`, el orden es: buscar usuario → verificar password →
si ambas OK y `deactivated_at IS NOT NULL` → 403 `{"error": "account deactivated"}`.
Con password incorrecta o email inexistente, el 401 genérico de siempre.
**Alternatives considered**: (a) 403 apenas se encuentra el usuario desactivado, sin
mirar la password; (b) 401 genérico también para desactivados.
**Rationale**: (a) convierte el endpoint en un oráculo de enumeración: cualquiera podría
mandar `{email, password: "x"}` y distinguir "existe y está desactivado" de "no existe".
El endpoint documenta explícitamente en su docstring que el mensaje debe ser
indistinguible — no lo rompemos. (b) es seguro pero cruel: el dueño legítimo de la cuenta
(que probó su identidad con la password correcta) merece saber por qué no entra, en lugar
de pelearse con un "credenciales inválidas" mentiroso. El punto medio es el estándar: el
mensaje explícito solo tras autenticación exitosa.

Ubicación exacta: entre el bloque `if user is None or not password_ok` (línea ~1043) y el
`if user.totp_enabled` (línea ~1056). Crítico que sea ANTES del bloque de 2FA: si no, una
cuenta desactivada con 2FA recibiría la cookie `pending_2fa_session` — una sesión parcial
emitida a alguien sin acceso.

### Decision 4: Invalidación de sesiones vivas = chequeo por request en `get_current_user()`

**Choice**: `get_current_user()` agrega, tras decodificar el JWT, un
`await auth_service.is_user_active(user_id)` que hace
`SELECT deactivated_at FROM users WHERE id = $1` y responde 401 genérico si la fila no
existe o `deactivated_at IS NOT NULL`.
**Alternatives considered**:
- **Token version / jti blacklist en Redis**: invalidación sin tocar Postgres. Rechazado:
  agrega una dependencia dura de Redis al camino de autenticación, cuando en este proyecto
  Redis es deliberadamente best-effort (`event_bus`, el limitador de 2FA); un Redis caído
  no puede tirar abajo la autenticación entera.
- **Bajar `auth_token_expire_minutes`**: mitiga sin resolver (la ventana se achica, no se
  cierra) y degrada la UX de todos los usuarios por el caso raro.
- **Chequear solo en endpoints sensibles**: deja un colador. Cualquier endpoint olvidado
  es un bypass.
- **Cache en memoria con TTL corto**: multi-worker en Railway ⇒ cada worker con su propia
  vista; un TTL de 60 s vuelve a abrir la ventana. Diferido, no descartado, si el costo
  se vuelve medible.

**Rationale**: es un `SELECT` por PK, que en la beta (decenas de usuarios, tráfico bajo)
es ruido comparado con las llamadas a USGS/EMSC que domina `/report`. `/auth/me` ya paga
exactamente este costo hoy y nadie lo notó. Y el chequeo cierra de regalo un agujero
preexistente: hoy el JWT de una cuenta borrada con `DELETE /account` sigue siendo válido
hasta 24 h.

`get_current_user_optional()` **no se toca**: delega en `get_current_user()` (patrón
explícitamente documentado en su docstring como "la validación vive en UN solo lugar") y
se traga solo el 401, así que un usuario desactivado pasa a ser tratado como anónimo en
`/report`. Gratis, y sin duplicar la lógica.

**Nota de implementación crítica** (bug documentado en `deps.py`): el `auth_service` en
`get_current_user()` viene por `Depends(_get_auth_service)`, que se resuelve ANTES del
cuerpo. Eso está bien acá porque `get_current_user()` ya es un endpoint privado. Lo que
NO hay que hacer es replicar ese `Depends` en `get_current_user_optional()` — ese es
exactamente el bug que convirtió `/report` en un 500 (memoria del proyecto:
"un Depends() se resuelve antes del try").

### Decision 5: `AccountDeactivatedError` levantada desde `resolve_or_create_google_user()`

**Choice**: el guard del camino Google vive en `AuthService.resolve_or_create_google_user()`
(`src/services/auth_service.py:472`), que levanta una excepción de dominio nueva; el
endpoint la captura y responde `_google_error_redirect("account_deactivated")`.
**Alternatives considered**: chequear en el endpoint tras resolver el usuario.
**Rationale**: exactamente el patrón que ya estableció `email-invitations` con
`InvitationRequiredError` (`src/main.py:1824`). Además, el guard DEBE estar adentro del
método porque ese método ESCRIBE: refresca `name`/`avatar_url` (línea ~519) y hace el
auto-link de `google_id` (línea ~548). Chequear afuera significaría que el intento de
login de una cuenta desactivada igual le modifica filas. El guard va después del `SELECT`
que resuelve al usuario (por `google_id` o por email) y antes de cualquier `UPDATE`.

Contraste deliberado con `InvitationRequiredError`: aquella se levanta cuando NO hay
usuario; ésta cuando SÍ hay usuario pero está desactivado. Son ramas distintas del mismo
método y no se pisan.

Código de error: `account_deactivated` (sin prefijo `google_`, a diferencia de
`google_oauth_*`), porque la causa no es del flujo de Google sino de la cuenta — el mismo
criterio con el que `email-invitations` eligió `google_no_invitation`... que sí lleva
prefijo. Se elige `account_deactivated` porque el frontend lo reusa para el 403 del login
por password: un solo código, un solo mensaje, los dos caminos.

### Decision 6: Guards de jerarquía en el servicio, con la misma regla que las invitaciones

**Choice**: `deactivate_user(actor, target_id)` valida, en este orden:
1. `target_id == actor.id` → `CannotDeactivateSelfError` → **409**
2. target no existe → `UserNotFoundError` → **404**
3. `role_level(target.role) >= role_level(actor.role)` → `CannotManageHigherOrEqualRoleError`
   → **403**
4. ya desactivado → `UserAlreadyDeactivatedError` → **409**

**Alternatives considered**: permitir gestionar iguales (admin desactiva admin); permitir
solo a superadmin.
**Rationale**: es la regla que el proyecto ya escribió, en `src/models/user.py`:
"un usuario de nivel N solo puede gestionar usuarios de nivel ESTRICTAMENTE menor que N.
Nadie gestiona su propio nivel ni uno igual o superior" — y que `email-invitations`
implementó como `CannotInviteHigherRoleError`. Aplicar otra regla acá sería incoherente:
un admin no puede INVITAR a un superadmin pero podría DESACTIVAR a uno.

Consecuencia que hay que decir en voz alta: **nadie puede desactivar a un superadmin**
(ni otro superadmin, porque nivel igual también está prohibido). Es deseable: un
superadmin comprometido no puede decapitar a los demás. Y hace innecesario el guard de
"último superadmin" que sí existe en `delete_account()` — por construcción, no por
omisión.

El chequeo de auto-desactivación va PRIMERO, antes del 404, porque un actor autenticado
siempre existe: si el id coincide con el suyo, la causa real es "te estás desactivando a
vos mismo", no "no existe". El 409 (conflicto de estado) se elige sobre 403 porque no es
una falta de permisos: un superadmin tiene TODO el permiso del mundo y aun así no puede.

`reactivate_user()` aplica los mismos guards 2 y 3 (jerarquía y existencia), no el 1: si
estás autenticado, tu cuenta está activa por Decision 4, así que auto-reactivarse es
inalcanzable — pero se valida igual por simetría y para no depender de una invariante de
otra capa.

### Decision 7: Usuarios como TERCERA PESTAÑA de `/admin/access`, no página nueva

**Choice**: `dashboard/app/(app)/admin/access/page.tsx` pasa de 2 a 3 pestañas
(`waitlist | invitations | users`), con `dashboard/components/admin/UsersPanel.tsx` nuevo.
La ruta `/admin/users` NO se crea; el deep-link es `/admin/access?tab=users`.
**Alternatives considered**: página nueva `/admin/users` con entrada propia en el sidebar
(la letra del pedido del usuario).
**Rationale**: evidencia del código — la página `/admin/access` existe porque el proyecto
YA hizo el camino inverso hace pocos días: `/beta` y `/admin/invitations` eran páginas
separadas con dos entradas de sidebar y se unificaron en una sola sección con pestañas
(docstring de `access/page.tsx`: "el sidebar tiene UNA entrada 'Accesos' en lugar de
dos"). Crear ahora `/admin/users` como página suelta sería re-fragmentar lo que se acaba
de unificar, 3 días después.

Además el flujo es UNO y es secuencial: landing → **lista de espera** → **invitación** →
**usuario**. Las tres pestañas son las tres etapas de la misma vida del acceso, en orden.
La pestaña de usuarios es literalmente el final del embudo que las otras dos empiezan.

Mitigación del pedido literal: si el usuario quiere igual la URL `/admin/users`, un
`redirect` a `/admin/access?tab=users` es una línea — el proyecto ya tiene ese patrón
exacto para `/beta` y `/admin/invitations`. Se deja como tarea opcional en Fase 2.

### Decision 8: Endpoints `/auth/users*` en `src/main.py`, no un router nuevo

**Choice**: los tres endpoints van al bloque de auth de `src/main.py`, con el mismo shape
de errores (`JSONResponse` + `{"error": ...}`) y las mismas métricas
(`requests_total.labels(endpoint=..., status=...)`).
**Alternatives considered**: `src/api/routers/users.py` (existe `routers/areas.py`).
**Rationale**: los 6 endpoints de `/auth/invitations` viven en `main.py`; partir los de
usuarios a un router dejaría el dominio auth en dos lugares. `main.py` documenta que
migrar los `@app.get` a routers es "un refactor de toda la superficie" fuera de alcance
de un change funcional (línea ~410). Se sigue el patrón existente.

Rutas: `GET /auth/users`, `POST /auth/users/{user_id}/deactivate`,
`POST /auth/users/{user_id}/reactivate`. Verbo `POST` (no `DELETE`) a propósito:
desactivar no borra, y `DELETE` ya significa otra cosa en este proyecto
(`DELETE /account` = hard-delete propio). Métrica con label literal
`/auth/users/{id}/deactivate` (sin interpolar el UUID), igual que
`/auth/invitations/{id}/resend`, para no explotar la cardinalidad de Prometheus.

### Decision 9: `UserListItem` como response model — los secretos no entran por tipo

**Choice**: modelo nuevo en `src/models/user.py`:

```python
class UserListItem(BaseModel):
    id: UUID
    email: EmailStr
    role: UserRole
    name: Optional[str] = None
    avatar_url: Optional[str] = None
    has_google: bool
    has_password: bool
    created_at: datetime
    deactivated_at: Optional[datetime] = None
```

**Alternatives considered**: reusar `UserPublic`; devolver dicts.
**Rationale**: `UserPublic` no tiene `deactivated_at` ni `created_at` y se usa en
responses de login — extenderlo contaminaría el contrato de auth con campos de
administración. Un tipo dedicado hace que `password_hash`/`totp_secret` sean
inexpresables por construcción, exactamente el argumento que el proyecto usa para
`InvitationPublic` vs tokens.

`has_google`/`has_password` como booleanos derivados (`google_id IS NOT NULL`,
`password_hash IS NOT NULL`) en vez de exponer `google_id`: el admin necesita saber CÓMO
entra la persona (para entender qué le bloquea la desactivación), no el identificador de
Google. Menos superficie, misma utilidad.

`UserInDB` suma `deactivated_at: Optional[datetime] = None` (con default, mismo criterio
que `totp_enabled`: no rompe construcciones manuales en tests) porque el guard del login
password lo lee desde ahí — `get_user_by_email()` debe agregarlo a su `SELECT`.

### Decision 10: i18n — claves nuevas bajo `admin.users.*`, paridad obligatoria

**Choice**: claves nuevas en `dashboard/messages/{es,en}.json`:
- `admin.access.tabs.users`
- `admin.users.*` (title, description, empty, loadError, columnas, estados
  `active`/`deactivated`, origen `google`/`password`, acciones, copy del `AlertDialog`,
  razones de deshabilitado, errores por status)
- `auth.oauthErrors.accountDeactivated`

`admin.roles.*` ya existe y se reusa tal cual.
**Rationale**: `messages/parity.test.ts` compara sets de claves aplanadas en AMBAS
direcciones y falla con valores vacíos — no hay margen para "el inglés después". Y el
patrón de `InvitationsPanel` es explícito: el estado guarda el OUTCOME (kind + datos), no
el texto resuelto, para que un cambio de idioma en caliente re-traduzca lo ya mostrado.
`UsersPanel` lo copia.

## Data Flow

Desactivación y sus tres efectos:

    Admin (UI, tab=users)
      │  POST /auth/users/{id}/deactivate
      ▼
    require_min_role(ADMIN) ──403──> viewer/moderador
      │
      ▼
    AuthService.deactivate_user(actor, target_id)
      ├─ self? ────────────────── 409
      ├─ not found? ───────────── 404
      ├─ level(target) >= level(actor)? ── 403
      ├─ ya desactivada? ──────── 409
      └─ UPDATE users SET deactivated_at = now() WHERE id = $1
                     │
                     ▼
         ┌───────────┴────────────┬─────────────────────┐
         ▼                        ▼                     ▼
    POST /auth/login       GET /auth/google/callback   get_current_user()
    (password OK           resolve_or_create_          (CADA request con
     + deactivated)         google_user() levanta       cookie session)
         │                  AccountDeactivatedError         │
         ▼                        │                         ▼
       403                        ▼                   SELECT deactivated_at
    account deactivated    302 /login?                FROM users WHERE id=$1
    sin cookie             error=account_deactivated        │
                           sin cookie, sin UPDATE           ▼
                                                      401 not authenticated
                                                      (sesión viva muere en
                                                       el request siguiente)

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `deploy/sql/migrations/012_user_deactivation.sql` | Create | `users.deactivated_at TIMESTAMPTZ` nullable + rollback documentado |
| `src/models/user.py` | Modify | `UserListItem` nuevo; `UserInDB.deactivated_at` |
| `src/services/auth_service.py` | Modify | Excepciones nuevas; `deactivated_at` en `get_user_by_email`/`get_user_by_id`; guard en `resolve_or_create_google_user()`; `is_user_active()`, `list_users()`, `deactivate_user()`, `reactivate_user()` |
| `src/api/deps.py` | Modify | `get_current_user()` verifica cuenta activa contra la base |
| `src/main.py` | Modify | Guard en `/auth/login`; catch de `AccountDeactivatedError` en callback Google; 3 endpoints `/auth/users*` |
| `dashboard/lib/types.ts` | Modify | `UserListItem` TS espejo del modelo Python |
| `dashboard/lib/auth.ts` | Modify | `listUsers()`, `deactivateUser()`, `reactivateUser()` con `ApiStatusError` |
| `dashboard/components/admin/UsersPanel.tsx` | Create | Lista + confirmación + acciones (SWR, patrón `InvitationsPanel`) |
| `dashboard/app/(app)/admin/access/page.tsx` | Modify | Tercera pestaña `users` |
| `dashboard/app/login/page.tsx` | Modify | `account_deactivated` en el mapeo de errores + 403 del login password |
| `dashboard/messages/es.json`, `en.json` | Modify | Claves nuevas con paridad |
| `tests/unit/test_deps.py` | Modify | Fakes de `auth_service` necesitan `is_user_active` |
| `tests/unit/test_user_management.py` | Create | Guards y transiciones contra Postgres real |
| `tests/integration/test_users_api.py` | Create | Los 3 endpoints + bloqueos de login end-to-end |
| `dashboard/components/admin/UsersPanel.test.tsx` | Create | Confirmación, deshabilitados, errores |

## Interfaces / Contracts

```python
# src/services/auth_service.py — excepciones nuevas (mismo estilo que las existentes)
class AccountDeactivatedError(Exception): ...              # login password/Google
class UserNotFoundError(Exception): ...                    # 404
class CannotDeactivateSelfError(Exception): ...            # 409
class CannotManageHigherOrEqualRoleError(Exception): ...   # 403
class UserAlreadyDeactivatedError(Exception): ...          # 409
class UserNotDeactivatedError(Exception): ...              # 409 (reactivar una activa)

async def is_user_active(self, user_id: UUID) -> bool: ...
async def list_users(self) -> list[UserListItem]: ...
async def deactivate_user(self, actor: CurrentUser, target_id: UUID) -> None: ...
async def reactivate_user(self, actor: CurrentUser, target_id: UUID) -> None: ...
```

Matriz de status de los endpoints (contrato para tests y frontend):

| Situación | `GET /auth/users` | `deactivate` | `reactivate` |
|---|---|---|---|
| sin sesión | 401 | 401 | 401 |
| viewer/moderador | 403 | 403 | 403 |
| ok | 200 `[UserListItem]` | 204 | 204 |
| target inexistente | — | 404 | 404 |
| target rol >= actor | — | 403 | 403 |
| target == actor | — | 409 | 409 |
| ya en ese estado | — | 409 | 409 |

```ts
// dashboard/lib/types.ts
export interface UserListItem {
  id: string;
  email: string;
  role: UserRole;
  name: string | null;
  avatar_url: string | null;
  has_google: boolean;
  has_password: boolean;
  created_at: string;
  deactivated_at: string | null;
}
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit (Postgres real) | Transiciones de estado y los 4 guards de `deactivate_user`/`reactivate_user`; idempotencia rechazada con 409; `is_user_active` para fila inexistente | `tests/unit/test_user_management.py` con los fixtures `db_pool`/`_migrated` de `tests/conftest.py` (testcontainers; los mocks de asyncpg son ciegos al SQL — lección documentada del proyecto) |
| Unit | `get_current_user` responde 401 cuando la cuenta está desactivada o no existe | `tests/unit/test_deps.py`, extendiendo los fakes existentes con `is_user_active` |
| Integration | Los 3 endpoints con la matriz completa de status; login password 403 vs 401 no-enumerante; 2FA no emite pre-auth; sesión viva muere en el request siguiente; `/report` trata al desactivado como anónimo | `tests/integration/test_users_api.py`, patrón de `test_auth_api.py` |
| Integration | Callback Google: redirect con `account_deactivated`, sin Set-Cookie, sin UPDATE (auto-link NO ocurre) | Mismo patrón de mocking del callback que usa la suite actual de Google OAuth |
| Frontend | Confirmación antes de desactivar; cancelar no llama a la API; botones deshabilitados por jerarquía y por self; errores traducidos | Vitest + Testing Library, patrón de los tests de `InvitationsPanel` |
| Frontend | Paridad ES/EN con las claves nuevas | `messages/parity.test.ts` (ya existente, corre solo) |

Postgres local del proyecto: **puerto 5433** (en 5432 hay un Postgres nativo de macOS que
NO es el del stack). Los tests con testcontainers levantan su propio container y no
dependen de eso, pero cualquier verificación manual contra la base sí.

## Migration / Rollout

1. **Migración 012**: se aplica sola al arranque de la API (`scripts/apply_migrations.py`).
   Idempotente y sin backfill: todas las filas existentes quedan con `NULL` = activas, que
   es exactamente el comportamiento actual. Cero downtime, cero riesgo de lockout.
2. **Orden de deploy**: backend primero (la columna y los endpoints existen antes de que
   la UI los llame), dashboard después. Si el dashboard llegara primero, la pestaña
   mostraría un error de carga — feo pero no destructivo.
3. **Sin feature flag**: la superficie nueva está gateada por rol; para un no-admin el
   change es invisible salvo el chequeo por request en `get_current_user()`, que es
   transparente mientras nadie esté desactivado.
4. **Verificación en producción** (Fase 3): desactivar una cuenta de prueba, comprobar
   los tres bloqueos (password, Google, sesión viva con la pestaña abierta) y reactivarla.

## Open Questions

- [ ] ¿Se agrega el redirect `/admin/users` → `/admin/access?tab=users`? (tarea opcional
      2.6; el patrón existe para `/beta` y `/admin/invitations`). Decisión del usuario.
- [ ] Ninguna que bloquee la implementación.
