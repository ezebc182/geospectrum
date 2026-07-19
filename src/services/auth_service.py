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

    def verify_password(self, password: str, password_hash: str) -> bool:
        return _pwd_context.verify(password, password_hash)

    # -------------------------------------------------------------------
    # Persistencia (SQL parametrizado, nunca f-strings — ver Risk de
    # proposal.md sobre SQL injection sin ORM)
    # -------------------------------------------------------------------

    async def create_user(self, email: str, password: str, role: UserRole) -> UserPublic:
        password_hash = self.hash_password(password)
        try:
            async with self._pool.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    INSERT INTO users (email, password_hash, role)
                    VALUES ($1, $2, $3)
                    RETURNING id, email, role
                    """,
                    email,
                    password_hash,
                    role.value,
                )
        except asyncpg.UniqueViolationError as exc:
            raise EmailAlreadyRegisteredError(email) from exc

        return UserPublic(id=row["id"], email=row["email"], role=UserRole(row["role"]))

    async def get_user_by_email(self, email: str) -> Optional[UserInDB]:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id, email, password_hash, role FROM users WHERE email = $1",
                email,
            )
        if row is None:
            return None
        return UserInDB(
            id=row["id"],
            email=row["email"],
            password_hash=row["password_hash"],
            role=UserRole(row["role"]),
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
            )
        except (KeyError, ValueError) as exc:
            raise InvalidTokenError() from exc
