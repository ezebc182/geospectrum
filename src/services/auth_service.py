"""
Servicio de autenticación multi-usuario con roles.

Persiste usuarios en TimescaleDB/Postgres vía asyncpg puro (SQL parametrizado,
sin ORM) — mismo patrón que TimescaleColumnWriter en timescale_service.py
(pool propio, connect()/close() idempotentes, conectado/cerrado desde el
lifespan() de main.py). Hashing de passwords vía bcrypt (passlib.CryptContext),
JWT firmado HS256 vía python-jose.

Ver openspec/changes/multi-user-auth/design.md para las decisiones de diseño.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

import asyncpg
import pyotp
from jose import JWTError, jwt
from jose.exceptions import ExpiredSignatureError
from passlib.context import CryptContext

from src.models.user import (
    AccountExport,
    CurrentUser,
    UserInDB,
    UserProfile,
    UserProfileUpdate,
    UserPublic,
    UserRole,
)

JWT_ALGORITHM = "HS256"

# Vida del JWT de "pre-auth" (login de 2 pasos con 2FA — design.md Decision 1).
# Deliberadamente corto y fijo (no configurable vía Settings): un token
# `pending_2fa` NUNCA debe vivir más que el tiempo estrictamente necesario
# para que el cliente muestre el input de código y lo envíe.
PENDING_2FA_TOKEN_EXPIRE_MINUTES = 2

# Cantidad de backup codes generados por cada enable_totp() (design.md
# Decision 6) — estándar de facto de la industria (Google/GitHub/GitLab).
BACKUP_CODES_COUNT = 10

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


class EmailAlreadyRegisteredError(Exception):
    """Se intentó crear un usuario con un email que ya existe en `users`."""


class InvalidTokenError(Exception):
    """El JWT recibido no es válido: firma incorrecta o payload corrupto."""


class TokenExpiredError(Exception):
    """El JWT recibido tiene firma válida pero su claim `exp` ya pasó.

    Se distingue de InvalidTokenError a propósito — ver
    [Requirement: Expiración de sesión / Scenario: Token expirado es
    rechazado]: la causa debe ser distinguible internamente (para tests)
    aunque el mensaje público en deps.py sea el mismo 401 genérico.
    """


# --- account-settings (migración 005) — excepciones nuevas -----------------
#
# Mismo patrón que EmailAlreadyRegisteredError: clases simples, sin lógica
# propia, traducidas a códigos HTTP explícitos por el endpoint (Phase 3).


class TotpAlreadyEnabledError(Exception):
    """El usuario ya tiene 2FA habilitado; debe deshabilitarlo antes de un re-setup."""


class TotpNotAvailableForGoogleOnlyUserError(Exception):
    """password_hash IS NULL — Decisión Cerrada #1 del proposal, rechazo explícito."""


class InvalidTotpCodeError(Exception):
    """Código TOTP (o backup code) inválido/expirado durante verify o login."""


class TotpNotEnabledError(Exception):
    """Se intentó verify/disable/consume sobre un usuario sin 2FA habilitado."""


class LastSuperadminError(Exception):
    """El usuario es el único superadmin del sistema; no puede auto-eliminarse."""


# --- account-settings (fix post-verify) — rate-limiting de login-verify ----


class TooManyTotpAttemptsError(Exception):
    """Se superó MAX_TOTP_LOGIN_ATTEMPTS de códigos fallidos para el mismo
    pre-auth (mismo `sub`) dentro de la ventana TTL — ver
    `Login2FAAttemptLimiter` abajo. El caller (endpoint) debe traducir esto a
    401 sin distinguirlo del resto de los rechazos de login-verify (mismo
    criterio de no filtrar información que ya aplica en el resto del flujo)."""


# Máximo de intentos fallidos de código TOTP/backup code tolerados por
# pre-auth (identificado por `sub`, el user_id del JWT `pending_2fa=true`)
# antes de bloquear el resto de los intentos para ESE login — el usuario
# debe reiniciar desde POST /auth/login (que emite un pre-auth nuevo y
# resetea el contador). 5 es el mismo orden de magnitud que otros
# proveedores (GitHub/Google bloquean o exigen backoff progresivo alrededor
# de 5-10 intentos de TOTP).
MAX_TOTP_LOGIN_ATTEMPTS = 5

# TTL del contador en Redis. Coincide con la ventana de vida del pre-auth
# token (PENDING_2FA_TOKEN_EXPIRE_MINUTES, 2 minutos) MÁS margen: aunque el
# JWT ya haya expirado y decode_token_payload() lo rechace primero, no hay
# necesidad de que el contador de intentos sobreviva más que eso — se limpia
# solo, sin requerir un job de limpieza aparte.
TOTP_LOGIN_ATTEMPT_TTL_SECONDS = PENDING_2FA_TOKEN_EXPIRE_MINUTES * 60 + 30


class Login2FAAttemptLimiter:
    """Rate-limiting de fuerza bruta sobre `POST /auth/2fa/login-verify`.

    DECISIÓN DE MECANISMO (ver design.md de account-settings, Decision 1 y
    Open Questions): Redis, no in-memory. El proyecto YA depende de Redis
    como infraestructura real de producción (`RedisPubSubBus`/`event_bus` en
    src/main.py, `redis==5.0.4` en requirements.txt, tests de integración
    contra un Redis real vía testcontainers) — introducir un contador
    in-memory habría sido estrictamente peor acá: este proceso puede correr
    con múltiples workers (uvicorn --workers N / múltiples réplicas detrás
    de un load balancer), y un contador en memoria de proceso NO se comparte
    entre workers, permitiendo a un atacante multiplicar su presupuesto de
    intentos por N con solo repartir requests entre workers. Redis synchroniza
    el contador entre cualquier cantidad de procesos/instancias sin ese hueco.

    Clave: `2fa_login_attempts:{sub}` — `sub` es el user_id del pre-auth
    token (no hay `jti` en el JWT emitido por create_access_token(),
    ver arriba). Esto es intencional y suficiente para el requisito pedido
    ("bloquear el resto de los intentos para ESE token/login"): un pre-auth
    token nuevo (emitido por un nuevo POST /auth/login) para el MISMO
    usuario resetea explícitamente el contador (ver reset() invocado desde
    el endpoint /auth/login) en vez de depender solo del TTL, así que dos
    logins secuenciales del mismo usuario no comparten presupuesto de
    intentos aunque compartan `sub`.
    """

    def __init__(self, redis_client) -> None:
        self._redis = redis_client

    @staticmethod
    def _key(user_id: UUID) -> str:
        return f"2fa_login_attempts:{user_id}"

    async def check_not_locked(self, user_id: UUID) -> None:
        """Lanza TooManyTotpAttemptsError si el contador ya alcanzó el máximo.

        Se llama ANTES de verificar el código — así ni siquiera un código
        CORRECTO es aceptado una vez superado el límite, forzando reiniciar
        el login desde POST /auth/login (Requirement pedido por el usuario)."""
        raw = await self._redis.get(self._key(user_id))
        attempts = int(raw) if raw is not None else 0
        if attempts >= MAX_TOTP_LOGIN_ATTEMPTS:
            raise TooManyTotpAttemptsError()

    async def register_failure(self, user_id: UUID) -> int:
        """Incrementa el contador de intentos fallidos y (re)fija su TTL.

        `NX` no aplica acá a propósito: EXPIRE se refresca en cada fallo con
        `INCR` + `EXPIRE` (no `SET NX`) porque queremos que la ventana de
        bloqueo se cuente desde el ÚLTIMO intento fallido, no desde el
        primero — mismo criterio conservador que un lockout de contraseña
        tradicional."""
        key = self._key(user_id)
        attempts = await self._redis.incr(key)
        await self._redis.expire(key, TOTP_LOGIN_ATTEMPT_TTL_SECONDS)
        return attempts

    async def reset(self, user_id: UUID) -> None:
        """Limpia el contador — invocado en: (a) login-verify exitoso, y
        (b) un nuevo POST /auth/login para el mismo usuario (nuevo pre-auth
        token = nuevo intento de login, presupuesto de intentos limpio)."""
        await self._redis.delete(self._key(user_id))


class AuthService:
    """Acceso a datos y operaciones de autenticación (usuarios + JWT)."""

    def __init__(
        self,
        dsn: str,
        secret_key: str,
        token_expire_minutes: int,
        pool: Optional[asyncpg.Pool] = None,
    ) -> None:
        """
        Args:
            dsn: DSN de Postgres/TimescaleDB
            secret_key: clave de firma de los JWT
            token_expire_minutes: vigencia del access token
            pool: pool YA creado y de ciclo de vida ajeno (areas-of-interest /
                AOI-1). Cuando se pasa, este servicio deja de ser dueño del
                pool: `connect()` y `close()` se vuelven no-ops y el que lo
                creó es responsable de cerrarlo. Cuando es None se conserva el
                comportamiento original — el servicio crea y cierra su propio
                pool — para no romper a los callers existentes ni a los tests
                que instancian AuthService directamente.
        """
        self._dsn = dsn
        self._secret_key = secret_key
        self._token_expire_minutes = token_expire_minutes
        self._pool: Optional[asyncpg.Pool] = pool
        # Distingue "pool propio" de "pool prestado". Sin esta bandera, un
        # close() cerraría un pool compartido que otros servicios siguen
        # usando: el bug clásico del recurso inyectado.
        self._owns_pool = pool is None

    async def connect(self) -> None:
        if self._pool is not None:
            return  # idempotente; también cubre el caso de pool inyectado
        self._pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=5)

    async def close(self) -> None:
        if not self._owns_pool:
            return  # el pool es prestado: lo cierra quien lo creó
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    # -------------------------------------------------------------------
    # Hashing
    # -------------------------------------------------------------------

    def hash_password(self, password: str) -> str:
        return _pwd_context.hash(password)

    def verify_password(self, password: str, password_hash: Optional[str]) -> bool:
        # Guard (ver openspec/changes/google-oauth/design.md, Interfaces /
        # Contracts -> AuthService.verify_password): un usuario que se
        # registró exclusivamente vía Google tiene password_hash=None (ver
        # migración 003). Pasarle None a passlib levanta una excepción no
        # controlada (TypeError) — se retorna False explícitamente antes.
        if password_hash is None:
            return False
        return _pwd_context.verify(password, password_hash)

    # -------------------------------------------------------------------
    # Persistencia (SQL parametrizado, nunca f-strings — ver Risk de
    # proposal.md sobre SQL injection sin ORM)
    # -------------------------------------------------------------------

    @staticmethod
    async def _determine_bootstrap_role(conn: asyncpg.Connection) -> UserRole:
        """Decide el rol de bootstrap según el estado de la tabla `users`.

        Extraído de `create_user()` (ver openspec/changes/google-oauth/design.md,
        Decision 3) para que `resolve_or_create_google_user()` reutilice la
        MISMA regla sin duplicar lógica en un branch paralelo:
          - tabla vacía (COUNT = 0)  -> role = superadmin
          - tabla no vacía (COUNT > 0) -> role = viewer

        El caller es responsable de invocar este método DENTRO de la misma
        `conn.transaction()` que hace el INSERT posterior — el COUNT y el
        INSERT deben ver el mismo snapshot transaccional para evitar el
        race condition de "doble bootstrap de superadmin" bajo concurrencia
        (ver docstring histórico de `create_user()`).
        """
        existing_count = await conn.fetchval("SELECT COUNT(*) FROM users")
        return UserRole.SUPERADMIN if existing_count == 0 else UserRole.VIEWER

    async def create_user(self, email: str, password: str, role: UserRole) -> UserPublic:
        """Crea un usuario respetando la regla de bootstrap (design.md Decision 6).

        El `role` recibido se IGNORA deliberadamente — nunca se persiste el
        rol pedido por el caller de POST /auth/register (endpoint público,
        sin control de quién puede pedir un rol superior). El rol real se
        decide server-side vía `_determine_bootstrap_role()` según el estado
        de la tabla en el momento del registro.

        El COUNT (dentro de `_determine_bootstrap_role`) y el INSERT corren
        dentro de la MISMA transacción (conn.transaction()) para que sean
        atómicos: si dos registros concurrentes llegaran a la vez con la
        tabla vacía, la transacción serializa el acceso y solo uno puede
        observar COUNT = 0 (el otro ve la fila recién commiteada y cae en la
        rama `viewer`) — evita el race condition de "dos superadmin de
        bootstrap" bajo concurrencia.
        """
        password_hash = self.hash_password(password)
        try:
            async with self._pool.acquire() as conn:
                async with conn.transaction():
                    actual_role = await self._determine_bootstrap_role(conn)

                    row = await conn.fetchrow(
                        """
                        INSERT INTO users (email, password_hash, role)
                        VALUES ($1, $2, $3)
                        RETURNING id, email, role
                        """,
                        email,
                        password_hash,
                        actual_role.value,
                    )
        except asyncpg.UniqueViolationError as exc:
            raise EmailAlreadyRegisteredError(email) from exc

        return UserPublic(id=row["id"], email=row["email"], role=UserRole(row["role"]))

    async def get_user_by_email(self, email: str) -> Optional[UserInDB]:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id, email, password_hash, role, google_id, name, "
                "avatar_url, totp_enabled "
                "FROM users WHERE email = $1",
                email,
            )
        if row is None:
            return None
        return UserInDB(
            id=row["id"],
            email=row["email"],
            password_hash=row["password_hash"],
            role=UserRole(row["role"]),
            google_id=row["google_id"],
            name=row["name"],
            avatar_url=row["avatar_url"],
            # totp_enabled (migración 005, account-settings, tarea 3.3):
            # POST /auth/login lo consulta para decidir si el login requiere
            # segundo factor (design.md Decision 1).
            totp_enabled=row["totp_enabled"],
        )

    async def get_user_by_id(self, user_id: UUID) -> Optional[UserInDB]:
        """[account-settings, tarea 3.4] Usado por POST /auth/2fa/login-verify
        para resolver el usuario a partir del `sub` del pre-auth token (que
        solo tiene el `user_id`, no email) y así poder emitir el JWT de
        sesión completa (`create_access_token()` requiere email/role/name/
        avatar_url, no solo el id). Mismo shape/columnas que
        get_user_by_email(), buscando por `id` en vez de `email`.
        """
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id, email, password_hash, role, google_id, name, "
                "avatar_url, totp_enabled "
                "FROM users WHERE id = $1",
                user_id,
            )
        if row is None:
            return None
        return UserInDB(
            id=row["id"],
            email=row["email"],
            password_hash=row["password_hash"],
            role=UserRole(row["role"]),
            google_id=row["google_id"],
            name=row["name"],
            avatar_url=row["avatar_url"],
            totp_enabled=row["totp_enabled"],
        )

    async def resolve_or_create_google_user(
        self,
        google_id: str,
        email: str,
        name: Optional[str] = None,
        avatar_url: Optional[str] = None,
    ) -> UserPublic:
        """Resuelve un usuario a partir de un login de Google, dentro de UNA
        transacción atómica (mismo patrón que create_user(), líneas 82-120):
          1. UPDATE (name/avatar_url) WHERE google_id -> si matchea una fila,
             YA está vinculado: refresca perfil y retorna.
          2. Si no existe por google_id, SELECT por email:
             a. Si existe una fila con password_hash IS NOT NULL y google_id
                IS NULL -> auto-link: UPDATE users SET google_id = $1
                WHERE email = $2, retornar esa fila (Risk #1 del proposal,
                RESUELTO: opción auto-link por email, ya con email_verified
                validado por el caller ANTES de invocar este método — ver
                endpoint /auth/google/callback).
             b. Si no existe ninguna fila con ese email -> crear usuario nuevo,
                reutilizando la MISMA regla de bootstrap que create_user():
                COUNT(*) FROM users dentro de la misma transacción decide
                superadmin (tabla vacía) o viewer (no vacía). password_hash
                se inserta NULL.
          Todo el bloque corre en un único conn.transaction() — el COUNT, el
          SELECT por google_id, el SELECT por email y el INSERT/UPDATE final
          ven el mismo snapshot transaccional, evitando el mismo race
          condition de "doble bootstrap de superadmin" que ya documenta
          create_user().

        Precondición: el caller (endpoint) YA validó email_verified=true del
        ID token de Google antes de invocar este método (design.md Decision 4).

        `name`/`avatar_url` (extensión migración 004): claims OpenID Connect
        `name`/`picture` del ID token de Google, extraídos por el caller
        (src/main.py google_callback()). Se persisten y REFRESCAN en las 3
        ramas — incluida la de "ya vinculado" (rama 1) — porque Google es la
        fuente de verdad de estos datos de perfil en CADA login, no solo en
        la vinculación inicial: si el usuario cambia su foto/nombre en
        Google, o si (caso real detectado en verificación manual) la fila ya
        existía con estos campos en NULL por haberse vinculado antes de que
        esta migración existiera, el próximo login por Google los sincroniza
        sin requerir intervención manual en la base.
        """
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    """
                    UPDATE users SET name = $1, avatar_url = $2
                    WHERE google_id = $3
                    RETURNING id, email, role
                    """,
                    name,
                    avatar_url,
                    google_id,
                )
                if row is not None:
                    return UserPublic(
                        id=row["id"],
                        email=row["email"],
                        role=UserRole(row["role"]),
                        google_id=google_id,
                        name=name,
                        avatar_url=avatar_url,
                    )

                existing = await conn.fetchrow(
                    "SELECT id, email, role, password_hash, google_id FROM users WHERE email = $1",
                    email,
                )
                if existing is not None and existing["password_hash"] is not None and existing["google_id"] is None:
                    row = await conn.fetchrow(
                        """
                        UPDATE users SET google_id = $1, name = $2, avatar_url = $3
                        WHERE email = $4
                        RETURNING id, email, role
                        """,
                        google_id,
                        name,
                        avatar_url,
                        email,
                    )
                    return UserPublic(
                        id=row["id"],
                        email=row["email"],
                        role=UserRole(row["role"]),
                        google_id=google_id,
                        name=name,
                        avatar_url=avatar_url,
                    )

                actual_role = await self._determine_bootstrap_role(conn)
                row = await conn.fetchrow(
                    """
                    INSERT INTO users (email, password_hash, role, google_id, name, avatar_url)
                    VALUES ($1, NULL, $2, $3, $4, $5)
                    RETURNING id, email, role
                    """,
                    email,
                    actual_role.value,
                    google_id,
                    name,
                    avatar_url,
                )
                return UserPublic(
                    id=row["id"],
                    email=row["email"],
                    role=UserRole(row["role"]),
                    google_id=google_id,
                    name=name,
                    avatar_url=avatar_url,
                )

    # -------------------------------------------------------------------
    # JWT
    # -------------------------------------------------------------------

    def create_access_token(
        self, user: UserInDB | UserPublic, pending_2fa: bool = False
    ) -> str:
        """Emite el JWT de sesión.

        `pending_2fa=False` (default): comportamiento IDÉNTICO al pre-existente
        — ningún claim nuevo, misma expiración estándar
        (`self._token_expire_minutes`). No debe alterar el shape del token
        para logins sin 2FA (design.md Decision 1).

        `pending_2fa=True`: emite un JWT de "pre-auth" (login de 2 pasos con
        2FA) con claims adicionales `{"pending_2fa": true, "typ": "pre_auth"}`
        y expiración corta propia (`PENDING_2FA_TOKEN_EXPIRE_MINUTES`, 2
        minutos) — NO la expiración estándar de la sesión completa. Este
        token viaja en la cookie separada `pending_2fa_session` (Phase 3),
        nunca en la cookie `session`; `get_current_user()` (deps.py, Phase 3)
        lo rechaza explícitamente con 401 si igualmente llegara ahí.
        """
        now = datetime.now(timezone.utc)
        if pending_2fa:
            expire = now + timedelta(minutes=PENDING_2FA_TOKEN_EXPIRE_MINUTES)
            claims = {
                "sub": str(user.id),
                "pending_2fa": True,
                "typ": "pre_auth",
                "iat": now,
                "exp": expire,
            }
            return jwt.encode(claims, self._secret_key, algorithm=JWT_ALGORITHM)

        expire = now + timedelta(minutes=self._token_expire_minutes)
        claims = {
            "sub": str(user.id),
            "email": user.email,
            "role": user.role.value,
            # name/avatar_url (migración 004): claims opcionales, ausentes
            # (None) en usuarios de password. Se incluyen en el JWT para que
            # get_current_user()/CurrentUser no dependan de un round-trip
            # extra a Postgres solo para pintar el avatar/nombre en el
            # dropdown del frontend.
            "name": user.name,
            "avatar_url": user.avatar_url,
            "iat": now,
            "exp": expire,
        }
        return jwt.encode(claims, self._secret_key, algorithm=JWT_ALGORITHM)

    def decode_token_payload(self, token: str) -> dict:
        """Decodifica un JWT (sesión completa O pre-auth) y devuelve el
        payload crudo, sin intentar construir un `CurrentUser`.

        Tarea 2.10 (design.md Decision 1): un token `pending_2fa=true` NO
        tiene `email`/`role` (ver `create_access_token(pending_2fa=True)`) —
        `CurrentUser` los exige no-opcionales, así que este método existe
        para que el caller (ej. `POST /auth/2fa/login-verify`, Phase 3) pueda
        leer `sub`/`pending_2fa`/`typ` de un pre-auth token sin forzar ese
        shape. El rechazo de un token `pending_2fa=true` como sesión completa
        vive en `get_current_user()` (src/api/deps.py, Phase 3), no acá.
        """
        try:
            return jwt.decode(token, self._secret_key, algorithms=[JWT_ALGORITHM])
        except ExpiredSignatureError as exc:
            raise TokenExpiredError() from exc
        except JWTError as exc:
            raise InvalidTokenError() from exc

    def decode_access_token(self, token: str) -> CurrentUser:
        """Decodifica un JWT de SESIÓN COMPLETA a `CurrentUser`.

        Sin cambios de contrato respecto al comportamiento pre-existente
        (design.md Decision 1 / tarea 2.10: "no debe alterar el shape del
        token para logins sin 2FA"). Para leer el payload de un token de
        pre-auth (`pending_2fa=true`, sin `email`/`role`) usar
        `decode_token_payload()` en su lugar — este método seguiría fallando
        con `InvalidTokenError` si se le pasa un pre-auth token, porque a
        ese token le faltan los claims `email`/`role` que `CurrentUser`
        exige; ese es el comportamiento correcto y deseado (un pre-auth
        token nunca debe resolver una identidad completa).
        """
        payload = self.decode_token_payload(token)

        try:
            return CurrentUser(
                id=UUID(payload["sub"]),
                email=payload["email"],
                role=UserRole(payload["role"]),
                # .get(...): tokens emitidos ANTES de esta extensión (o
                # firmados por otro path) no tienen estos claims — se tratan
                # como None, no como error de token inválido.
                name=payload.get("name"),
                avatar_url=payload.get("avatar_url"),
            )
        except (KeyError, ValueError) as exc:
            raise InvalidTokenError() from exc

    # -------------------------------------------------------------------
    # account-settings (migración 005) — Perfil extendido
    # -------------------------------------------------------------------

    async def get_profile(self, user_id: UUID) -> UserProfile:
        """[Requirement: Consulta del perfil extendido propio]

        Devuelve el perfil extendido (`full_name`/`address`/`phone`) del
        usuario. Si nunca completó ningún campo, los tres son `None` — no es
        un error, es el estado inicial esperado de todo usuario nuevo.

        `totp_enabled` (fix puntual post-Phase 4): se agrega al SELECT solo
        para poblar el booleano de `UserProfile.totp_enabled` — jamás se lee
        ni se expone `totp_secret` acá. Esto reemplaza el uso lateral que
        hacía el frontend de GET /account/export solo para leer ese flag.
        """
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT full_name, address, phone, totp_enabled FROM users WHERE id = $1",
                user_id,
            )
        if row is None:
            return UserProfile()
        return UserProfile(
            full_name=row["full_name"],
            address=row["address"],
            phone=row["phone"],
            totp_enabled=row["totp_enabled"],
        )

    async def update_profile(
        self, user_id: UUID, update: UserProfileUpdate
    ) -> UserProfile:
        """[Requirement: Edición del perfil extendido propio]

        UPDATE parcial: solo los campos presentes en `update`
        (`model_dump(exclude_unset=True)`) se escriben; el resto queda
        intacto. `updated_at` se refresca en cada escritura.

        Este método NO acepta ni puede tocar `role`, `email`, ni
        `password_hash` bajo ninguna circunstancia — la firma del método
        recibe `UserProfileUpdate` (no un dict arbitrario), y ese tipo no
        declara esos campos (ver src/models/user.py); no hay forma de que un
        caller cuele esos valores a través de este método, la garantía es de
        diseño de tipos, no de un chequeo en runtime.
        """
        fields = update.model_dump(exclude_unset=True)
        if not fields:
            # Body vacío / sin campos enviados: no-op observable, sin error
            # (Scenario: Perfil se puede dejar completamente vacío sin error).
            return await self.get_profile(user_id)

        set_clauses = []
        values: list = []
        for i, (column, value) in enumerate(fields.items(), start=1):
            set_clauses.append(f"{column} = ${i}")
            values.append(value)
        set_clauses.append("updated_at = now()")
        values.append(user_id)

        query = (
            f"UPDATE users SET {', '.join(set_clauses)} "
            f"WHERE id = ${len(values)} "
            "RETURNING full_name, address, phone, totp_enabled"
        )
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(query, *values)

        if row is None:
            return UserProfile()
        return UserProfile(
            full_name=row["full_name"],
            address=row["address"],
            phone=row["phone"],
            totp_enabled=row["totp_enabled"],
        )

    # -------------------------------------------------------------------
    # account-settings (migración 005) — 2FA TOTP + backup codes
    # -------------------------------------------------------------------

    async def enable_totp(self, user_id: UUID) -> tuple[str, list[str]]:
        """[Requirement: Activación de 2FA TOTP restringida a usuarios con
        password propio] — design.md Decision 3.

        Genera un `totp_secret` nuevo + `BACKUP_CODES_COUNT` backup codes
        nuevos, dentro de una única transacción:
          1. `SELECT password_hash, totp_enabled ... FOR UPDATE` — rechaza
             si `password_hash IS NULL` (Google-only) o si ya está habilitado.
          2. `UPDATE users SET totp_secret = ...` (`totp_enabled` permanece
             `false` hasta `verify_totp_setup()`).
          3. `DELETE FROM user_backup_codes` (invalida restos de un setup
             anterior no completado).
          4. Genera e inserta los backup codes nuevos, hasheados con
             `_pwd_context` (bcrypt) — nunca en claro en la base.

        Retorna `(otpauth_uri, backup_codes_en_claro)`. Los backup codes en
        claro se retornan UNA vez — el caller (endpoint, Phase 3) los expone
        en el response body y nunca más (Decisión Cerrada #2 del proposal).
        """
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT password_hash, totp_enabled, email FROM users "
                    "WHERE id = $1 FOR UPDATE",
                    user_id,
                )
                if row is None or row["password_hash"] is None:
                    raise TotpNotAvailableForGoogleOnlyUserError()
                if row["totp_enabled"]:
                    raise TotpAlreadyEnabledError()

                secret = pyotp.random_base32()
                await conn.execute(
                    "UPDATE users SET totp_secret = $1 WHERE id = $2", secret, user_id
                )
                await conn.execute(
                    "DELETE FROM user_backup_codes WHERE user_id = $1", user_id
                )

                backup_codes = [self._generate_backup_code() for _ in range(BACKUP_CODES_COUNT)]
                for code in backup_codes:
                    code_hash = _pwd_context.hash(code)
                    await conn.execute(
                        "INSERT INTO user_backup_codes (user_id, code_hash) "
                        "VALUES ($1, $2)",
                        user_id,
                        code_hash,
                    )

                otpauth_uri = pyotp.totp.TOTP(secret).provisioning_uri(
                    name=row["email"], issuer_name="GeoSpectrum"
                )
                return otpauth_uri, backup_codes

    @staticmethod
    def _generate_backup_code() -> str:
        """Un backup code: 8 hex chars (32 bits de entropía) formateados
        "XXXX-XXXX" (design.md Decision 6) — legible para transcripción
        manual, sin ambigüedad `l`/`1`/`O`/`0` propia de base64/base62."""
        raw = secrets.token_hex(4).upper()
        return f"{raw[:4]}-{raw[4:]}"

    async def verify_totp_setup(self, user_id: UUID, code: str) -> None:
        """[Requirement: Verificación del código TOTP en el setup]

        Verifica `code` contra el `totp_secret` ya guardado por
        `enable_totp()`. Válido -> marca `totp_enabled = true`. Inválido ->
        `InvalidTotpCodeError`, sin modificar `totp_enabled`.
        """
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT totp_secret FROM users WHERE id = $1", user_id
            )
        if row is None or row["totp_secret"] is None:
            raise InvalidTotpCodeError()

        if not pyotp.TOTP(row["totp_secret"]).verify(code):
            raise InvalidTotpCodeError()

        async with self._pool.acquire() as conn:
            await conn.execute(
                "UPDATE users SET totp_enabled = true WHERE id = $1", user_id
            )

    async def disable_totp(self, user_id: UUID) -> None:
        """[Requirement: Deshabilitación de 2FA]

        Requiere sesión COMPLETA — garantizado por el endpoint vía
        `Depends(get_current_user)`, que ya rechaza tokens `pending_2fa=true`
        (Phase 3), no por este método.

        Idempotente: si `totp_enabled` ya era `false`, no falla (no-op
        observable) — el `UPDATE`/`DELETE` corren igual mismo si no había
        nada que cambiar, sin necesidad de un chequeo previo.
        """
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "UPDATE users SET totp_secret = NULL, totp_enabled = false "
                    "WHERE id = $1",
                    user_id,
                )
                await conn.execute(
                    "DELETE FROM user_backup_codes WHERE user_id = $1", user_id
                )

    async def consume_backup_code(self, user_id: UUID, code: str) -> bool:
        """[Requirement: Uso de backup codes como alternativa al código TOTP]
        — design.md Decision 3.

        Dentro de una transacción (evita doble-uso concurrente del mismo
        code): busca entre los backup codes no usados del usuario (`FOR
        UPDATE`, volumen máx. `BACKUP_CODES_COUNT` filas) el que matchea por
        `_pwd_context.verify()` (bcrypt no es indexable/determinístico, no
        se puede buscar por igualdad de hash). Si matchea, lo marca usado
        (`used_at = now()`) y retorna `True`; si ninguno matchea, retorna
        `False` SIN lanzar excepción — el caller decide el 401 genérico, sin
        distinguir "código inválido" de "ya usado" (mismo criterio de no
        filtrar información que ya aplica a errores de login por password).
        """
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                rows = await conn.fetch(
                    "SELECT id, code_hash FROM user_backup_codes "
                    "WHERE user_id = $1 AND used_at IS NULL FOR UPDATE",
                    user_id,
                )
                for row in rows:
                    if _pwd_context.verify(code, row["code_hash"]):
                        await conn.execute(
                            "UPDATE user_backup_codes SET used_at = now() "
                            "WHERE id = $1",
                            row["id"],
                        )
                        return True
                return False

    async def verify_totp_or_backup_code(self, user_id: UUID, code: str) -> bool:
        """[Requirement: Uso de backup codes como alternativa al código TOTP]

        Usado en el paso de LOGIN (`POST /auth/2fa/login-verify`, Phase 3),
        no en el setup. Intenta primero como código TOTP vigente
        (`valid_window=1`, tolera desfasaje de reloj de ±1 step); si no
        matchea, intenta como backup code (`consume_backup_code`). Retorna
        `True`/`False` combinado, sin distinguir en ningún mensaje de error
        cuál de los dos métodos falló.
        """
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT totp_secret FROM users WHERE id = $1", user_id
            )
        if row is not None and row["totp_secret"] is not None:
            if pyotp.TOTP(row["totp_secret"]).verify(code, valid_window=1):
                return True

        return await self.consume_backup_code(user_id, code)

    # -------------------------------------------------------------------
    # account-settings (migración 005) — Exportación y borrado de cuenta
    # -------------------------------------------------------------------

    async def export_user_data(self, user_id: UUID) -> AccountExport:
        """[Requirement: Exportación de los propios datos de cuenta] —
        design.md Decision 5.

        El `SELECT` de este método NUNCA incluye `password_hash`,
        `totp_secret` ni `code_hash` — el shape de `AccountExport` los
        excluye por construcción (no se leen de la base para este método en
        absoluto, no es solo "se leen pero no se exponen").
        """
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT id, email, role, google_id, name, avatar_url,
                       created_at, updated_at, full_name, address, phone,
                       password_hash IS NOT NULL AS has_password,
                       totp_enabled, google_id IS NOT NULL AS linked_google_account
                FROM users WHERE id = $1
                """,
                user_id,
            )

        return AccountExport(
            account={
                "id": str(row["id"]),
                "email": row["email"],
                "role": row["role"],
                "google_id": row["google_id"],
                "name": row["name"],
                "avatar_url": row["avatar_url"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            },
            profile=UserProfile(
                full_name=row["full_name"],
                address=row["address"],
                phone=row["phone"],
                # totp_enabled (fix puntual, ver get_profile()/update_profile()
                # arriba, que ya propagan este mismo valor): antes quedaba en
                # el default False de UserProfile aunque el usuario tuviera
                # 2FA activo (inconsistencia con security["totp_enabled"] más
                # abajo, que sí usa row["totp_enabled"]). Mismo dato, mismo
                # row, se propaga a ambos lugares del export.
                totp_enabled=row["totp_enabled"],
            ),
            security={
                "has_password": row["has_password"],
                "totp_enabled": row["totp_enabled"],
                "linked_google_account": row["linked_google_account"],
            },
            exported_at=datetime.now(timezone.utc),
        )

    async def delete_account(self, user_id: UUID) -> None:
        """[Requirement: Eliminación de la propia cuenta] — design.md
        Decision 4, versión CORREGIDA respecto de AMBOS pseudo-códigos
        documentados ahí (el original sin `FOR UPDATE` en el COUNT, Y el
        "fix" propuesto en la sección "Riesgo residual y mitigación").

        Dos problemas encontrados y corregidos durante esta implementación
        (confirmados contra el Postgres real del proyecto, no solo por
        inspección):

        1. `SELECT COUNT(*) ... FOR UPDATE` es SQL inválido en Postgres:
           "FOR UPDATE is not allowed with aggregate functions". Se
           reemplaza por `SELECT id FROM users WHERE role='superadmin'
           FOR UPDATE` (sin agregado) y se cuenta con `len(rows)` en Python.

        2. El "fix" de design.md (lockear primero la fila propia con
           `SELECT role FROM users WHERE id=$1 FOR UPDATE`, y DESPUÉS
           lockear todas las filas de superadmin con una query separada)
           produce un DEADLOCK real bajo concurrencia: si dos superadmins
           distintos ejecutan `delete_account()` al mismo tiempo, cada
           transacción ya tiene el lock de SU PROPIA fila (paso 1) cuando
           ambas intentan lockear el conjunto completo de superadmins (paso
           2, que incluye la fila del otro) — cada una espera un lock que
           la otra ya tiene: deadlock clásico de lock ordering cruzado.
           Confirmado experimentalmente (psql con dos sesiones concurrentes)
           y por el test de la tarea 2.39
           (`test_delete_account_concurrent_last_two_superadmins_exactly_one_succeeds`),
           que con la implementación ingenua deja el sistema en 0
           superadmins (el bug que Decision 4 buscaba evitar).

        Fix: un ÚNICO `SELECT ... FOR UPDATE` que cubre exactamente las
        filas necesarias, con un orden determinístico (`ORDER BY id`) para
        que TODAS las transacciones concurrentes adquieran los locks en el
        mismo orden — condición estándar para evitar deadlock circular.
        Si el usuario es superadmin, ese único SELECT ya lockea su propia
        fila (está incluida en el resultado), no hace falta un lock previo
        separado.

        Dentro de una única transacción:
          1. `SELECT role FROM users WHERE id = $1` (sin lock) — si no
             existe (`row is None`), no-op idempotente.
          2. Si el rol NO es `superadmin`: `DELETE` directo, sin más chequeo.
          3. Si el rol ES `superadmin`: `SELECT id FROM users WHERE
             role='superadmin' ORDER BY id FOR UPDATE` — lockea TODAS las
             filas de superadmin en orden determinístico. Si `len(rows) ==
             1` (solo la propia), `LastSuperadminError` sin DELETE. Si no,
             `DELETE FROM users WHERE id = $1` — `ON DELETE CASCADE` en
             `user_backup_codes` limpia esas filas automáticamente.
        """
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT role FROM users WHERE id = $1", user_id
                )
                if row is None:
                    return  # ya no existe -- no-op, idempotente

                if row["role"] == UserRole.SUPERADMIN.value:
                    superadmin_rows = await conn.fetch(
                        "SELECT id FROM users WHERE role = $1 ORDER BY id FOR UPDATE",
                        UserRole.SUPERADMIN.value,
                    )
                    if len(superadmin_rows) == 1:
                        raise LastSuperadminError()

                await conn.execute("DELETE FROM users WHERE id = $1", user_id)
