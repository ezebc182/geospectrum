"""Tests unitarios para AuthService: hashing y JWT (sin Postgres real)."""
from datetime import timedelta

import pytest
from freezegun import freeze_time
from jose import jwt as jose_jwt

from src.models.user import CurrentUser, UserPublic, UserRole
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
