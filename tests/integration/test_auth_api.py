"""Tests de integración para /auth/google/* (google-oauth, Phase 3 + Phase 5).

Smoke test explícito de tasks.md 3.14 (los primeros 4 tests de este archivo):
confirma en pytest (en vez de curl manual) que /auth/google/login y
/auth/google/callback responden 503 cuando google_oauth_enabled=False (sin
credenciales configuradas), y que POST /auth/login / POST /auth/register
siguen funcionando exactamente igual (no-regresión).

El resto del archivo (Phase 5, tasks.md 5.1-5.14) cubre el contrato HTTP
completo de /auth/google/callback con google_oauth_enabled=True: status
codes, redirects, cookies, y qué se invoca (y con qué params) sobre
AuthService y sobre el cliente `oauth.google` de Authlib — mockeados, nunca
contra Google real.

No usa testcontainers/Postgres real (mismo criterio que tests/unit/test_deps.py
y tests/unit/test_auth_service.py): app.state.auth_service se reemplaza por un
AsyncMock/fake controlado — no se levanta la app vía `with TestClient(app)`
(lifespan no corre), y app.state se setea directamente antes de cada request,
mismo patrón ya usado en tests/unit/test_deps.py._build_app. La lógica
transaccional profunda de resolve_or_create_google_user() (atomicidad,
auto-link a nivel de fila, bootstrap de superadmin) ya está cubierta
exhaustivamente contra Postgres real en tests/unit/test_auth_service.py
(Phase 2) — acá se verifica que el endpoint invoca ese método con los
parámetros correctos y reacciona bien a su resultado, no se re-prueba su
lógica interna.

`oauth.google` (el RemoteApp registrado por Authlib) se reemplaza por
completo vía monkeypatch en vez de usar `oauth.register(...)` real, porque
sin credenciales reales `oauth.register()` dispararía un fetch real de
`server_metadata_url` (discovery document de Google) la primera vez que se
usa el cliente — inaceptable en tests. Reemplazar el atributo `google` del
`OAuth()` singleton module-level con un `SimpleNamespace`/`MagicMock` propio
evita cualquier interacción de red.
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.responses import RedirectResponse
from fastapi.testclient import TestClient

from src.main import app, oauth
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


def _fake_google_client(*, userinfo=None, authorize_access_token_side_effect=None):
    """Construye un reemplazo de `oauth.google` (RemoteApp de Authlib) con
    `authorize_redirect`/`authorize_access_token` mockeados — nunca pega a
    Google real. `userinfo=None` simula un `token` sin claim `userinfo`
    (ID token inválido/ausente, 5.12); pasar un dict simula un intercambio
    exitoso."""
    client = SimpleNamespace()
    client.authorize_redirect = AsyncMock(
        return_value=RedirectResponse(
            url="https://accounts.google.com/o/oauth2/v2/auth?state=fake-state",
            status_code=302,
        )
    )
    if authorize_access_token_side_effect is not None:
        client.authorize_access_token = AsyncMock(side_effect=authorize_access_token_side_effect)
    else:
        client.authorize_access_token = AsyncMock(return_value={"userinfo": userinfo})
    return client


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


# =============================================================================
# Phase 5 (tasks.md 5.1-5.14) — contrato HTTP completo de /auth/google/*
# con google_oauth_enabled=True. oauth.google se reemplaza vía monkeypatch
# (fixture `_fake_google_client` de arriba); auth_service se mockea con el
# mismo patrón que los tests de no-regresión de arriba.
# =============================================================================


def test_google_login_redirects_to_google_with_state_when_configured(client, monkeypatch):
    """5.2 (segunda mitad — la rama 503 ya está cubierta por
    test_google_login_returns_503_when_oauth_not_configured, arriba, no se
    duplica acá). Con google_oauth_enabled=True, GET /auth/google/login
    responde 302 hacia Google con `state` en el query — [Requirement:
    Endpoints OAuth de Google / Scenario: GET /auth/google/login redirige a
    Google con los parámetros correctos]."""
    app.state.auth_service = MagicMock()
    app.state.google_oauth_enabled = True
    monkeypatch.setattr(oauth, "google", _fake_google_client(), raising=False)

    response = client.get("/auth/google/login", follow_redirects=False)

    assert response.status_code == 302
    location = response.headers["location"]
    assert location.startswith("https://accounts.google.com/")
    assert "state=" in location


def _fake_auth_service_for_callback(resolved_user: UserPublic) -> MagicMock:
    fake = MagicMock()
    fake.resolve_or_create_google_user = AsyncMock(return_value=resolved_user)
    fake.create_access_token = MagicMock(return_value="fake-google-jwt")
    return fake


def test_google_callback_success_new_user_invokes_resolve_and_sets_cookie(client, monkeypatch):
    """5.3 + 5.4: callback exitoso con email nuevo y email_verified=true.
    AuthService está mockeado (la lógica transaccional de bootstrap/creación
    ya la cubre exhaustivamente tests/unit/test_auth_service.py contra
    Postgres real, Phase 2) — acá se valida el contrato HTTP del endpoint:
    resolve_or_create_google_user() se invoca con sub/email correctos,
    create_access_token() se invoca con el usuario resuelto, la cookie
    `session` se setea, y responde 302 —
    [Requirement: Login/registro vía Google para email nuevo / Scenario:
    Registro exitoso vía Google con email nuevo] +
    [Requirement: Bootstrap del primer superadmin vía Google / Scenario: El
    primer registro del sistema vía Google se convierte en superadmin]
    (el rol real "superadmin" en tabla vacía es responsabilidad de
    AuthService, ya probado en Phase 2 — acá el mock simplemente lo retorna
    y se confirma que el endpoint lo propaga sin alterarlo)."""
    resolved_user = UserPublic(
        id="3f9a2b1c-1111-2222-3333-444455556670",
        email="nuevo-google@example.com",
        role=UserRole.SUPERADMIN,
    )
    fake_auth_service = _fake_auth_service_for_callback(resolved_user)
    app.state.auth_service = fake_auth_service
    app.state.google_oauth_enabled = True
    monkeypatch.setattr(
        oauth,
        "google",
        _fake_google_client(
            userinfo={
                "sub": "google-sub-123",
                "email": "nuevo-google@example.com",
                "email_verified": True,
            }
        ),
        raising=False,
    )

    response = client.get(
        "/auth/google/callback",
        params={"code": "auth-code", "state": "fake-state"},
        follow_redirects=False,
    )

    assert response.status_code == 302
    assert response.headers["location"] == "/"
    assert response.cookies.get("session") == "fake-google-jwt"
    fake_auth_service.resolve_or_create_google_user.assert_awaited_once_with(
        google_id="google-sub-123", email="nuevo-google@example.com"
    )
    fake_auth_service.create_access_token.assert_called_once_with(resolved_user)


def test_google_callback_auto_link_invokes_resolve_and_sets_cookie(client, monkeypatch):
    """5.5: auto-link de email existente con password. El mock de
    resolve_or_create_google_user simplemente simula esa rama devolviendo el
    usuario ya vinculado — la lógica real de auto-link (UPDATE en vez de
    INSERT, password_hash intacto, no duplica fila) ya está probada contra
    Postgres real en tests/unit/test_auth_service.py::test_...auto_link...
    (Phase 2). Acá se valida que el endpoint invoca el método con los
    params correctos y responde igual que en el caso de usuario nuevo (el
    endpoint no distingue auto-link de creación — ambos casos son
    indistinguibles desde afuera, por diseño) —
    [Requirement: Auto-link por email con usuario existente de password /
    Scenario: Auto-link exitoso con email verificado por Google]."""
    linked_user = UserPublic(
        id="3f9a2b1c-1111-2222-3333-444455556671",
        email="ya-registrado@example.com",
        role=UserRole.VIEWER,
    )
    fake_auth_service = _fake_auth_service_for_callback(linked_user)
    app.state.auth_service = fake_auth_service
    app.state.google_oauth_enabled = True
    monkeypatch.setattr(
        oauth,
        "google",
        _fake_google_client(
            userinfo={
                "sub": "google-sub-456",
                "email": "ya-registrado@example.com",
                "email_verified": True,
            }
        ),
        raising=False,
    )

    response = client.get(
        "/auth/google/callback",
        params={"code": "auth-code", "state": "fake-state"},
        follow_redirects=False,
    )

    assert response.status_code == 302
    assert response.cookies.get("session") == "fake-google-jwt"
    fake_auth_service.resolve_or_create_google_user.assert_awaited_once_with(
        google_id="google-sub-456", email="ya-registrado@example.com"
    )


def test_google_callback_rejects_unverified_email_before_calling_auth_service(client, monkeypatch):
    """5.6: email_verified=false -> el endpoint rechaza ANTES de invocar
    resolve_or_create_google_user (assert de que el mock NO fue invocado),
    redirect a /login?error=google_oauth_email_not_verified, sin
    Set-Cookie — [Scenario: Login por Google rechazado cuando el email no
    está verificado por Google]."""
    fake_auth_service = _fake_auth_service_for_callback(
        UserPublic(id="3f9a2b1c-1111-2222-3333-444455556672", email="x@example.com", role=UserRole.VIEWER)
    )
    app.state.auth_service = fake_auth_service
    app.state.google_oauth_enabled = True
    monkeypatch.setattr(
        oauth,
        "google",
        _fake_google_client(
            userinfo={
                "sub": "google-sub-789",
                "email": "x@example.com",
                "email_verified": False,
            }
        ),
        raising=False,
    )

    response = client.get(
        "/auth/google/callback",
        params={"code": "auth-code", "state": "fake-state"},
        follow_redirects=False,
    )

    assert response.status_code == 302
    assert response.headers["location"] == "/login?error=google_oauth_email_not_verified"
    assert "session" not in response.cookies
    fake_auth_service.resolve_or_create_google_user.assert_not_awaited()


def test_linked_user_can_login_via_password_and_via_google_same_identity(client, monkeypatch):
    """5.7: usuario vinculado (password_hash y google_id ambos no nulos)
    puede loguearse tanto por POST /auth/login como por GET
    /auth/google/callback, y ambos resuelven al mismo id/role — test de
    integración que ejercita ambos endpoints contra el mismo mock de
    usuario. La atomicidad/consistencia a nivel de fila ya la garantiza
    Postgres real vía Phase 2; acá se confirma que ambos endpoints, cuando
    apuntan al mismo usuario, devuelven una identidad consistente desde la
    perspectiva HTTP —
    [Requirement: Login indistinto por password o Google para cuentas
    vinculadas / Scenario: Usuario vinculado se loguea por password después
    de haber sido vinculado por Google] +
    [Scenario: Usuario vinculado se loguea por Google después de haberse
    logueado antes por password]."""
    same_user_id = "3f9a2b1c-1111-2222-3333-444455556673"
    same_email = "vinculado@example.com"
    same_role = UserRole.ADMIN

    fake_user_in_db = MagicMock()
    fake_user_in_db.id = same_user_id
    fake_user_in_db.email = same_email
    fake_user_in_db.role = same_role
    fake_user_in_db.password_hash = "some-bcrypt-hash"

    fake_auth_service = MagicMock()
    fake_auth_service.get_user_by_email = AsyncMock(return_value=fake_user_in_db)
    fake_auth_service.verify_password = MagicMock(return_value=True)
    fake_auth_service.resolve_or_create_google_user = AsyncMock(
        return_value=UserPublic(id=same_user_id, email=same_email, role=same_role)
    )
    fake_auth_service.create_access_token = MagicMock(return_value="fake-jwt-shared-identity")
    app.state.auth_service = fake_auth_service
    app.state.google_oauth_enabled = True
    monkeypatch.setattr(
        oauth,
        "google",
        _fake_google_client(
            userinfo={"sub": "google-sub-999", "email": same_email, "email_verified": True}
        ),
        raising=False,
    )

    password_response = client.post(
        "/auth/login", json={"email": same_email, "password": "whatever1"}
    )
    google_response = client.get(
        "/auth/google/callback",
        params={"code": "auth-code", "state": "fake-state"},
        follow_redirects=False,
    )

    assert password_response.status_code == 200
    assert password_response.json()["id"] == same_user_id
    assert password_response.json()["role"] == same_role.value

    assert google_response.status_code == 302
    assert google_response.cookies.get("session") == "fake-jwt-shared-identity"


def test_google_callback_without_code_redirects_to_login_cancelled(client, monkeypatch):
    """5.8: sin `code` (cancelación) -> redirect a
    /login?error=google_oauth_cancelled, sin Set-Cookie, sin invocar
    AuthService — [Requirement: Manejo de errores del flujo OAuth de
    Google / Scenario: Usuario cancela el consentimiento de Google]."""
    fake_auth_service = MagicMock()
    fake_auth_service.resolve_or_create_google_user = AsyncMock()
    app.state.auth_service = fake_auth_service
    app.state.google_oauth_enabled = True
    monkeypatch.setattr(oauth, "google", _fake_google_client(), raising=False)

    response = client.get("/auth/google/callback", follow_redirects=False)

    assert response.status_code == 302
    assert response.headers["location"] == "/login?error=google_oauth_cancelled"
    assert "session" not in response.cookies
    fake_auth_service.resolve_or_create_google_user.assert_not_awaited()


def test_google_callback_with_access_denied_redirects_without_500(client, monkeypatch):
    """5.9: ?error=access_denied -> redirect a
    /login?error=google_oauth_access_denied, sin 500 —
    [Scenario: Google devuelve un parámetro de error explícito]."""
    app.state.auth_service = MagicMock()
    app.state.google_oauth_enabled = True
    monkeypatch.setattr(oauth, "google", _fake_google_client(), raising=False)

    response = client.get(
        "/auth/google/callback", params={"error": "access_denied"}, follow_redirects=False
    )

    assert response.status_code == 302
    assert response.headers["location"] == "/login?error=google_oauth_access_denied"
    assert "session" not in response.cookies


def test_google_callback_invalid_state_redirects_to_token_exchange_failed(client, monkeypatch):
    """5.10: `state` inválido/ausente/reutilizado -> Authlib levanta
    MismatchingStateError (subclase de OAuthError) al intentar el
    intercambio -> redirect a /login?error=google_oauth_token_exchange_failed,
    sin Set-Cookie, sin tocar `users` — [Scenario: GET /auth/google/callback
    rechaza un state inválido o ausente]."""
    from authlib.integrations.base_client.errors import MismatchingStateError

    fake_auth_service = MagicMock()
    fake_auth_service.resolve_or_create_google_user = AsyncMock()
    app.state.auth_service = fake_auth_service
    app.state.google_oauth_enabled = True
    monkeypatch.setattr(
        oauth,
        "google",
        _fake_google_client(authorize_access_token_side_effect=MismatchingStateError()),
        raising=False,
    )

    response = client.get(
        "/auth/google/callback",
        params={"code": "auth-code", "state": "wrong-or-missing"},
        follow_redirects=False,
    )

    assert response.status_code == 302
    assert response.headers["location"] == "/login?error=google_oauth_token_exchange_failed"
    assert "session" not in response.cookies
    fake_auth_service.resolve_or_create_google_user.assert_not_awaited()


def test_google_callback_token_exchange_network_failure_redirects_without_500(client, monkeypatch):
    """5.11: fallo del intercambio código->token por causa de red/timeout
    (no un state inválido, sino p.ej. Google devolviendo un error de
    credenciales o timeout) -> mismo resultado que 5.10. src/main.py
    (líneas ~734-747) captura `OAuthError` de forma genérica — la clase
    base de Authlib para CUALQUIER fallo del intercambio, no solo
    MismatchingStateError (confirmado por inspección de código: un único
    `except OAuthError` cubre ambos escenarios con la misma rama) —
    [Scenario: El intercambio de token con Google falla]."""
    from authlib.integrations.base_client.errors import OAuthError

    fake_auth_service = MagicMock()
    fake_auth_service.resolve_or_create_google_user = AsyncMock()
    app.state.auth_service = fake_auth_service
    app.state.google_oauth_enabled = True
    monkeypatch.setattr(
        oauth,
        "google",
        _fake_google_client(
            authorize_access_token_side_effect=OAuthError(
                error="invalid_grant", description="code expired or credentials invalid"
            )
        ),
        raising=False,
    )

    response = client.get(
        "/auth/google/callback",
        params={"code": "expired-code", "state": "fake-state"},
        follow_redirects=False,
    )

    assert response.status_code == 302
    assert response.headers["location"] == "/login?error=google_oauth_token_exchange_failed"
    assert "session" not in response.cookies
    fake_auth_service.resolve_or_create_google_user.assert_not_awaited()


def test_google_callback_missing_userinfo_redirects_to_invalid_id_token(client, monkeypatch):
    """5.12: `token` sin `userinfo` (o `userinfo=None`) -> ID token
    inválido/no parseable -> redirect a
    /login?error=google_oauth_invalid_id_token, sin invocar AuthService —
    [Scenario: El ID token de Google no puede validarse]."""
    fake_auth_service = MagicMock()
    fake_auth_service.resolve_or_create_google_user = AsyncMock()
    app.state.auth_service = fake_auth_service
    app.state.google_oauth_enabled = True
    monkeypatch.setattr(oauth, "google", _fake_google_client(userinfo=None), raising=False)

    response = client.get(
        "/auth/google/callback",
        params={"code": "auth-code", "state": "fake-state"},
        follow_redirects=False,
    )

    assert response.status_code == 302
    assert response.headers["location"] == "/login?error=google_oauth_invalid_id_token"
    assert "session" not in response.cookies
    fake_auth_service.resolve_or_create_google_user.assert_not_awaited()
