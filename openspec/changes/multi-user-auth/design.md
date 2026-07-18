# Design: Autenticación Multi-Usuario con Roles

## Technical Approach

Se implementa un sistema de auth propio (no proveedor externo) usando **JWT stateless firmado con HMAC (HS256)**, entregado al frontend como **cookie httpOnly**, con hashing de passwords vía **bcrypt** (`passlib[bcrypt]`) y persistencia de usuarios en **TimescaleDB/Postgres** usando **SQL parametrizado crudo con `asyncpg`** — el mismo patrón que ya usa `src/services/timescale_service.py`, sin introducir un ORM.

La protección de endpoints se hace con una `Depends()` de FastAPI (`get_current_user`) reutilizable, aplicada endpoint por endpoint — no un middleware global — para poder dejar explícitamente públicos `/health`, `/metrics` y (ver Decisión 5) los 5 endpoints de lectura de datos sísmicos que hoy consume `scripts/seismic-cli.py` y el propio dashboard sin sesión. Esto reduce el "blast radius" del change: **no se protege ningún endpoint existente en esta primera iteración** — se protege únicamente la superficie nueva de auth (`/auth/*`) y se deja el `Depends()` ya escrito y probado, listo para aplicarse a endpoints futuros (regiones, dashboards personalizados) que si necesitan `user_id`.

Esto se alinea directamente con el Success Criteria del proposal ("Al menos un endpoint backend queda protegido de punta a punta") sin romper el contrato actual de `/report`, `/events`, `/alerts`, `/events/search`, `/spectrograms/*` que hoy son consumidos por el CLI y por el dashboard sin `Authorization`.

## Architecture Decisions

### Decision 1: JWT stateless (cookie httpOnly) vs. sesión server-side

**Choice**: JWT firmado HS256, con claims mínimos (`sub`=user_id, `role`, `exp`, `iat`), transportado en cookie httpOnly (`Secure`, `SameSite=Lax`), no en localStorage.

**Alternatives considered**:
- Sesión server-side en Redis (`SETEX session:{id} ...`).
- Proveedor externo (Clerk/Auth0/Supabase Auth).

**Rationale**: Se inspeccionó `src/services/event_bus.py` — el único uso de Redis en el proyecto es `RedisPubSubBus`, exclusivamente pub/sub fan-out para columnas de espectrograma en vivo. No existe ningún patrón de key-value con TTL, ni infraestructura de sesión. Agregar sesiones server-side implicaría:
1. Nueva responsabilidad sobre el mismo Redis (acoplar auth al Redis del pipeline de espectrogramas, que además solo se conecta "best-effort" — ver `lifespan()` en `main.py`, que loguea warning y sigue si Redis no está disponible; una feature de auth NO puede depender de un componente que el propio proyecto trata como opcional/degradable).
2. O bien un Redis nuevo dedicado — infraestructura adicional no justificada para un MVP de 2 roles.

FastAPI en este proyecto es explícitamente stateless por diseño (sin sesiones en memoria de proceso, servicio horizontal-friendly vía Prometheus/health checks). JWT preserva esa propiedad: cualquier réplica del servicio valida el token sin coordinación. Se descarta proveedor externo (Clerk/Auth0) porque el proposal ya fija "sistema propio" a nivel de producto salvo justificación técnica fuerte, y acá no la hay: 2 roles, sin SSO, sin recuperación de password en este change — el costo de integrar un proveedor externo (nueva dependencia de red en cada request, vendor lock-in, billing) no se justifica frente a ~150 líneas de JWT+bcrypt.

**Por qué cookie httpOnly y no localStorage + header Bearer**: mitiga robo de token vía XSS (JS no puede leer una cookie httpOnly). El trade-off es CSRF, mitigado con `SameSite=Lax` (el navegador no envía la cookie en requests cross-site que no sean navegación top-level GET) combinado con que las mutaciones (login/logout) son las únicas rutas nuevas y no dependen de estado ambient de sesión para ejecutarse la primera vez. CORS ya tiene `allow_credentials=True` en `src/main.py:161` — imprescindible para que el navegador adjunte cookies en requests cross-origin dashboard(3000)→API(8000); y `cors_allowed_origins` son orígenes explícitos (nunca `*`), requisito de CORS spec para poder combinarse con `allow_credentials=True`. No se requiere ningún cambio a la política CORS existente, solo confirmarla (queda como parte de Testing Strategy).

### Decision 2: Qué pasa con `scripts/seismic-cli.py` y con los endpoints hoy públicos

**Choice**: Se confirmó por lectura completa de `src/main.py` que los **13 endpoints existentes son 100% GET / solo lectura** (`/health`, `/metrics`, `/report`, `/events`, `/alerts`, `/events/search`, `/ws/spectrogram/{channel}`, `/spectrograms/live-channels`, `/spectrograms/{channel}/history`, `/spectrograms/{city_id}`, `/events/{event_id}/detail`, `/events/{event_id}/rupture`, `/`) — no existe ni un solo endpoint de escritura hoy. `scripts/seismic-cli.py` solo consume `/health`, `/report`, `/events`, `/alerts` (confirmado leyendo el archivo completo: `httpx.Client(timeout=10.0)` sin headers, 4 métodos `get_*`, sin ningún POST/PUT/DELETE).

Dado esto: **ningún endpoint existente se protege en este change**. Se dejan todos públicos tal cual están hoy. `scripts/seismic-cli.py` sigue funcionando sin ningún cambio — no se rompe nada. Este change únicamente agrega superficie nueva (`/auth/register`, `/auth/login`, `/auth/logout`, `/auth/me`) protegida donde corresponde por naturaleza (ej. `/auth/me` requiere sesión válida para tener sentido).

**Alternatives considered**:
- (a) Emitir API key de servicio de larga vida para el CLI.
- (b) El CLI se autentica como un usuario más (login interactivo o credenciales en config).
- (c) Deprecar el CLI.
- (d) Proteger `/report`/`/events`/`/alerts` ahora y dar un período de gracia.

**Rationale**: Las tres iniciativas futuras que motivan este change (regiones por usuario, dashboards personalizables, control de acceso a funciones) necesitan `user_id` en tablas **nuevas** que no existen todavía — no necesitan que `/report`/`/events`/`/alerts` dejen de ser públicos. Proteger endpoints de solo-lectura de datos sísmicos públicos (USGS/EMSC/INPRES son fuentes públicas por naturaleza) no tiene un caso de negocio en este change, y hacerlo introduciría exactamente el breaking change que el Risk #1 del proposal pide evitar explícitamente resolver "sin implícitos". La opción elegida es la única que dejafuncionando el CLI sin ningún cambio de código, sin API keys que gestionar, y sin período de transición: se difiere la decisión de proteger endpoints de lectura a un change futuro **cuando exista una razón concreta** (ej. rate-limiting por usuario, cuotas). Se documenta explícitamente para que quede trazable: esto responde el Success Criteria del proposal que pide "documentada en `design.md` la decisión sobre qué pasa con `scripts/seismic-cli.py`".

### Decision 3: Modelo de datos de `users` — SQL crudo parametrizado con `asyncpg`, sin ORM

**Choice**: Tabla `users` en el mismo Postgres/TimescaleDB (`POSTGRES_DB: seismic`), acceso vía un nuevo `src/services/auth_service.py` que usa `asyncpg` con placeholders `$1, $2...` — igual patrón que `TimescaleColumnWriter` en `src/services/timescale_service.py` (pool `asyncpg.create_pool`, queries parametrizadas, nunca f-strings/concatenación).

**Alternatives considered**: SQLAlchemy (sync u ORM async), Tortoise ORM.

**Rationale**: `requirements.txt` no trae ningún ORM — solo `psycopg2-binary` y `asyncpg` como drivers crudos. El único servicio existente que toca la base (`TimescaleColumnWriter`) usa `asyncpg` puro con SQL parametrizado y pool propio, conectado/cerrado desde el `lifespan()` de `main.py`. Introducir SQLAlchemy solo para 1 tabla nueva de 6 columnas sería inconsistente con el proyecto (el Risk del proposal sobre SQL injection pide explícitamente seguir "el patrón de `TimescaleColumnWriter`") y agregaría una dependencia pesada (SQLAlchemy + Alembic para migraciones) sin beneficio proporcional al alcance (2 roles, ~4 endpoints de auth).

### Decision 4: Hashing de passwords — bcrypt vía `passlib[bcrypt]`

**Choice**: `passlib[bcrypt]==1.7.4` + `bcrypt==4.2.0` en `requirements.txt`.

**Alternatives considered**: Argon2 (`argon2-cffi`), hashlib+PBKDF2 manual.

**Rationale**: bcrypt es el estándar de facto para auth web con FastAPI (usado en el propio tutorial oficial de FastAPI Security), maduro, sin configuración de parámetros de memoria/paralelismo que Argon2 exige ajustar correctamente para no ser contraproducente. Argon2 es técnicamente superior contra ataques con GPU a gran escala, pero es un features que este proyecto (2 roles, uso interno/dashboard operativo, no un servicio de banca) no necesita — se prioriza consistencia con el ecosistema FastAPI y simplicidad de configuración sobre margen de seguridad marginal. `passlib` además da una API estable (`CryptContext`) que abstrae el esquema de hash, permitiendo migrar a Argon2 después sin tocar los call sites si se decide necesario.

Firma del JWT: `python-jose[cryptography]==3.3.0` (librería usada en el tutorial oficial de FastAPI Security, mantenida, soporta HS256 sin dependencias nativas pesadas).

### Decision 5: Rollout — sin período de transición, todo-o-nada en superficie nueva únicamente

**Choice**: No hay "endpoints protegidos desde el día uno" en el sentido de romper algo existente, porque **no se protege nada existente** (ver Decisión 2). La superficie nueva (`/auth/*`) nace protegida donde corresponde desde el primer commit — no hay período de transición porque no hay nada que transicionar.

**Rationale**: Esto es consecuencia directa de la Decisión 2, no una decisión independiente. Se declara explícitamente acá porque el proposal pide una respuesta clara sobre "período de transición" en el Success Criteria y en Dependencies.

## Data Flow

```
1. Registro (una vez, admin da de alta usuarios; sin self-signup público en este MVP)

   Cliente (dashboard) ──POST /auth/register {email, password, role}──→ FastAPI
                                                                            │
                                                          bcrypt.hash(password)
                                                                            │
                                                          INSERT INTO users (asyncpg, $1..$5)
                                                                            │
                                                                    201 {id, email, role}

2. Login

   Cliente ──POST /auth/login {email, password}──→ FastAPI
                                                        │
                                          SELECT * FROM users WHERE email=$1
                                                        │
                                          bcrypt.verify(password, hash)
                                                        │
                                          jwt.encode({sub, role, exp}, SECRET, HS256)
                                                        │
                                          Set-Cookie: session=<jwt>; HttpOnly; Secure; SameSite=Lax
                                                        │
                                                  200 {id, email, role}
                                                        │
   Cliente ←────────────────────────────────────────────┘
   (AuthProvider en dashboard/app/providers.tsx guarda { id, email, role } en estado)

3. Request a endpoint protegido (superficie NUEVA únicamente, ej. futuros endpoints de regiones)

   Cliente ──GET /auth/me (cookie enviada automáticamente por el browser)──→ FastAPI
                                                                                 │
                                                          Depends(get_current_user):
                                                            1. lee cookie "session"
                                                            2. jwt.decode(token, SECRET, HS256)
                                                            3. valida exp
                                                            4. retorna CurrentUser(id, email, role)
                                                                 │
                                                          si falla cualquier paso → 401
                                                                 │
                                                          200 {id, email, role}

4. Logout

   Cliente ──POST /auth/logout──→ FastAPI ──Set-Cookie: session=; Max-Age=0──→ 204
```

## File Changes

| File | Action | Description |
|------|--------|--------------|
| `src/models/user.py` | Create | Pydantic models: `UserRole` (enum `admin`/`viewer`), `UserCreate`, `UserPublic` (sin password hash), `UserInDB`, `CurrentUser` |
| `src/services/auth_service.py` | Create | `AuthService`: pool `asyncpg` propio (mismo patrón que `TimescaleColumnWriter`), `create_user()`, `get_user_by_email()`, `verify_password()` (bcrypt vía `passlib.CryptContext`), `create_access_token()`/`decode_access_token()` (jose) |
| `src/api/deps.py` | Create | `get_current_user(request: Request) -> CurrentUser` — Depends() que lee la cookie `session`, decodifica y valida el JWT, levanta `HTTPException(401)` si inválido/ausente/expirado. `require_role(role: UserRole)` — factory que envuelve `get_current_user` y levanta `403` si el rol no matchea (para uso futuro en endpoints admin-only) |
| `src/main.py` | Modify | Agrega router de auth (`POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`); registra `auth_service` en `lifespan()` (connect/close, mismo patrón que `column_writer`); **ningún endpoint existente cambia su firma ni gana `Depends()`** |
| `src/config/settings.py` | Modify | Nuevos campos: `auth_secret_key: Optional[str]`, `auth_token_expire_minutes: int = 1440` (24h), siguiendo el patrón `Optional[str]` ya usado para `timescaledb_password` |
| `requirements.txt` | Modify | Agrega `passlib[bcrypt]==1.7.4`, `bcrypt==4.2.0`, `python-jose[cryptography]==3.3.0` |
| `deploy/docker/docker-compose.yml` | Modify | Agrega `AUTH_SECRET_KEY` (comentado con placeholder, mismo estilo que `TIMESCALEDB_PASSWORD`) al servicio `geospectrum`; la tabla `users` vive en el `timescaledb` ya definido (perfil `storage`), sin nuevo servicio |
| `deploy/sql/` o `scripts/migrations/` (verificar convención existente en `sdd-tasks`) | Create | Script SQL de creación de tabla `users` (con `DROP TABLE` de rollback documentado, ver Migration/Rollout) |
| `dashboard/lib/auth.ts` | Create | Cliente de auth: `login()`, `logout()`, `getMe()` — usan `fetch` con `credentials: 'include'` (imprescindible para que el browser mande/reciba la cookie httpOnly cross-origin) |
| `dashboard/app/providers.tsx` | Modify | Agrega `AuthProvider` (context con `{ user, login, logout, loading }`), compuesto junto a `ThemeProvider`/`TooltipProvider` ya existentes |
| `dashboard/app/login/page.tsx` | Create | Página de login (form email/password) |
| `dashboard/middleware.ts` o guard en `dashboard/app/layout.tsx` | Create/Modify | Redirect a `/login` si no hay sesión en rutas protegidas del dashboard (a definir superficie exacta en `sdd-spec`, dado que hoy TODO el dashboard consume endpoints públicos) |
| `tests/unit/test_auth_service.py` | Create | Tests de hashing, creación/validación de JWT |
| `tests/integration/test_auth_api.py` | Create | Tests de `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/me` end-to-end contra un Postgres real (`testcontainers`, ya en `requirements.txt` con extra `[redis]` — se agrega uso de Postgres vía testcontainers si no está cubierto; confirmar en `sdd-tasks`) |

## Interfaces / Contracts

### Tabla `users` (TimescaleDB/Postgres)

```sql
CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
```

Rollback: `DROP TABLE IF EXISTS users;`

### JWT payload

```json
{
  "sub": "3f9a2b1c-...-uuid",
  "email": "user@example.com",
  "role": "viewer",
  "iat": 1752800000,
  "exp": 1752886400
}
```

Firmado HS256 con `settings.auth_secret_key`. TTL: `settings.auth_token_expire_minutes` (default 1440 = 24h).

### Endpoints nuevos

```
POST /auth/register
  Body:  { "email": str, "password": str, "role": "admin" | "viewer" }
  201:   { "id": uuid, "email": str, "role": str }
  409:   { "error": "email already registered" }

POST /auth/login
  Body:  { "email": str, "password": str }
  200:   { "id": uuid, "email": str, "role": str }
          Set-Cookie: session=<jwt>; HttpOnly; Secure; SameSite=Lax; Max-Age=86400
  401:   { "error": "invalid credentials" }

POST /auth/logout
  204, Set-Cookie: session=; Max-Age=0

GET /auth/me
  200:   { "id": uuid, "email": str, "role": str }
  401:   { "error": "not authenticated" }
```

### Pydantic models (`src/models/user.py`)

```python
from enum import Enum
from pydantic import BaseModel, EmailStr
from uuid import UUID
from datetime import datetime

class UserRole(str, Enum):
    ADMIN = "admin"
    VIEWER = "viewer"

class UserCreate(BaseModel):
    email: EmailStr
    password: str
    role: UserRole = UserRole.VIEWER

class UserPublic(BaseModel):
    id: UUID
    email: EmailStr
    role: UserRole

class CurrentUser(BaseModel):
    id: UUID
    email: EmailStr
    role: UserRole
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `AuthService.verify_password` / hashing round-trip, `create_access_token`/`decode_access_token` (incluyendo token expirado, firma inválida) | `pytest` puro, sin infra externa, siguiendo estilo de `tests/unit/` existente |
| Unit | `get_current_user` Depends: cookie ausente → 401, token corrupto → 401, token válido → `CurrentUser` correcto | `pytest` con `Request` mockeado o `TestClient` |
| Integration | `/auth/register` → `/auth/login` → `/auth/me` flujo completo contra Postgres real | `testcontainers` (ya en `requirements.txt`) levantando Postgres efímero; NO usar TimescaleDB image completa si Postgres plano alcanza para la tabla `users` (más rápido en CI) |
| Integration | `/auth/login` con password incorrecto → 401; registro con email duplicado → 409 | Mismo harness que arriba |
| Integration | Verificar que endpoints existentes (`/report`, `/events`, `/alerts`, `/events/search`) siguen respondiendo 200 SIN cookie de sesión — regresión explícita de la Decision 2 | Extender `tests/integration/test_api.py` con un test que confirma ausencia de `Depends()` de auth (request sin `Authorization`/cookie debe seguir funcionando) |
| Manual/E2E | CORS: request cross-origin dashboard(3000)→API(8000) con `credentials: 'include'` recibe y reenvía la cookie correctamente | Verificar manualmente con el dashboard corriendo contra la API en dev antes de dar por cerrado el change (`sdd-verify`) |
| E2E | Login en el dashboard → acceso a ruta protegida → logout → redirect a `/login` | Playwright o verificación manual, a definir en `sdd-tasks` según infra de E2E ya existente en el proyecto (verificar si hay Playwright configurado) |

## Migration / Rollout

1. **Migración de datos**: Se crea la tabla `users` con el script SQL de arriba (idempotente vía `CREATE TABLE IF NOT EXISTS`). Se ejecuta manualmente o vía el mecanismo de migraciones que `sdd-tasks` determine que ya existe en el proyecto (a verificar — no se detectó Alembic ni migraciones formales en `requirements.txt`; probablemente un script SQL ejecutado a mano contra el TimescaleDB del perfil `storage`, igual que `spectrogram_columns` que ya vive ahí sin migration tool visible).
2. **Rollout de código**: Sin flag de feature — el auth service y sus 4 endpoints nuevos se despliegan de una vez. No hay riesgo de romper tráfico existente porque (Decisión 2) **ningún endpoint existente cambia de contrato**. El deploy es aditivo puro.
3. **`scripts/seismic-cli.py`**: cero cambios requeridos, sigue funcionando exactamente igual (confirmado: solo toca `/health`, `/report`, `/events`, `/alerts`, todos siguen públicos).
4. **Rollback**: revertir el/los commits del change; si la tabla `users` ya fue creada en producción, ejecutar `DROP TABLE IF EXISTS users;`. Como ningún endpoint existente fue modificado, el rollback no reintroduce ningún estado "públicamente inseguro" que antes no existiera — el sistema simplemente pierde la capacidad de login, que es exactamente el estado pre-change.
5. **Fase siguiente (fuera de este change)**: cuando se implementen regiones/dashboards personalizables por usuario, esos endpoints nuevos SÍ usarán `Depends(get_current_user)` desde su primer commit — ahí es donde el sistema empieza a tener superficie realmente protegida más allá de `/auth/me`.

## Open Questions

Ninguna bloqueante para pasar a `sdd-spec`/`sdd-tasks`. Dos puntos de bajo riesgo que sdd-tasks debe verificar puntualmente (no son decisiones de arquitectura, son detalles de implementación):

- [ ] Confirmar si el proyecto ya tiene algún mecanismo de migraciones SQL (se buscó y no se encontró Alembic ni carpeta de migraciones formal; se asume script SQL manual como ya ocurre con `spectrogram_columns`) — si `sdd-tasks` encuentra uno, usarlo en vez de un script suelto.
- [ ] Confirmar si el dashboard ya tiene Playwright u otra infra de E2E configurada, para decidir si el test E2E de login/logout se automatiza en este change o queda como verificación manual en `sdd-verify`.
