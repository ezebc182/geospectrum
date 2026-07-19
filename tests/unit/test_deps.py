"""Tests unitarios para src/api/deps.py: get_current_user y require_role.

Usa un FastAPI app mínimo montado solo en el test (sin tocar src/main.py,
que en este batch no gana ningún endpoint nuevo) y mockea AuthService para
no requerir Postgres real.
"""
import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from src.api.deps import SESSION_COOKIE_NAME, get_current_user, require_role
from src.models.user import CurrentUser, UserRole
from src.services.auth_service import InvalidTokenError, TokenExpiredError

ADMIN_USER = CurrentUser(
    id="3f9a2b1c-1111-2222-3333-444455556666",
    email="ana@example.com",
    role=UserRole.ADMIN,
)
VIEWER_USER = CurrentUser(
    id="3f9a2b1c-1111-2222-3333-444455556667",
    email="bruno@example.com",
    role=UserRole.VIEWER,
)


class _FakeAuthService:
    """Sustituye AuthService.decode_access_token con comportamiento fijo por token."""

    def __init__(self, tokens: dict) -> None:
        self._tokens = tokens

    def decode_access_token(self, token: str) -> CurrentUser:
        result = self._tokens.get(token)
        if result is None:
            raise InvalidTokenError()
        if result == "expired":
            raise TokenExpiredError()
        return result


def _build_app(auth_service: _FakeAuthService) -> FastAPI:
    app = FastAPI()
    app.state.auth_service = auth_service

    @app.get("/protected")
    async def protected(current_user: CurrentUser = Depends(get_current_user)):
        return {"id": str(current_user.id), "role": current_user.role.value}

    @app.get("/admin-only")
    async def admin_only(current_user: CurrentUser = Depends(require_role(UserRole.ADMIN))):
        return {"id": str(current_user.id), "role": current_user.role.value}

    return app


@pytest.fixture
def client_with_valid_admin_token():
    fake_service = _FakeAuthService({"valid-admin-token": ADMIN_USER})
    app = _build_app(fake_service)
    return TestClient(app)


@pytest.fixture
def client_with_valid_viewer_token():
    fake_service = _FakeAuthService({"valid-viewer-token": VIEWER_USER})
    app = _build_app(fake_service)
    return TestClient(app)


def test_get_current_user_without_cookie_returns_401():
    fake_service = _FakeAuthService({})
    app = _build_app(fake_service)
    client = TestClient(app)

    response = client.get("/protected")

    assert response.status_code == 401
    assert "not authenticated" in response.json()["detail"]


def test_get_current_user_with_valid_cookie_returns_current_user(client_with_valid_admin_token):
    client_with_valid_admin_token.cookies.set(SESSION_COOKIE_NAME, "valid-admin-token")

    response = client_with_valid_admin_token.get("/protected")

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == str(ADMIN_USER.id)
    assert body["role"] == "admin"


def test_get_current_user_with_corrupt_cookie_returns_401():
    fake_service = _FakeAuthService({})  # cualquier token no registrado -> InvalidTokenError
    app = _build_app(fake_service)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, "garbage-not-a-jwt")

    response = client.get("/protected")

    assert response.status_code == 401


def test_get_current_user_with_expired_token_returns_401():
    fake_service = _FakeAuthService({"expired-token": "expired"})
    app = _build_app(fake_service)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, "expired-token")

    response = client.get("/protected")

    assert response.status_code == 401


def test_require_role_allows_when_role_matches(client_with_valid_admin_token):
    client_with_valid_admin_token.cookies.set(SESSION_COOKIE_NAME, "valid-admin-token")

    response = client_with_valid_admin_token.get("/admin-only")

    assert response.status_code == 200


def test_require_role_rejects_with_403_when_role_does_not_match(client_with_valid_viewer_token):
    client_with_valid_viewer_token.cookies.set(SESSION_COOKIE_NAME, "valid-viewer-token")

    response = client_with_valid_viewer_token.get("/admin-only")

    assert response.status_code == 403
    assert "insufficient role" in response.json()["detail"]


def test_require_role_rejects_with_401_when_no_session():
    fake_service = _FakeAuthService({})
    app = _build_app(fake_service)
    client = TestClient(app)

    response = client.get("/admin-only")

    assert response.status_code == 401
