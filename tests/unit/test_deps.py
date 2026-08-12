"""Tests unitarios para src/api/deps.py: get_current_user y require_role.

Usa un FastAPI app mínimo montado solo en el test (sin tocar src/main.py,
que en este batch no gana ningún endpoint nuevo) y mockea AuthService para
no requerir Postgres real.
"""

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from jose import jwt

from src.api.deps import SESSION_COOKIE_NAME, get_current_user, require_min_role, require_role
from src.models.user import CurrentUser, UserRole
from src.services.auth_service import (
    JWT_ALGORITHM,
    InvalidTokenError,
    TokenExpiredError,
)

SUPERADMIN_USER = CurrentUser(
    id="3f9a2b1c-1111-2222-3333-444455556665",
    email="root@example.com",
    role=UserRole.SUPERADMIN,
)
ADMIN_USER = CurrentUser(
    id="3f9a2b1c-1111-2222-3333-444455556666",
    email="ana@example.com",
    role=UserRole.ADMIN,
)
MODERADOR_USER = CurrentUser(
    id="3f9a2b1c-1111-2222-3333-444455556668",
    email="carla@example.com",
    role=UserRole.MODERADOR,
)
VIEWER_USER = CurrentUser(
    id="3f9a2b1c-1111-2222-3333-444455556667",
    email="bruno@example.com",
    role=UserRole.VIEWER,
)


class _FakeAuthService:
    """Sustituye AuthService.decode_access_token/decode_token_payload con
    comportamiento fijo por token.

    `decode_token_payload()` (tarea 3.1/3.2, account-settings): por default
    devuelve un payload "inocente" (`{}`, sin `pending_2fa`) para cualquier
    token registrado que resuelva a un `CurrentUser` válido — get_current_user()
    llama a este método ANTES de decode_access_token(), así que debe
    comportarse de forma consistente con los tokens ya registrados en
    `self._tokens` para no romper los tests de Phase 3.5 (roles) ya
    existentes. `payloads` permite overridear ese comportamiento por token
    para los tests nuevos de pending_2fa.
    """

    def __init__(self, tokens: dict, payloads: dict | None = None) -> None:
        self._tokens = tokens
        self._payloads = payloads or {}

    def decode_token_payload(self, token: str) -> dict:
        if token in self._payloads:
            return self._payloads[token]
        result = self._tokens.get(token)
        if result is None:
            raise InvalidTokenError()
        if result == "expired":
            raise TokenExpiredError()
        return {}

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

    @app.get("/moderador-or-above")
    async def moderador_or_above(
        current_user: CurrentUser = Depends(require_min_role(UserRole.MODERADOR)),
    ):
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


@pytest.fixture
def client_with_all_role_tokens():
    """Un solo cliente con un token válido por cada uno de los 4 roles,
    para testear require_min_role sin repetir el armado de la app."""
    fake_service = _FakeAuthService(
        {
            "valid-superadmin-token": SUPERADMIN_USER,
            "valid-admin-token": ADMIN_USER,
            "valid-moderador-token": MODERADOR_USER,
            "valid-viewer-token": VIEWER_USER,
        }
    )
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


def test_require_role_rejects_superior_role_because_it_requires_exact_equality(
    client_with_all_role_tokens,
):
    """require_role exige IGUALDAD exacta, no jerarquía: un superadmin
    intentando pasar require_role(ADMIN) también recibe 403 (design.md
    Decision 6 — este es el caso que motiva require_min_role aparte)."""
    client_with_all_role_tokens.cookies.set(SESSION_COOKIE_NAME, "valid-superadmin-token")

    response = client_with_all_role_tokens.get("/admin-only")

    assert response.status_code == 403


# ---------------------------------------------------------------------------
# require_min_role — comparación por NIVEL, no por igualdad (Phase 3.5)
# ---------------------------------------------------------------------------


def test_require_min_role_allows_when_role_matches_minimum_exactly(client_with_all_role_tokens):
    client_with_all_role_tokens.cookies.set(SESSION_COOKIE_NAME, "valid-moderador-token")

    response = client_with_all_role_tokens.get("/moderador-or-above")

    assert response.status_code == 200


@pytest.mark.parametrize(
    "token",
    ["valid-admin-token", "valid-superadmin-token"],
)
def test_require_min_role_allows_roles_above_minimum(client_with_all_role_tokens, token):
    client_with_all_role_tokens.cookies.set(SESSION_COOKIE_NAME, token)

    response = client_with_all_role_tokens.get("/moderador-or-above")

    assert response.status_code == 200


def test_require_min_role_rejects_with_403_when_role_is_below_minimum(client_with_all_role_tokens):
    client_with_all_role_tokens.cookies.set(SESSION_COOKIE_NAME, "valid-viewer-token")

    response = client_with_all_role_tokens.get("/moderador-or-above")

    assert response.status_code == 403
    assert "insufficient role" in response.json()["detail"]


def test_require_min_role_rejects_with_401_when_no_session():
    fake_service = _FakeAuthService({})
    app = _build_app(fake_service)
    client = TestClient(app)

    response = client.get("/moderador-or-above")

    assert response.status_code == 401


# ---------------------------------------------------------------------------
# account-settings (tarea 3.2) — get_current_user() rechaza tokens
# pending_2fa=true, incluso si llegan en la cookie `session`.
# ---------------------------------------------------------------------------


def test_get_current_user_rejects_pending_2fa_token_even_with_valid_signature():
    """[Tarea 3.2, design.md Decision 1] Un JWT válido en firma pero con
    `pending_2fa: true` (construido directamente vía jose.jwt.encode, no vía
    create_access_token — simula un token de pre-auth real emitido por
    POST /auth/login con 2FA pendiente) debe ser rechazado por
    get_current_user() con 401, nunca resolver un CurrentUser."""
    raw_token = jwt.encode(
        {"sub": str(VIEWER_USER.id), "pending_2fa": True, "typ": "pre_auth"},
        "irrelevant-secret-not-checked-by-fake-service",
        algorithm=JWT_ALGORITHM,
    )
    fake_service = _FakeAuthService(
        tokens={raw_token: VIEWER_USER},
        payloads={raw_token: {"sub": str(VIEWER_USER.id), "pending_2fa": True, "typ": "pre_auth"}},
    )
    app = _build_app(fake_service)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, raw_token)

    response = client.get("/protected")

    assert response.status_code == 401
    assert "not authenticated" in response.json()["detail"]


def test_get_current_user_allows_token_without_pending_2fa_claim():
    """No-regresión explícita: un token cuyo payload NO tiene `pending_2fa`
    (el caso de todo token de sesión completa pre-existente) sigue
    resolviendo el CurrentUser con normalidad — el chequeo nuevo de 3.1 no
    debe romper el flujo ya cubierto por
    test_get_current_user_with_valid_cookie_returns_current_user."""
    fake_service = _FakeAuthService(
        tokens={"valid-viewer-token": VIEWER_USER},
        payloads={"valid-viewer-token": {"sub": str(VIEWER_USER.id)}},
    )
    app = _build_app(fake_service)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, "valid-viewer-token")

    response = client.get("/protected")

    assert response.status_code == 200
