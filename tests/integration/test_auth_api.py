"""Tests de integración para /auth/google/* (google-oauth, Phase 3).

Smoke test explícito de tasks.md 3.14: confirma en pytest (en vez de curl
manual) que /auth/google/login y /auth/google/callback responden 503
cuando google_oauth_enabled=False (sin credenciales configuradas), y que
POST /auth/login / POST /auth/register siguen funcionando exactamente igual
(no-regresión).

No usa testcontainers/Postgres real (mismo criterio que tests/unit/test_deps.py
y tests/unit/test_auth_service.py): app.state.auth_service se reemplaza por un
AsyncMock/fake controlado — no se levanta la app vía `with TestClient(app)`
(lifespan no corre), y app.state se setea directamente antes de cada request,
mismo patrón ya usado en tests/unit/test_deps.py._build_app.

La cobertura completa de los escenarios de specs/auth/spec.md (state
inválido, email_verified, auto-link, bootstrap superadmin, etc., mockeando
oauth.google.authorize_access_token) es tarea de Phase 5 (tasks.md 5.1-5.16)
— fuera de alcance de este batch (Phase 3), que solo cubre el smoke test de
503/no-regresión pedido explícitamente en 3.14.
"""
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

from src.main import app
from src.models.user import UserPublic, UserRole


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_app_state():
    """Evita que el app.state mutado por un test se filtre al siguiente
    (app es un singleton module-level compartido entre todos los tests que
    importan src.main)."""
    yield
    if hasattr(app.state, "google_oauth_enabled"):
        del app.state._state["google_oauth_enabled"]
    if hasattr(app.state, "auth_service"):
        del app.state._state["auth_service"]


def test_google_login_returns_503_when_oauth_not_configured(client):
    """[design.md Decision 1] Sin credenciales de Google configuradas,
    GET /auth/google/login responde 503 en vez de intentar el redirect —
    verificación de tasks.md 3.14."""
    app.state.auth_service = MagicMock()
    app.state.google_oauth_enabled = False

    response = client.get("/auth/google/login")

    assert response.status_code == 503
    assert response.json() == {"error": "Google OAuth not configured"}


def test_google_callback_returns_503_when_oauth_not_configured(client):
    """Mismo criterio que /auth/google/login — el chequeo de
    google_oauth_enabled corre ANTES de cualquier intento de resolver
    `code`/`state` o de tocar AuthService — verificación de tasks.md 3.14."""
    app.state.auth_service = MagicMock()
    app.state.google_oauth_enabled = False

    response = client.get(
        "/auth/google/callback", params={"code": "x", "state": "y"}
    )

    assert response.status_code == 503
    assert response.json() == {"error": "Google OAuth not configured"}


def test_password_register_unaffected_by_google_oauth_disabled(client):
    """No-regresión: POST /auth/register sigue funcionando igual con
    google_oauth_enabled=False — [Requirement: No regresión sobre
    login/registro por email y password]."""
    app.state.google_oauth_enabled = False
    fake_user = UserPublic(
        id="3f9a2b1c-1111-2222-3333-444455556667",
        email="nuevo@example.com",
        role=UserRole.VIEWER,
    )
    fake_auth_service = MagicMock()
    fake_auth_service.create_user = AsyncMock(return_value=fake_user)
    app.state.auth_service = fake_auth_service

    response = client.post(
        "/auth/register",
        json={"email": "nuevo@example.com", "password": "longenough1"},
    )

    assert response.status_code == 201
    assert response.json()["email"] == "nuevo@example.com"
    assert response.json()["role"] == "viewer"


def test_password_login_unaffected_by_google_oauth_disabled(client):
    """No-regresión: POST /auth/login sigue funcionando igual con
    google_oauth_enabled=False, mismo shape de cookie `session` —
    [Requirement: No regresión sobre login/registro por email y password]."""
    app.state.google_oauth_enabled = False
    fake_user_in_db = MagicMock()
    fake_user_in_db.id = "3f9a2b1c-1111-2222-3333-444455556667"
    fake_user_in_db.email = "existente@example.com"
    fake_user_in_db.role = UserRole.VIEWER
    fake_user_in_db.password_hash = "irrelevant-hash"

    fake_auth_service = MagicMock()
    fake_auth_service.get_user_by_email = AsyncMock(return_value=fake_user_in_db)
    fake_auth_service.verify_password = MagicMock(return_value=True)
    fake_auth_service.create_access_token = MagicMock(return_value="fake-jwt")
    app.state.auth_service = fake_auth_service

    response = client.post(
        "/auth/login",
        json={"email": "existente@example.com", "password": "whatever1"},
    )

    assert response.status_code == 200
    assert response.cookies.get("session") == "fake-jwt"
