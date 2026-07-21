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

from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

import asyncpg
from jose import JWTError, jwt
from jose.exceptions import ExpiredSignatureError
from passlib.context import CryptContext

from src.models.user import CurrentUser, UserInDB, UserPublic, UserRole

JWT_ALGORITHM = "HS256"

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


class AuthService:
    """Acceso a datos y operaciones de autenticación (usuarios + JWT)."""

    def __init__(self, dsn: str, secret_key: str, token_expire_minutes: int) -> None:
        self._dsn = dsn
        self._secret_key = secret_key
        self._token_expire_minutes = token_expire_minutes
        self._pool: Optional[asyncpg.Pool] = None

    async def connect(self) -> None:
        if self._pool is not None:
            return  # idempotente
        self._pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=5)

    async def close(self) -> None:
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
                "SELECT id, email, password_hash, role, google_id, name, avatar_url "
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

    def create_access_token(self, user: UserInDB | UserPublic) -> str:
        now = datetime.now(timezone.utc)
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

    def decode_access_token(self, token: str) -> CurrentUser:
        try:
            payload = jwt.decode(token, self._secret_key, algorithms=[JWT_ALGORITHM])
        except ExpiredSignatureError as exc:
            raise TokenExpiredError() from exc
        except JWTError as exc:
            raise InvalidTokenError() from exc

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
