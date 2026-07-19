"""Tests unitarios para AuthService: hashing y JWT (sin Postgres real)."""
from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from freezegun import freeze_time
from jose import jwt as jose_jwt

from src.models.user import CurrentUser, ROLE_LEVEL, UserPublic, UserRole, role_level
from src.services.auth_service import (
    AuthService,
    InvalidTokenError,
    TokenExpiredError,
)

SECRET = "test-secret-key-not-for-production"


def _service() -> AuthService:
    return AuthService(dsn="postgresql://unused", secret_key=SECRET, token_expire_minutes=1440)


def test_hash_password_roundtrip_correct_password_verifies():
    svc = _service()
    password_hash = svc.hash_password("Sismo2026!")
    assert svc.verify_password("Sismo2026!", password_hash) is True


def test_hash_password_roundtrip_incorrect_password_fails():
    svc = _service()
    password_hash = svc.hash_password("Sismo2026!")
    assert svc.verify_password("PasswordIncorrecto", password_hash) is False


def test_hash_password_never_stores_plaintext():
    svc = _service()
    password_hash = svc.hash_password("Sismo2026!")
    assert password_hash != "Sismo2026!"


def test_create_and_decode_access_token_roundtrip():
    svc = _service()
    user = UserPublic(
        id="3f9a2b1c-1111-2222-3333-444455556666",
        email="ana@example.com",
        role=UserRole.ADMIN,
    )
    token = svc.create_access_token(user)
    current = svc.decode_access_token(token)

    assert isinstance(current, CurrentUser)
    assert str(current.id) == str(user.id)
    assert current.email == user.email
    assert current.role == UserRole.ADMIN


def test_decode_access_token_with_wrong_signature_raises_invalid_token_error():
    svc = _service()
    user = UserPublic(
        id="3f9a2b1c-1111-2222-3333-444455556666",
        email="ana@example.com",
        role=UserRole.VIEWER,
    )
    # Token firmado con una clave distinta a la que usa el service al decodificar.
    forged = jose_jwt.encode(
        {"sub": str(user.id), "email": user.email, "role": user.role.value},
        "otra-clave-distinta",
        algorithm="HS256",
    )
    with pytest.raises(InvalidTokenError):
        svc.decode_access_token(forged)


def test_decode_access_token_garbage_string_raises_invalid_token_error():
    svc = _service()
    with pytest.raises(InvalidTokenError):
        svc.decode_access_token("esto-no-es-un-jwt")


def test_decode_access_token_expired_raises_token_expired_error_distinct_from_invalid():
    svc = _service()
    user = UserPublic(
        id="3f9a2b1c-1111-2222-3333-444455556666",
        email="ana@example.com",
        role=UserRole.VIEWER,
    )
    short_lived_svc = AuthService(
        dsn="postgresql://unused", secret_key=SECRET, token_expire_minutes=60
    )
    with freeze_time("2026-01-01 00:00:00"):
        # auth_token_expire_minutes=60 desde 2026-01-01 00:00 -> exp a la 01:00
        token = short_lived_svc.create_access_token(user)

    with freeze_time("2026-01-01 02:00:00"):  # 1h después de expirar
        with pytest.raises(TokenExpiredError):
            svc.decode_access_token(token)


def test_expired_token_error_is_not_invalid_token_error():
    """TokenExpiredError e InvalidTokenError deben ser distinguibles (no la misma clase)."""
    assert not issubclass(TokenExpiredError, InvalidTokenError)
    assert not issubclass(InvalidTokenError, TokenExpiredError)


# ---------------------------------------------------------------------------
# Jerarquía de roles (design.md Decision 6, Phase 3.5)
# ---------------------------------------------------------------------------


def test_role_level_orders_all_four_roles_strictly_descending():
    assert role_level(UserRole.SUPERADMIN) > role_level(UserRole.ADMIN)
    assert role_level(UserRole.ADMIN) > role_level(UserRole.MODERADOR)
    assert role_level(UserRole.MODERADOR) > role_level(UserRole.VIEWER)


def test_role_level_matches_documented_values():
    assert role_level(UserRole.SUPERADMIN) == 3
    assert role_level(UserRole.ADMIN) == 2
    assert role_level(UserRole.MODERADOR) == 1
    assert role_level(UserRole.VIEWER) == 0


def test_role_level_dict_covers_all_roles():
    assert set(ROLE_LEVEL.keys()) == set(UserRole)


def test_user_role_still_serializes_as_string_value():
    """UserRole se mantiene str,Enum (no IntEnum) — el contrato de API/JWT/DB
    sigue siendo el string, no el nivel numérico (design.md Decision 6)."""
    assert UserRole.SUPERADMIN.value == "superadmin"
    assert UserRole.ADMIN.value == "admin"
    assert UserRole.MODERADOR.value == "moderador"
    assert UserRole.VIEWER.value == "viewer"


# ---------------------------------------------------------------------------
# Bootstrap del primer superadmin (design.md Decision 6, Phase 3.5)
#
# AuthService.create_user() usa asyncpg real (pool.acquire()/conn.transaction())
# — se mockea aquí para no requerir Postgres, siguiendo el mismo objetivo que
# el resto de este archivo ("sin Postgres real"). El flujo end-to-end contra
# Postgres real queda para Phase 5 (testcontainers), fuera de este batch.
# ---------------------------------------------------------------------------


def _fake_pool_for_bootstrap(existing_count: int, inserted_row: dict) -> MagicMock:
    """Construye un fake de asyncpg.Pool cuyo conn.fetchval() devuelve
    `existing_count` (simulando el estado de la tabla `users` antes del
    INSERT) y cuyo conn.fetchrow() devuelve `inserted_row` (simulando el
    RETURNING del INSERT)."""
    conn = AsyncMock()
    conn.fetchval.return_value = existing_count
    conn.fetchrow.return_value = inserted_row

    # conn.transaction() se usa como `async with conn.transaction():` — debe
    # comportarse como un async context manager.
    transaction_cm = AsyncMock()
    transaction_cm.__aenter__.return_value = None
    transaction_cm.__aexit__.return_value = False
    conn.transaction = MagicMock(return_value=transaction_cm)

    # pool.acquire() se usa como `async with self._pool.acquire() as conn:`
    acquire_cm = AsyncMock()
    acquire_cm.__aenter__.return_value = conn
    acquire_cm.__aexit__.return_value = False

    pool = MagicMock()
    pool.acquire = MagicMock(return_value=acquire_cm)
    return pool


@pytest.mark.asyncio
async def test_create_user_forces_superadmin_when_users_table_is_empty():
    """[Requirement: Bootstrap del primer superadmin / Scenario: El primer
    registro del sistema se convierte en superadmin sin importar el payload]"""
    svc = _service()
    user_id = uuid4()
    svc._pool = _fake_pool_for_bootstrap(
        existing_count=0,
        inserted_row={"id": user_id, "email": "primer-admin@example.com", "role": "superadmin"},
    )

    # El payload pide explícitamente "viewer" — debe ser ignorado.
    result = await svc.create_user(
        email="primer-admin@example.com", password="Sismo2026!", role=UserRole.VIEWER
    )

    assert result.role == UserRole.SUPERADMIN


@pytest.mark.asyncio
async def test_create_user_forces_viewer_when_users_table_is_not_empty():
    """[Requirement: Bootstrap del primer superadmin / Scenario: Un registro
    posterior siempre crea viewer, incluso si pide un rol superior]"""
    svc = _service()
    user_id = uuid4()
    svc._pool = _fake_pool_for_bootstrap(
        existing_count=1,
        inserted_row={"id": user_id, "email": "otro@example.com", "role": "viewer"},
    )

    # El payload pide explícitamente "superadmin" — debe ser ignorado.
    result = await svc.create_user(
        email="otro@example.com", password="Sismo2026!", role=UserRole.SUPERADMIN
    )

    assert result.role == UserRole.VIEWER


@pytest.mark.asyncio
@pytest.mark.parametrize("requested_role", [UserRole.ADMIN, UserRole.MODERADOR, UserRole.SUPERADMIN])
async def test_create_user_ignores_any_requested_role_when_table_not_empty(requested_role):
    """Todos los roles pedidos (admin, moderador, superadmin) resultan en
    viewer cuando la tabla ya tiene usuarios — no solo superadmin."""
    svc = _service()
    user_id = uuid4()
    svc._pool = _fake_pool_for_bootstrap(
        existing_count=5,
        inserted_row={"id": user_id, "email": "cualquiera@example.com", "role": "viewer"},
    )

    result = await svc.create_user(
        email="cualquiera@example.com", password="Sismo2026!", role=requested_role
    )

    assert result.role == UserRole.VIEWER
