# Design: Menú de configuración de cuenta (perfil, 2FA TOTP, exportar datos, borrar cuenta)

## Technical Approach

Se extiende `AuthService` (SQL parametrizado vía `asyncpg`, sin ORM, patrón ya establecido por `multi-user-auth`/`google-oauth`) con métodos nuevos para perfil extendido, 2FA TOTP, exportación y borrado de cuenta. Una única migración nueva (`005_account_settings.sql`) agrega las columnas/tabla necesarias, todas nullable o con default seguro — mismo estilo que 001-004.

El punto de mayor riesgo de diseño es el login de dos pasos cuando `totp_enabled=true`: hoy `POST /auth/login` verifica password y emite la cookie `session` completa en el mismo request. Con 2FA, se necesita un estado intermedio ("password correcto, segundo factor pendiente") sin infraestructura nueva. La solución (Decision 1 abajo) reutiliza el mismo mecanismo JWT stateless ya usado por el resto del sistema, con un claim distintivo que `get_current_user()` rechaza explícitamente — cero infraestructura nueva, cero cambio de topología (no se toca Redis, no se agrega tabla de sesiones).

El resto de las sub-features (perfil, export, delete) son CRUD directo sobre `AuthService`/Postgres, sin necesidad de estado intermedio: se protegen con el `Depends(get_current_user)` ya existente, sin tocar `src/api/deps.py`.

Referencia de specs: `openspec/changes/account-settings/specs/account-settings/spec.md` (ya escrito en paralelo) — todos los Requirements ahí definidos se cubren en este documento.

## Architecture Decisions

### Decision 1: Mecanismo de sesión intermedia para el login de 2 pasos con 2FA

**Choice**: JWT de "pre-auth" de vida muy corta (2 minutos), emitido por `POST /auth/login` cuando el usuario tiene `totp_enabled=true` y el password es correcto. Se firma con el mismo `AUTH_SECRET_KEY` y el mismo algoritmo HS256 vía `AuthService.create_access_token()`/`decode_access_token()` (extendidos, no duplicados), pero con un claim adicional `"pending_2fa": true` y un claim `"typ": "pre_auth"` (redundante a propósito — ver Rationale). Viaja en una cookie separada, `pending_2fa_session` (httpOnly, secure, samesite=lax, `max_age=120`), NUNCA en la cookie `session` que ya usa el JWT completo — esto evita que un cliente que ignore el estado "pendiente" pueda usar ese token como si fuera una sesión completa simplemente por estar en la cookie de siempre.

`get_current_user()` (en `src/api/deps.py`) se modifica para rechazar explícitamente cualquier JWT decodificado que tenga `pending_2fa=true` con 401 — un token de pre-auth JAMÁS debe ser aceptado como sesión completa por ningún endpoint protegido existente o futuro, incluso si terminara (por bug o por manipulación del cliente) en la cookie `session`.

`POST /auth/2fa/verify` (login step, distinto del endpoint de verificación del setup con el mismo path pero diferenciado por contexto — ver Interfaces/Contracts) es el único endpoint que acepta la cookie `pending_2fa_session`: decodifica el pre-auth JWT, valida el código TOTP (o backup code) contra el `totp_secret`/backup codes del usuario referenciado en el claim `sub` del pre-auth token, y si es válido, emite la cookie `session` completa (mismo `create_access_token()` de siempre) y borra la cookie `pending_2fa_session`.

**Alternatives considered**:
- **(b) Token opaco server-side con TTL corto, reutilizando `RedisPubSubBus`**: descartado. `RedisPubSubBus` (ver `src/services/event_bus.py`) es un bus pub/sub fan-out para el pipeline de espectrogramas en vivo — su contrato es `publish`/`subscribe`/`close`, no `set`/`get`/`expire` de un key-value store; forzarlo a hacer de session store mezclaría dos dominios sin relación (auth vs. streaming sísmico) y acoplaría el ciclo de vida de sesiones de login a un componente que en `lifespan()` es explícitamente **best-effort** (`try/except` con warning si Redis no está disponible — ver `src/main.py` líneas 125-133). Auth en este proyecto es **fail-fast total** (`AUTH_SECRET_KEY` ausente aborta el arranque); atar el login con 2FA a un Redis que puede no estar disponible degradaría una superficie de seguridad crítica a "best-effort", contradiciendo el criterio ya establecido explícitamente en `lifespan()`. Además introduciría una tabla/estructura de datos nueva en Redis sin patrón de invalidación ya existente en el proyecto (hoy Redis solo transporta eventos efímeros de pub/sub, nunca estado persistente).
- **(b') Token opaco en una tabla Postgres nueva (`pending_2fa_sessions`)**: descartado por sobre-ingeniería. Introduce una tabla nueva, una limpieza de filas expiradas (cron o `DELETE WHERE expires_at < now()` en cada request — no existe infraestructura de jobs en el proyecto, confirmado en proposal.md), y un round-trip a Postgres extra en el paso más sensible del login, todo para resolver un problema que un JWT de 2 minutos con un claim resuelve sin estado server-side.
- **(c) Reenviar password + TOTP juntos en un único request a `POST /auth/login`**: descartado como única vía. Rompe la Decisión Cerrada del proposal (login de dos pasos observable, ver spec.md Requirement "Login con 2FA habilitado requiere segundo factor" y su escenario "Login con password correcto pero sin segundo factor no otorga sesión completa") y no resuelve el caso de UI real: el frontend no sabe de antemano si el usuario tiene 2FA habilitado antes de mostrarle el segundo input, por lo que el paso intermedio es necesario de cualquier forma para que la UI pueda pedir el código recién después de saber que hace falta.

**Rationale**: Preserva el ADN ya confirmado del proyecto (JWT stateless, sin infraestructura nueva, mismo algoritmo/secret/librería ya fail-fast garantizados) — el pre-auth token es funcionalmente "lo mismo pero con menos privilegios y vida más corta", no un mecanismo nuevo. El claim `pending_2fa` + el rechazo explícito en `get_current_user()` son la única pieza nueva de lógica, concentrada en un solo lugar (mismo criterio que ya aplica el proyecto al chequeo de "último superadmin" en `delete_account()`: un único punto de control, no siembra de checks en cada endpoint). La cookie separada (`pending_2fa_session` vs `session`) es una defensa en profundidad barata: incluso si `get_current_user()` tuviera un bug futuro que olvidara chequear `pending_2fa`, el token nunca llegaría ahí porque el cliente nunca lo manda en la cookie `session`.

**Riesgo residual — MITIGADO post-verify (fix puntual, fuera del flujo de fases SDD)**: un JWT de pre-auth robado en los 2 minutos de vida permitía a un atacante intentar códigos TOTP/backup codes sin límite contra `POST /auth/2fa/login-verify` — mismo perfil de riesgo que un intento de fuerza bruta de password (tampoco limitado hoy en multi-user-auth, sigue fuera de scope). Se agregó `Login2FAAttemptLimiter` (`src/services/auth_service.py`) — rate-limiting por `sub` (user_id del pre-auth token) con backoff duro: tras `MAX_TOTP_LOGIN_ATTEMPTS` (5) códigos fallidos, el endpoint rechaza con 401 CUALQUIER intento posterior para ese pre-auth, incluso uno con código correcto, hasta que el usuario reinicie el login desde `POST /auth/login` (que emite un pre-auth nuevo y resetea el contador explícitamente).

**Mecanismo elegido: Redis, no in-memory.** El proyecto ya depende de Redis como infraestructura real de producción (`RedisPubSubBus`/`event_bus`, `redis==5.0.4` en requirements.txt, tests de integración contra Redis real vía testcontainers) — un contador in-memory de proceso NO se comparte entre workers/réplicas (`uvicorn --workers N` o múltiples instancias detrás de un load balancer), permitiendo a un atacante multiplicar su presupuesto de intentos repartiendo requests entre procesos; Redis lo evita por diseño. Conexión dedicada (`totp_login_attempt_redis` en `src/main.py`, separada de `event_bus`), conectada **best-effort** en `lifespan()` (mismo criterio que `event_bus`, no fail-fast como `AUTH_SECRET_KEY`/Postgres): si Redis no está disponible, el endpoint degrada a "sin límite de intentos" en vez de romper el login. **Limitación conocida**: al ser best-effort, un despliegue sin Redis disponible pierde esta mitigación silenciosamente (solo logueado) — es una degradación de una mitigación ya aceptada, no de una garantía crítica.

### Decision 2: Esquema de la migración 005

**Choice**:
```sql
-- Perfil extendido: columnas nuevas directamente en `users`, no tabla separada.
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

-- 2FA TOTP
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;

-- Backup codes: tabla separada, no columna array.
CREATE TABLE IF NOT EXISTS user_backup_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_backup_codes_user_id ON user_backup_codes(user_id);
```

`full_name` se usa (no `name`) para no colisionar con la columna `name` ya existente (migración 004, poblada SOLO por Google OAuth — ver docstring de esa migración). Mezclar ambos conceptos bajo el mismo nombre confundiría "nombre que vino de Google" con "nombre editable manualmente por el usuario"; se mantienen deliberadamente separados, aunque para un usuario 100% password ambos puedan coexistir con valores distintos si el usuario edita `full_name` desde `/account/profile`. `GET /account/profile` expone `full_name` (no `name`); `name` sigue siendo exclusivo de `/auth/me` y del JWT, sin cambios.

**Alternatives considered**:
- **Backup codes como columna `TEXT[]` en `users`**: descartado. Marcar un código individual como "usado" requiere reemplazar el array completo (`UPDATE users SET backup_codes = array_remove(...)` o mantener un array paralelo de flags), lo cual es más frágil que un `UPDATE ... WHERE id = $1` de una fila puntual. Además, una tabla separada permite `used_at IS NULL` como filtro directo ("códigos disponibles") sin parsear un array, y dota de auditoría barata (cuándo se generó, cuándo se usó cada código) sin costo adicional de diseño.
- **Perfil extendido en tabla separada `user_profiles`**: descartado. El proposal (Decisión #4) exige que el perfil esté fuera del JWT/`UserPublic`/`/auth/me` — eso se resuelve a nivel de código (qué modelo Pydantic expone qué endpoint), no requiere aislamiento físico en el esquema. Todas las columnas de `users` ya conviven hoy con distintos niveles de sensibilidad (`password_hash`, `google_id`, `totp_secret` después de este change) sin tabla separada por campo; introducir una tabla nueva solo para 3 columnas de perfil (`full_name`, `address`, `phone`) es complejidad sin beneficio de seguridad real — el control de acceso ya lo da el código (`GET /account/profile` vs `GET /auth/me`), no el esquema.

**Rationale**: Todas las columnas nuevas en `users` son nullable o con default seguro (`totp_enabled DEFAULT false`), consistente con 001-004. La tabla separada para backup codes sigue el mismo criterio que ya usa el proyecto para relaciones 1-a-N reales (un usuario tiene 0..N backup codes, cardinalidad variable) — corresponde a una tabla, no a una columna array, siguiendo normalización estándar y facilitando el `consume_backup_code()` atómico (Decision 3).

### Decision 3: Contrato de AuthService — TOTP y backup codes

**Choice**:

```python
class TotpAlreadyEnabledError(Exception):
    """El usuario ya tiene 2FA habilitado; debe deshabilitarlo antes de un re-setup."""

class TotpNotAvailableForGoogleOnlyUserError(Exception):
    """password_hash IS NULL — Decisión Cerrada #1 del proposal, rechazo explícito."""

class InvalidTotpCodeError(Exception):
    """Código TOTP (o backup code) inválido/expirado durante verify o login."""

class TotpNotEnabledError(Exception):
    """Se intentó verify/disable/consume sobre un usuario sin 2FA habilitado."""


async def enable_totp(self, user_id: UUID) -> tuple[str, list[str]]:
    """Genera un totp_secret nuevo (pyotp.random_base32()) + 10 backup codes
    nuevos, dentro de una transacción:
      1. SELECT password_hash, totp_enabled FROM users WHERE id = $1 FOR UPDATE
         -> si password_hash IS NULL: raise TotpNotAvailableForGoogleOnlyUserError
         -> si totp_enabled: raise TotpAlreadyEnabledError (debe disable primero)
      2. UPDATE users SET totp_secret = $1 WHERE id = $2
         (totp_enabled se mantiene false hasta verify_totp() — ver spec.md
         Scenario "totp_enabled permanece false hasta que el código generado
         sea verificado")
      3. DELETE FROM user_backup_codes WHERE user_id = $1
         (invalida cualquier backup code de un setup anterior no completado)
      4. Genera 10 códigos con secrets.token_hex(4) (8 hex chars, formateados
         como "XXXX-XXXX" para legibilidad) y los inserta hasheados con
         _pwd_context.hash(code) en user_backup_codes.
    Retorna (otpauth_uri, backup_codes_en_claro) — el secreto en claro NUNCA
    se retorna directamente, solo embebido en el otpauth:// URI (vía
    pyotp.totp.TOTP(secret).provisioning_uri(...)); los backup codes en
    claro se retornan UNA vez (el caller/endpoint los expone en el response
    body y nunca más).
    """

async def verify_totp_setup(self, user_id: UUID, code: str) -> None:
    """Verifica el code contra el totp_secret ya guardado (pyotp.TOTP(secret).verify(code)):
      - válido -> UPDATE users SET totp_enabled = true WHERE id = $1
      - inválido -> raise InvalidTotpCodeError (totp_enabled permanece false)
    No requiere transacción explícita: un solo UPDATE condicional a la validación en Python.
    """

async def disable_totp(self, user_id: UUID) -> None:
    """Requiere sesión COMPLETA (no pre-auth) — el endpoint garantiza esto vía
    Depends(get_current_user), que ya rechaza tokens pending_2fa=true.
    UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = $1;
    DELETE FROM user_backup_codes WHERE user_id = $1 -- misma transacción.
    Idempotente: si totp_enabled ya era false, no falla (no-op observable).
    """

async def verify_totp_or_backup_code(self, user_id: UUID, code: str) -> bool:
    """Usado en el LOGIN step (POST /auth/2fa/verify), no en el setup.
    1. Intenta pyotp.TOTP(totp_secret).verify(code, valid_window=1) -> True si matchea.
    2. Si no matchea como TOTP, intenta consume_backup_code(user_id, code).
    Retorna True/False; NUNCA distingue en el mensaje de error cuál de los
    dos métodos falló (spec.md: 'sin distinguir explícitamente... mismo
    criterio de no filtrar información que ya aplica a errores de login').
    """

async def consume_backup_code(self, user_id: UUID, code: str) -> bool:
    """Dentro de una transacción (evita doble-uso concurrente del mismo code):
      1. SELECT id, code_hash FROM user_backup_codes
         WHERE user_id = $1 AND used_at IS NULL FOR UPDATE
      2. Para cada fila, _pwd_context.verify(code, code_hash) hasta encontrar match
         (no se puede indexar por hash — bcrypt no es determinístico/comparable
         por igualdad directa; el volumen es 10 filas máx. por usuario, aceptable).
      3. Si matchea: UPDATE user_backup_codes SET used_at = now() WHERE id = $1
         -> return True
      4. Si no matchea ninguna: return False (no lanza excepción — el caller
         decide el 401 genérico)
    """
```

**Alternatives considered**: Un solo método monolítico `setup_and_verify_2fa()` que hiciera todo en una llamada — descartado porque el flujo real requiere dos requests HTTP separados (`POST /auth/2fa/setup` entrega el QR, el usuario escanea y recién después manda el código en `POST /auth/2fa/verify`); forzar dos pasos HTTP sobre un solo método de service obligaría a persistir estado intermedio en algún lado extra, contradiciendo la Decision 1 de no introducir estado nuevo — el estado intermedio real es `totp_secret` ya guardado con `totp_enabled=false`, que ya es persistente por naturaleza (una columna), no necesita mecanismo adicional.

**Rationale**: Cada método mapea 1:1 a un Requirement del spec, con excepciones específicas que el endpoint traduce a códigos HTTP explícitos (mismo patrón que `EmailAlreadyRegisteredError` → 409 en `/auth/register`). El `FOR UPDATE` en `enable_totp`/`consume_backup_code` previene condiciones de carrera (setup doble concurrente, doble uso del mismo backup code) con el mismo criterio transaccional que `_determine_bootstrap_role`.

### Decision 4: Contrato de `delete_account()`

**Choice**:

```python
class LastSuperadminError(Exception):
    """El usuario es el único superadmin del sistema; no puede auto-eliminarse."""

async def delete_account(self, user_id: UUID) -> None:
    """Mismo patrón transaccional que _determine_bootstrap_role, invertido:
    async with self._pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT role FROM users WHERE id = $1 FOR UPDATE", user_id
            )
            if row is None:
                return  # ya no existe -- no-op, idempotente (no es un error del caller)
            if row["role"] == UserRole.SUPERADMIN.value:
                superadmin_count = await conn.fetchval(
                    "SELECT COUNT(*) FROM users WHERE role = $1",
                    UserRole.SUPERADMIN.value,
                )
                if superadmin_count == 1:
                    raise LastSuperadminError()
            await conn.execute("DELETE FROM users WHERE id = $1", user_id)
            # ON DELETE CASCADE en user_backup_codes se encarga del cleanup
            # de backup codes -- no requiere DELETE explícito adicional.
    """
```

El `SELECT ... FOR UPDATE` bloquea la fila del usuario durante el chequeo, y el `COUNT(*) WHERE role='superadmin'` corre dentro de la MISMA transacción que el `DELETE` final — mismo criterio de atomicidad que `_determine_bootstrap_role` (el COUNT y el INSERT/DELETE deben ver el mismo snapshot transaccional para evitar el race condition inverso: dos superadmins borrándose "simultáneamente" cuando son los últimos dos, ambos viendo `COUNT=2` antes de que el otro complete, dejando el sistema en 0 superadmins).

**Alternatives considered**: Chequear `COUNT(*)` en una query separada ANTES de abrir la transacción de DELETE — descartado explícitamente: dos requests concurrentes de los dos últimos superadmins verían ambos `COUNT=2` (aprobado) antes de que cualquiera complete su DELETE, resultando en 0 superadmins. El `FOR UPDATE` + COUNT dentro de la misma transacción serializa el acceso (el segundo request espera el lock de fila del primero, y al completar ve el estado post-DELETE... aunque en rigor el lock es sobre la fila del propio usuario que se borra, no sobre la tabla completa — ver nota de Riesgo Residual abajo).

**Riesgo residual y mitigación**: `SELECT ... FOR UPDATE` sobre `users WHERE id = $1` bloquea esa fila puntual, no la tabla completa ni las filas de otros superadmins — dos superadmins distintos borrándose en paralelo no se bloquean mutuamente por este lock. Para cerrar el race condition genuinamente bajo concurrencia real, el `COUNT(*) FROM users WHERE role='superadmin'` debe usar una lectura que sea consistente con el DELETE subsiguiente dentro de la MISMA transacción — Postgres en el nivel de aislamiento por defecto (`READ COMMITTED`) permite que ambas transacciones lean `COUNT=2` antes de que cualquiera commitee. Mitigación: usar `SELECT COUNT(*) FROM users WHERE role = 'superadmin' FOR UPDATE` (bloqueando las filas de TODOS los superadmins, no solo la propia) en vez de un `COUNT` sin lock — esto sí serializa: el segundo request espera a que el primero commitee (o haga rollback) antes de poder contar, y entonces ve el estado post-DELETE real. Esta es la implementación correcta a llevar a `tasks.md`, documentada acá explícitamente porque el pseudo-código de arriba (COUNT sin FOR UPDATE) es insuficiente bajo concurrencia estricta — se marca como detalle de implementación crítico, no como Open Question sin resolver.

**Rationale**: Reutiliza el mismo criterio que ya usa `_determine_bootstrap_role` (transacción única, chequeo + escritura atómicos) para la garantía inversa: el sistema nunca debe quedar con 0 superadmins, igual que nunca debe arrancar con 0.

### Decision 5: Formato del JSON de exportación

**Choice**: `GET /account/export` devuelve:

```json
{
  "account": {
    "id": "uuid",
    "email": "user@example.com",
    "role": "viewer",
    "google_id": "1234567890",
    "name": "Ana Gómez",
    "avatar_url": "https://...",
    "created_at": "2026-01-01T00:00:00Z",
    "updated_at": "2026-01-15T00:00:00Z"
  },
  "profile": {
    "full_name": "Ana Gómez",
    "address": "Av. Siempre Viva 742",
    "phone": "+54 9 11 5555-5555"
  },
  "security": {
    "has_password": true,
    "totp_enabled": false,
    "linked_google_account": false
  },
  "exported_at": "2026-07-20T12:00:00Z"
}
```

Explícitamente NUNCA incluye: `password_hash`, `totp_secret`, ni `code_hash`/valores de `user_backup_codes` bajo ninguna forma (ni en claro ni hasheados) — cubre literalmente el requirement del spec. La sección `security` expone solo booleanos derivados (`has_password = password_hash IS NOT NULL`, no el hash), permitiendo que el usuario vea "tengo 2FA activo" sin exponer el secreto.

**Alternatives considered**: Incluir `totp_secret` cifrado o los backup codes hasheados "por completitud" — descartado categóricamente: el spec (`Requirement: Exportación de los propios datos de cuenta`) prohíbe explícitamente cualquier forma de estos campos en el export, y no hay caso de uso legítimo para que el propio usuario necesite ver su hash de backup codes (no son reversibles, no le sirven de nada verlos).

**Rationale**: `created_at`/`updated_at` requieren agregarse a la migración 005 si no existen ya en `users` — confirmar en tasks (no se detectaron en 001-004 leídos; si no existen, se agregan `TIMESTAMPTZ NOT NULL DEFAULT now()` en la misma migración 005, con un trigger o UPDATE manual del lado de aplicación para `updated_at` en cada escritura de perfil).

### Decision 6: Generación de backup codes

**Choice**: 10 códigos por setup, generados con `secrets.token_hex(4)` (8 caracteres hexadecimales = 32 bits de entropía por código), formateados como `"XXXX-XXXX"` (guión en el medio, mismo estilo que la mayoría de implementaciones de referencia de backup codes — ej. GitHub/Google) para legibilidad al transcribirlos manualmente. Se persisten hasheados con `_pwd_context.hash(code)` (bcrypt, mismo `CryptContext` ya usado para `password_hash`), nunca en claro ni cifrados con un secret propio — reutiliza Decisión Cerrada #5 del proposal sin introducir un tercer patrón de secret management.

**Alternatives considered**: `secrets.token_urlsafe()` (alfabeto base64) — descartado por legibilidad: backup codes se transcriben a mano en algunos casos (usuario los anota en papel); un alfabeto hex es menos ambiguo que base64 (evita confusión `l`/`1`, `O`/`0`/`o` presente en base64/base62). 6 códigos (en vez de 10) — descartado: 10 es el estándar de facto de la industria (Google/GitHub/GitLab usan 10), y el volumen extra es irrelevante para el diseño de tabla ya elegido (Decision 2).

**Rationale**: 32 bits de entropía por código es standard para backup codes de un solo uso (no son la defensa primaria, TOTP lo es) — comparable a lo que usan proveedores de referencia. bcrypt vía `_pwd_context` evita cualquier debate de key management nuevo.

### Decision 7: Dependencias nuevas

**Choice**: Agregar `pyotp` a `requirements.txt` (no está en el archivo actual, confirmado). **`qrcode` NO hace falta agregarlo como paquete de generación de imagen** si se opta por que el FRONTEND renderice el QR client-side a partir del `otpauth://` URI (ej. librería JS como `qrcode.react` o equivalente, ya que `dashboard/` es Next.js/React) — el backend solo necesita entregar el URI de texto (`pyotp.totp.TOTP(secret).provisioning_uri(name=email, issuer_name="GeoSpectrum")`), no una imagen PNG. Esto evita agregar `qrcode` Y confirma que `Pillow==10.4.0` (ya presente, dependencia transitiva de `matplotlib`/`obspy`) sea irrelevante para este punto — no se necesita generación de imagen server-side en absoluto si el frontend renderiza el QR.

**Alternatives considered**: Generar el PNG del QR server-side con `qrcode[pil]` (que sí usaría `Pillow`, ya presente) y devolver un data URI (`data:image/png;base64,...`) — viable y no se descarta del todo, pero se prefiere la opción client-side porque (a) evita una dependencia nueva en un `requirements.txt` ya extenso (ver Risk del proposal sobre esto mismo), y (b) es el patrón más común en SPAs modernas (el backend nunca debería tener que saber renderizar píxeles para un dato que es fundamentalmente texto).

**Rationale**: Menos dependencias nuevas es preferible dado el Risk ya identificado en el proposal ("`pyotp`/`qrcode` agregan superficie de dependencias nuevas"). Queda como decisión cerrada de este design, no bloqueante — se marca en Open Questions solo la confirmación de qué librería JS específica usar en el frontend (detalle de tasks, no de arquitectura).

## Data Flow

### Flujo: Setup de 2FA (feliz)

    Cliente                    POST /auth/2fa/setup           AuthService.enable_totp()        Postgres
      │                              │                                  │                            │
      │  (sesión completa)           │                                  │                            │
      ├─────────────────────────────>│                                  │                            │
      │                              │  password_hash IS NULL? ─────────┤                            │
      │                              │  (get_current_user ya resolvió   │                            │
      │                              │   el user_id de la cookie)       │                            │
      │                              ├─────────────────────────────────>│  SELECT ... FOR UPDATE     │
      │                              │                                  ├───────────────────────────>│
      │                              │                                  │<───────────────────────────┤
      │                              │                                  │  UPDATE totp_secret        │
      │                              │                                  │  DELETE + INSERT backup    │
      │                              │                                  ├───────────────────────────>│
      │  200 {otpauth_uri,           │<─────────────────────────────────┤                            │
      │   backup_codes[10]}          │                                  │                            │
      │<─────────────────────────────┤                                  │                            │
      │                              │                                  │                            │
      │  (usuario escanea QR         │                                  │                            │
      │   con authenticator app)     │                                  │                            │
      │                              │                                  │                            │
      │  POST /auth/2fa/verify       │                                  │                            │
      │  {code: "123456"}            │                                  │                            │
      ├─────────────────────────────>│──────> verify_totp_setup() ─────>│  UPDATE totp_enabled=true  │
      │  200                         │<─────────────────────────────────┤                            │
      │<─────────────────────────────┤                                  │                            │

### Flujo: Login con 2FA habilitado (secuencia completa, incluye rechazo del pre-auth token)

    Cliente              POST /auth/login          AuthService              get_current_user()      user_menu/otros endpoints
      │                        │                        │                        │                        │
      │  {email, password}    │                        │                        │                        │
      ├───────────────────────>│                        │                        │                        │
      │                        │  verify_password() ───>│                        │                        │
      │                        │<───────────────────────┤  password OK           │                        │
      │                        │  totp_enabled? ────────>│                        │                        │
      │                        │<───────────────────────┤  true                  │                        │
      │                        │                        │                        │                        │
      │                        │  create_pre_auth_token(user)                    │                        │
      │                        │  claims: {sub, pending_2fa:true, exp:+2min}     │                        │
      │  200 {requires_2fa:    │                        │                        │                        │
      │   true}                │                        │                        │                        │
      │  Set-Cookie:           │                        │                        │                        │
      │   pending_2fa_session  │                        │                        │                        │
      │<───────────────────────┤                        │                        │                        │
      │                        │                        │                        │                        │
      │  (frontend muestra     │                        │                        │                        │
      │   input de código)     │                        │                        │                        │
      │                        │                        │                        │                        │
      │  GET /auth/me  (intento con la cookie            │                        │                        │
      │   pending_2fa_session en vez del código) ────────┼───────────────────────>│                        │
      │                        │                        │  decode -> pending_2fa=true                     │
      │  401 not authenticated │                        │  -> RECHAZADO explícitamente ──────────────────>│
      │<──────────────────────────────────────────────────────────────────────────┤                        │
      │                        │                        │                        │                        │
      │  POST /auth/2fa/verify │                        │                        │                        │
      │  {code: "123456"}      │                        │                        │                        │
      │  (cookie pending_2fa_session, NO cookie session) │                        │                        │
      ├───────────────────────>│  decode pending_2fa_session -> user_id           │                        │
      │                        │  verify_totp_or_backup_code(user_id, code) ─────>│                        │
      │                        │<──────────────────────────────────────────────────┤  válido                │
      │                        │  create_access_token(user)  [JWT completo]       │                        │
      │  200 UserPublic        │                        │                        │                        │
      │  Set-Cookie: session   │                        │                        │                        │
      │  Delete-Cookie:        │                        │                        │                        │
      │   pending_2fa_session  │                        │                        │                        │
      │<───────────────────────┤                        │                        │                        │
      │                        │                        │                        │                        │
      │  GET /auth/me (cookie session, ya completa) ─────┼───────────────────────>│                        │
      │  200 CurrentUser       │                        │                        │  pending_2fa ausente/false ──> OK
      │<──────────────────────────────────────────────────────────────────────────┤                        │

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `deploy/sql/migrations/005_account_settings.sql` | Create | Columnas `full_name`, `address`, `phone`, `totp_secret`, `totp_enabled DEFAULT false` en `users`; tabla `user_backup_codes` con FK `ON DELETE CASCADE`; agregar `created_at`/`updated_at` a `users` si no existen (confirmar en tasks). |
| `src/models/user.py` | Modify | Nuevos modelos: `UserProfile` (todos `Optional`: `full_name`, `address`, `phone`), `UserProfileUpdate` (mismo shape, para `PATCH`), `TotpSetupResponse` (`otpauth_uri: str`, `backup_codes: list[str]`), `TotpVerifyRequest` (`code: str`), `AccountExport` (shape de Decision 5). |
| `src/services/auth_service.py` | Modify | Nuevos métodos: `get_profile()`, `update_profile()`, `enable_totp()`, `verify_totp_setup()`, `disable_totp()`, `verify_totp_or_backup_code()`, `consume_backup_code()`, `export_user_data()`, `delete_account()`; nuevas excepciones: `TotpAlreadyEnabledError`, `TotpNotAvailableForGoogleOnlyUserError`, `InvalidTotpCodeError`, `TotpNotEnabledError`, `LastSuperadminError`; extender `create_access_token()` para aceptar un flag `pending_2fa: bool = False` y emitir el claim correspondiente con expiración corta propia (2 min) cuando es `True`. |
| `src/api/deps.py` | Modify | `get_current_user()` rechaza con 401 explícito cualquier token decodificado con `payload.get("pending_2fa") is True` — chequeo agregado ANTES de construir el `CurrentUser` (evita que un token de pre-auth resuelva una identidad completa aunque llegue en la cookie `session`). |
| `src/main.py` | Modify | Nuevos endpoints: `GET /account/profile`, `PATCH /account/profile`, `GET /account/export`, `DELETE /account`, `POST /auth/2fa/setup`, `POST /auth/2fa/verify` (setup), `POST /auth/2fa/disable`. Modificar `POST /auth/login`: si `user.totp_enabled`, emitir cookie `pending_2fa_session` + `{"requires_2fa": true}` en vez de la cookie `session` completa. Nuevo endpoint `POST /auth/2fa/login-verify` (login step, distinto path del setup-verify para no mezclar contextos — ver Interfaces/Contracts) que consume `pending_2fa_session` + código y emite `session` completa. |
| `requirements.txt` | Modify | Agregar `pyotp==2.9.0` (última estable en PyPI al momento del proposal; confirmar versión exacta en tasks). NO se agrega `qrcode` (Decision 7 — QR renderizado client-side). |
| `dashboard/lib/types.ts` | Modify | `UserProfile`, `UserProfileUpdate`, `TotpSetupResponse`, `AccountExport`; extender el tipo de respuesta de `login()` para el caso `{requires_2fa: true}`. |
| `dashboard/lib/auth.ts` | Modify | `getProfile`, `updateProfile`, `setupTotp`, `verifyTotpSetup`, `disableTotp`, `exportData`, `deleteAccount`, `verifyTotpLogin` — todas con `credentials: 'include'`. `login()` debe manejar la respuesta `{requires_2fa: true}` sin tratarla como error. |
| `dashboard/hooks/use-auth.tsx` | Modify | Nuevo estado transitorio para el flujo de login con 2FA pendiente (ej. `pendingTwoFactor: boolean`); `deleteAccount()` limpia `user` local y redirige a login, igual que `logout()`. |
| `dashboard/app/settings/` (nueva ruta) | Create | Formulario de perfil, flujo de setup 2FA (QR renderizado client-side desde `otpauth_uri` + input de código + pantalla de backup codes), botón de exportar, zona de riesgo con confirmación destructiva. |
| `dashboard/app/login/page.tsx` | Modify | Manejar el paso intermedio: tras `login()` devolver `requires_2fa`, mostrar input de código TOTP/backup code y llamar `verifyTotpLogin()`. |

## Interfaces / Contracts

```python
# src/models/user.py (nuevo)

class UserProfile(BaseModel):
    full_name: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None

class UserProfileUpdate(BaseModel):
    full_name: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None

class TotpSetupResponse(BaseModel):
    otpauth_uri: str
    backup_codes: list[str]  # texto claro, UNA vez

class TotpVerifyRequest(BaseModel):
    code: str = Field(..., min_length=6, max_length=9)  # 6 dígitos TOTP u 8-9 chars backup code "XXXX-XXXX"

class AccountExport(BaseModel):
    account: dict
    profile: UserProfile
    security: dict
    exported_at: datetime
```

```python
# src/main.py (nuevos endpoints, shape de respuesta)

POST /auth/login
  # sin 2FA: idéntico a hoy (200 + Set-Cookie session + UserPublic)
  # con 2FA: 200 + Set-Cookie pending_2fa_session + {"requires_2fa": true}

POST /auth/2fa/login-verify
  # Request: {"code": "123456"}  -- requiere cookie pending_2fa_session
  # 200 + Set-Cookie session + Delete-Cookie pending_2fa_session + UserPublic
  # 401 si code inválido o cookie pending_2fa_session ausente/expirada

POST /auth/2fa/setup       # requiere sesión completa (Depends(get_current_user))
  # 200 TotpSetupResponse
  # 400/409 si password_hash IS NULL (TotpNotAvailableForGoogleOnlyUserError)

POST /auth/2fa/verify      # requiere sesión completa -- verifica el setup, NO el login
  # Request: {"code": "123456"}
  # 200 {} | 400/401 InvalidTotpCodeError

POST /auth/2fa/disable     # requiere sesión completa
  # 200 {}

GET /account/profile       # requiere sesión completa
  # 200 UserProfile

PATCH /account/profile     # requiere sesión completa
  # Request: UserProfileUpdate (parcial)
  # 200 UserProfile (actualizado)

GET /account/export        # requiere sesión completa
  # 200 AccountExport

DELETE /account             # requiere sesión completa
  # 200/204 | 409 LastSuperadminError
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|--------------|----------|
| Unit (`tests/unit/test_auth_service.py`, extendido) | `enable_totp`/`verify_totp_setup`/`disable_totp`/`consume_backup_code`/`verify_totp_or_backup_code`/`delete_account` | Mismo patrón mockeado ya usado para `resolve_or_create_google_user` (`MagicMock`/`AsyncMock` de `asyncpg.Pool`/`Connection`, sin Postgres real). Casos: rechazo Google-only, doble setup, código inválido, backup code de un solo uso, último superadmin bloqueado, superadmin no-único permitido. |
| Unit | `create_access_token`/`decode_access_token` con `pending_2fa=True` | Extender `test_create_and_decode_access_token_roundtrip` — verificar que el claim está presente y que `decode_access_token` lo expone (la lógica de RECHAZO vive en `deps.py`, se testea ahí). |
| Unit (`tests/unit/test_deps.py`, si existe, o extendido) | `get_current_user()` rechaza tokens con `pending_2fa=true` | Construir un JWT con ese claim manualmente (`jose.jwt.encode`) y verificar 401, mismo patrón que `test_decode_access_token_with_wrong_signature_raises_invalid_token_error`. |
| Integration (`tests/integration/test_auth_api.py`, extendido) | Contrato HTTP de los 7 endpoints nuevos + `POST /auth/login` con 2FA | Mismo patrón: `app.state.auth_service` reemplazado por `MagicMock`/`AsyncMock`, sin `TestClient` levantando lifespan real. Casos clave: login con 2FA devuelve `requires_2fa` sin cookie `session`; `GET /auth/me` con cookie `pending_2fa_session` en vez de `session` responde 401; `POST /auth/2fa/login-verify` con código válido emite `session`; export nunca incluye `password_hash`/`totp_secret`; delete bloqueado en último superadmin (409) y permitido si hay otro. |
| Manual | Escaneo real de QR con authenticator app (Google Authenticator/Authy), verificación de código real, uso de backup code real | Documentar en tasks.md como paso de verificación manual explícito (no automatizable sin un cliente TOTP real) — mismo criterio que el proposal ya marca en Success Criteria. |

## Migration / Rollout

Migración 005 aditiva, nullable/default-safe (mismo estilo 001-004) — no requiere downtime. Rollback vía `005_rollback.sql`: `DROP TABLE user_backup_codes; ALTER TABLE users DROP COLUMN totp_secret, DROP COLUMN totp_enabled, DROP COLUMN full_name, DROP COLUMN address, DROP COLUMN phone` (y `created_at`/`updated_at` si se agregaron en esta migración y no existían antes — confirmar en tasks).

Rollout por sub-feature sin rollback de esquema: cada bloque de endpoints nuevos (`/account/*`, `/auth/2fa/*`) puede desactivarse individualmente no registrando esas rutas en `src/main.py`, sin afectar `/auth/login`/`/auth/register`/`/auth/logout`/`/auth/me` existentes — el cambio a `POST /auth/login` (chequeo de `totp_enabled`) es el único punto no aislable completamente, pero es no-op para todo usuario con `totp_enabled=false` (el default), por lo que no hay regresión observable si el resto de 2FA se desactiva a nivel de endpoints.

## Open Questions

- [ ] Confirmar versión exacta de `pyotp` a fijar en `requirements.txt` (última estable en PyPI al momento de `tasks`/`apply`, siguiendo el mismo criterio que ya se aplicó a `Authlib==1.7.2`).
- [ ] Confirmar si `users.created_at`/`updated_at` ya existen en el esquema actual (no se detectaron en las migraciones 001-004 leídas) — si no existen, deben agregarse en la migración 005 para que `AccountExport`/Decision 5 tenga de dónde leerlos.
- [ ] Elegir la librería JS concreta para renderizar el QR client-side a partir de `otpauth_uri` (ej. `qrcode.react` u otra ya idiomática en el stack Next.js/shadcn del proyecto) — detalle de implementación de `dashboard/`, no bloquea el diseño backend.
- [x] Rate-limiting de `POST /auth/2fa/login-verify` (mitigar fuerza bruta sobre el pre-auth de 2 minutos) — RESUELTO en fix puntual post-verify: `Login2FAAttemptLimiter` (Redis, ver Decision 1 "Riesgo residual — MITIGADO" arriba). `/auth/login` (password) sigue sin rate-limiting — no formaba parte del riesgo residual de este change y queda fuera de scope.
