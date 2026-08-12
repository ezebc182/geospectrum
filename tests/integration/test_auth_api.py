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
import redis.asyncio as aioredis
from fastapi.responses import RedirectResponse
from fastapi.testclient import TestClient

from src.config.settings import settings
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
    if hasattr(app.state, "totp_login_attempt_limiter"):
        del app.state._state["totp_login_attempt_limiter"]


@pytest.fixture(autouse=True)
def _default_totp_login_attempt_limiter():
    """[account-settings, fix post-verify] `TestClient(app)` se usa sin
    `with` en este archivo (ver docstring del módulo) -- lifespan() nunca
    corre, así que `app.state.totp_login_attempt_limiter` (poblado ahí en
    producción) nunca se setea solo. Sin este fixture, CUALQUIER test que
    pegue a /auth/login o /auth/2fa/login-verify rompería con AttributeError
    al resolver Login2FAAttemptLimiter vía Depends(_get_totp_login_attempt_limiter).

    Default permisivo (nunca bloquea, no-ops en reset/register_failure) para
    no afectar los ~40 tests preexistentes de este archivo que no ejercitan
    el rate-limiting en sí -- los tests dedicados a Login2FAAttemptLimiter
    (más abajo) sobreescriben `app.state.totp_login_attempt_limiter` con un
    fake propio que sí simula el conteo/bloqueo."""
    fake_limiter = MagicMock()
    fake_limiter.check_not_locked = AsyncMock(return_value=None)
    fake_limiter.register_failure = AsyncMock(return_value=1)
    fake_limiter.reset = AsyncMock(return_value=None)
    app.state.totp_login_attempt_limiter = fake_limiter
    yield fake_limiter


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

    response = client.get("/auth/google/callback", params={"code": "x", "state": "y"})

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
    # Usuario de password puro: sin google_id/name/avatar_url (ver
    # migraciones 003/004) — explícitos en None para no depender del
    # comportamiento por default de MagicMock (que devolvería otro Mock,
    # no serializable por UserPublic/JSON).
    fake_user_in_db.google_id = None
    fake_user_in_db.name = None
    fake_user_in_db.avatar_url = None
    # totp_enabled (account-settings, migración 005): explícito en False —
    # un MagicMock sin este atributo seteado devuelve un Mock truthy, lo que
    # dispararía la rama de login de 2 pasos (requires_2fa) en vez del login
    # de un solo paso que este test de no-regresión verifica.
    fake_user_in_db.totp_enabled = False

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
                "name": "Nueva Persona",
                "picture": "https://lh3.googleusercontent.com/a/avatar123",
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
    assert response.headers["location"] == settings.dashboard_url
    assert response.cookies.get("session") == "fake-google-jwt"
    # name/avatar_url (extensión google-oauth, migración 004): el endpoint
    # extrae los claims OpenID Connect name/picture del userinfo y los pasa
    # a resolve_or_create_google_user() junto con sub/email.
    fake_auth_service.resolve_or_create_google_user.assert_awaited_once_with(
        google_id="google-sub-123",
        email="nuevo-google@example.com",
        name="Nueva Persona",
        avatar_url="https://lh3.googleusercontent.com/a/avatar123",
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
                # Sin name/picture en este caso: Google no siempre los
                # entrega (claims opcionales) — el endpoint debe pasar None
                # sin romper, y auto-link sigue funcionando igual.
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
        google_id="google-sub-456",
        email="ya-registrado@example.com",
        name=None,
        avatar_url=None,
    )


def test_google_callback_rejects_unverified_email_before_calling_auth_service(client, monkeypatch):
    """5.6: email_verified=false -> el endpoint rechaza ANTES de invocar
    resolve_or_create_google_user (assert de que el mock NO fue invocado),
    redirect a /login?error=google_oauth_email_not_verified, sin
    Set-Cookie — [Scenario: Login por Google rechazado cuando el email no
    está verificado por Google]."""
    fake_auth_service = _fake_auth_service_for_callback(
        UserPublic(
            id="3f9a2b1c-1111-2222-3333-444455556672", email="x@example.com", role=UserRole.VIEWER
        )
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
    assert (
        response.headers["location"]
        == f"{settings.dashboard_url}/login?error=google_oauth_email_not_verified"
    )
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
    # Explícitos en None (ver comentario equivalente arriba en
    # test_password_login_unaffected_by_google_oauth_disabled).
    fake_user_in_db.google_id = "google-sub-999"
    fake_user_in_db.name = None
    fake_user_in_db.avatar_url = None
    # totp_enabled (account-settings, migración 005): ver comentario
    # equivalente en test_password_login_unaffected_by_google_oauth_disabled.
    fake_user_in_db.totp_enabled = False

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
    assert (
        response.headers["location"]
        == f"{settings.dashboard_url}/login?error=google_oauth_cancelled"
    )
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
    assert (
        response.headers["location"]
        == f"{settings.dashboard_url}/login?error=google_oauth_access_denied"
    )
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
    assert (
        response.headers["location"]
        == f"{settings.dashboard_url}/login?error=google_oauth_token_exchange_failed"
    )
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
    assert (
        response.headers["location"]
        == f"{settings.dashboard_url}/login?error=google_oauth_token_exchange_failed"
    )
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
    assert (
        response.headers["location"]
        == f"{settings.dashboard_url}/login?error=google_oauth_invalid_id_token"
    )
    assert "session" not in response.cookies
    fake_auth_service.resolve_or_create_google_user.assert_not_awaited()


# =============================================================================
# account-settings (Phase 3, tasks.md 3.12-3.32) — contrato HTTP completo de
# los endpoints nuevos: login de 2 pasos con 2FA, /auth/2fa/*, /account/*.
#
# Mismo criterio de mocking que el resto del archivo: app.state.auth_service
# reemplazado por MagicMock/AsyncMock, sin Postgres real ni lifespan real.
# La lógica transaccional profunda (enable_totp, verify_totp_setup,
# consume_backup_code, delete_account con el chequeo de último superadmin,
# etc.) ya está cubierta contra Postgres real en tests/unit/test_auth_service.py
# (Phase 2) — acá se verifica que cada endpoint invoca el método correcto,
# traduce las excepciones a los códigos HTTP esperados, y maneja las cookies
# (`session`/`pending_2fa_session`) correctamente.
# =============================================================================

from uuid import UUID

from src.services.auth_service import (
    InvalidTotpCodeError,
    LastSuperadminError,
    TotpAlreadyEnabledError,
    TotpNotAvailableForGoogleOnlyUserError,
)
from src.models.user import AccountExport, UserProfile


def _fake_user_in_db(*, totp_enabled: bool, password_hash: str = "some-bcrypt-hash") -> MagicMock:
    user = MagicMock()
    user.id = "3f9a2b1c-1111-2222-3333-444455556680"
    user.email = "con2fa@example.com"
    user.role = UserRole.VIEWER
    user.password_hash = password_hash
    user.google_id = None
    user.name = None
    user.avatar_url = None
    user.totp_enabled = totp_enabled
    return user


# ---------------------------------------------------------------------------
# 3.12/3.13 — Login con 2FA habilitado: no otorga sesión completa de entrada.
# ---------------------------------------------------------------------------


def test_login_with_totp_enabled_returns_requires_2fa_without_session_cookie(client):
    """3.12: [Requirement: Login con 2FA habilitado requiere segundo factor /
    Scenario: Login con password correcto pero sin segundo factor no otorga
    sesión completa]."""
    fake_user = _fake_user_in_db(totp_enabled=True)
    fake_auth_service = MagicMock()
    fake_auth_service.get_user_by_email = AsyncMock(return_value=fake_user)
    fake_auth_service.verify_password = MagicMock(return_value=True)
    fake_auth_service.create_access_token = MagicMock(return_value="fake-pre-auth-jwt")
    app.state.auth_service = fake_auth_service

    response = client.post(
        "/auth/login", json={"email": "con2fa@example.com", "password": "whatever1"}
    )

    assert response.status_code == 200
    assert response.json() == {"requires_2fa": True}
    assert "session" not in response.cookies
    assert response.cookies.get("pending_2fa_session") == "fake-pre-auth-jwt"
    fake_auth_service.create_access_token.assert_called_once_with(fake_user, pending_2fa=True)


def test_me_with_pending_2fa_cookie_instead_of_session_returns_401(client):
    """3.13: GET /auth/me usando la cookie pending_2fa_session en vez de
    session -> 401 (verifica el rechazo de deps.py 3.1/3.2 a nivel de
    endpoint real, no solo unitario) — mismo Requirement que 3.12."""
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={
            "sub": "3f9a2b1c-1111-2222-3333-444455556680",
            "pending_2fa": True,
            "typ": "pre_auth",
        }
    )
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-pre-auth-jwt")
    response = client.get("/auth/me")

    assert response.status_code == 401


# ---------------------------------------------------------------------------
# 3.14-3.16 — POST /auth/2fa/login-verify
# ---------------------------------------------------------------------------


def test_login_verify_2fa_with_valid_totp_code_issues_session_cookie(client):
    """3.14: código TOTP válido tras login con 2FA pendiente -> 200,
    Set-Cookie session, Delete-Cookie pending_2fa_session —
    [Requirement: Login con 2FA habilitado requiere segundo factor /
    Scenario: Login completo con password y código TOTP válido]."""
    fake_user = _fake_user_in_db(totp_enabled=True)
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": fake_user.id, "pending_2fa": True, "typ": "pre_auth"}
    )
    fake_auth_service.verify_totp_or_backup_code = AsyncMock(return_value=True)
    fake_auth_service.get_user_by_id = AsyncMock(return_value=fake_user)
    fake_auth_service.create_access_token = MagicMock(return_value="fake-full-session-jwt")
    app.state.auth_service = fake_auth_service

    client.cookies.set("pending_2fa_session", "fake-pre-auth-jwt")
    response = client.post("/auth/2fa/login-verify", json={"code": "123456"})

    assert response.status_code == 200
    assert response.cookies.get("session") == "fake-full-session-jwt"
    assert response.json()["email"] == fake_user.email
    fake_auth_service.create_access_token.assert_called_once_with(fake_user)


def test_login_verify_2fa_with_invalid_code_returns_401_without_session_cookie(client):
    """3.15: código TOTP incorrecto/expirado -> 401, sin Set-Cookie session
    — [Scenario: Login rechazado con código TOTP incorrecto]."""
    fake_user = _fake_user_in_db(totp_enabled=True)
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": fake_user.id, "pending_2fa": True, "typ": "pre_auth"}
    )
    fake_auth_service.verify_totp_or_backup_code = AsyncMock(return_value=False)
    app.state.auth_service = fake_auth_service

    client.cookies.set("pending_2fa_session", "fake-pre-auth-jwt")
    response = client.post("/auth/2fa/login-verify", json={"code": "000000"})

    assert response.status_code == 401
    assert "session" not in response.cookies


def test_login_verify_2fa_without_pending_cookie_returns_401(client):
    """Cookie pending_2fa_session ausente -> 401, sin invocar
    verify_totp_or_backup_code."""
    fake_auth_service = MagicMock()
    fake_auth_service.verify_totp_or_backup_code = AsyncMock()
    app.state.auth_service = fake_auth_service

    response = client.post("/auth/2fa/login-verify", json={"code": "123456"})

    assert response.status_code == 401
    fake_auth_service.verify_totp_or_backup_code.assert_not_awaited()


def test_login_verify_2fa_with_backup_code_issues_session_and_invalidates_code(client):
    """3.16: backup code válido en vez del TOTP -> 200, sesión completa
    equivalente; una segunda llamada con el MISMO backup code falla —
    [Requirement: Uso de backup codes / Scenario: Login exitoso usando un
    backup code] + [Scenario: Un backup code ya usado no puede reutilizarse].
    verify_totp_or_backup_code ya encapsula "consumir" el backup code (Phase
    2) — acá se simula la segunda llamada devolviendo False, como lo haría
    el service real tras el consumo."""
    fake_user = _fake_user_in_db(totp_enabled=True)
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": fake_user.id, "pending_2fa": True, "typ": "pre_auth"}
    )
    fake_auth_service.verify_totp_or_backup_code = AsyncMock(side_effect=[True, False])
    fake_auth_service.get_user_by_id = AsyncMock(return_value=fake_user)
    fake_auth_service.create_access_token = MagicMock(return_value="fake-full-session-jwt")
    app.state.auth_service = fake_auth_service

    client.cookies.set("pending_2fa_session", "fake-pre-auth-jwt")
    first = client.post("/auth/2fa/login-verify", json={"code": "AAAA-BBBB"})
    assert first.status_code == 200
    assert first.cookies.get("session") == "fake-full-session-jwt"

    client.cookies.set("pending_2fa_session", "fake-pre-auth-jwt")
    second = client.post("/auth/2fa/login-verify", json={"code": "AAAA-BBBB"})
    assert second.status_code == 401


# ---------------------------------------------------------------------------
# Rate-limiting de POST /auth/2fa/login-verify (account-settings, fix
# post-verify) -- a diferencia del resto de este archivo, estos tests SÍ
# ejercitan el Login2FAAttemptLimiter REAL contra el Redis real de
# testcontainers (fixture `redis_url`, tests/integration/conftest.py) en vez
# de mockearlo: la garantía que importa acá ("tras N intentos, ni un código
# correcto pasa") depende de la lógica real de conteo/lockout, no solo de
# que el endpoint invoque el método correcto.
#
# Usan httpx.AsyncClient(transport=ASGITransport) en vez del fixture `client`
# (TestClient síncrono) A PROPÓSITO: sin `with TestClient(app) as c:` (que
# arrancaría lifespan() real, requiriendo Postgres), cada llamada
# `client.post(...)` de TestClient corre en un event loop *nuevo* -- y el
# cliente `redis.asyncio` conectado en este test quedaría atado al loop de su
# primer uso, rompiendo ("Future attached to a different loop") en la
# segunda llamada. AsyncClient corriendo dentro de un test `async def` (mismo
# loop de pytest-asyncio para todo el test) evita ese problema por completo.
# ---------------------------------------------------------------------------

from httpx import ASGITransport, AsyncClient

from src.services.auth_service import Login2FAAttemptLimiter, MAX_TOTP_LOGIN_ATTEMPTS


@pytest.mark.asyncio
async def test_login_verify_2fa_blocks_after_max_failed_attempts_even_with_correct_code(redis_url):
    """(a)+(b): los primeros MAX_TOTP_LOGIN_ATTEMPTS-1 códigos incorrectos
    fallan con 401 normal (verify_totp_or_backup_code SÍ se invoca); al
    llegar al límite, incluso un código CORRECTO enviado después es
    rechazado con 401 SIN que verify_totp_or_backup_code llegue a evaluarlo
    -- el usuario debe reiniciar el login desde POST /auth/login."""
    fake_user = _fake_user_in_db(totp_enabled=True)
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": fake_user.id, "pending_2fa": True, "typ": "pre_auth"}
    )
    fake_auth_service.verify_totp_or_backup_code = AsyncMock(return_value=False)
    fake_auth_service.get_user_by_id = AsyncMock(return_value=fake_user)
    app.state.auth_service = fake_auth_service
    redis_client = aioredis.from_url(redis_url, decode_responses=True)
    app.state.totp_login_attempt_limiter = Login2FAAttemptLimiter(redis_client)

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as ac:
            ac.cookies.set("pending_2fa_session", "fake-pre-auth-jwt")
            for attempt in range(MAX_TOTP_LOGIN_ATTEMPTS):
                response = await ac.post("/auth/2fa/login-verify", json={"code": "000000"})
                assert (
                    response.status_code == 401
                ), f"attempt {attempt} debía ser 401 por código incorrecto"

            assert (
                fake_auth_service.verify_totp_or_backup_code.await_count == MAX_TOTP_LOGIN_ATTEMPTS
            )

            # Se alcanzó el límite -- ahora un código CORRECTO también debe
            # ser rechazado, y verify_totp_or_backup_code NO debe ni
            # siquiera invocarse de nuevo (el rechazo ocurre antes, por
            # rate-limit).
            fake_auth_service.verify_totp_or_backup_code.reset_mock()
            fake_auth_service.verify_totp_or_backup_code = AsyncMock(return_value=True)
            locked_response = await ac.post("/auth/2fa/login-verify", json={"code": "123456"})

            assert locked_response.status_code == 401
            assert "session" not in locked_response.cookies
            fake_auth_service.verify_totp_or_backup_code.assert_not_awaited()
    finally:
        await redis_client.aclose()


@pytest.mark.asyncio
async def test_new_login_resets_totp_attempt_counter_for_next_login_verify(redis_url):
    """(c): un usuario que agotó su presupuesto de intentos en un login
    puede volver a intentar en un login NUEVO -- POST /auth/login emite un
    pre-auth token nuevo y resetea el contador (ver el reset() explícito en
    el endpoint /auth/login), sin necesidad de esperar el TTL."""
    fake_user = _fake_user_in_db(totp_enabled=True)
    fake_auth_service = MagicMock()
    fake_auth_service.get_user_by_email = AsyncMock(return_value=fake_user)
    fake_auth_service.verify_password = MagicMock(return_value=True)
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": fake_user.id, "pending_2fa": True, "typ": "pre_auth"}
    )
    fake_auth_service.create_access_token = MagicMock(return_value="fake-pre-auth-jwt")
    fake_auth_service.verify_totp_or_backup_code = AsyncMock(return_value=False)
    fake_auth_service.get_user_by_id = AsyncMock(return_value=fake_user)
    app.state.auth_service = fake_auth_service
    redis_client = aioredis.from_url(redis_url, decode_responses=True)
    app.state.totp_login_attempt_limiter = Login2FAAttemptLimiter(redis_client)

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as ac:
            # Agota el presupuesto de intentos del pre-auth actual.
            ac.cookies.set("pending_2fa_session", "fake-pre-auth-jwt")
            for _ in range(MAX_TOTP_LOGIN_ATTEMPTS):
                await ac.post("/auth/2fa/login-verify", json={"code": "000000"})

            still_locked = await ac.post("/auth/2fa/login-verify", json={"code": "000000"})
            assert still_locked.status_code == 401

            # Un login NUEVO (mismo usuario) debe resetear el contador --
            # verificado llamando a POST /auth/login, que invoca
            # totp_limiter.reset() antes de emitir la cookie
            # pending_2fa_session nueva.
            login_response = await ac.post(
                "/auth/login", json={"email": fake_user.email, "password": "whatever1"}
            )
            assert login_response.status_code == 200
            assert login_response.json() == {"requires_2fa": True}

            # Con el contador reseteado, el próximo login-verify puede
            # evaluar el código normalmente (no rechazado de entrada por
            # rate-limit).
            fake_auth_service.verify_totp_or_backup_code = AsyncMock(return_value=True)
            fake_auth_service.create_access_token = MagicMock(return_value="fake-full-session-jwt")
            ac.cookies.set("pending_2fa_session", login_response.cookies.get("pending_2fa_session"))
            success_response = await ac.post("/auth/2fa/login-verify", json={"code": "123456"})

            assert success_response.status_code == 200
            assert success_response.cookies.get("session") == "fake-full-session-jwt"
    finally:
        await redis_client.aclose()


# ---------------------------------------------------------------------------
# 3.17-3.18 — POST /auth/2fa/setup
# ---------------------------------------------------------------------------


def test_setup_2fa_rejects_google_only_user(client):
    """3.17: [Requirement: Activación de 2FA TOTP restringida a usuarios con
    password propio / Scenario: Usuario 100% Google sin password es
    rechazado]."""
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={
            "sub": "3f9a2b1c-1111-2222-3333-444455556680",
            "email": "g@example.com",
            "role": "viewer",
        }
    )
    fake_auth_service.decode_access_token = MagicMock(
        return_value=_current_user_for("3f9a2b1c-1111-2222-3333-444455556680")
    )
    fake_auth_service.enable_totp = AsyncMock(side_effect=TotpNotAvailableForGoogleOnlyUserError())
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    response = client.post("/auth/2fa/setup")

    assert response.status_code == 409
    assert "not available" in response.json()["error"]


def test_setup_2fa_without_session_returns_401(client):
    """3.18: sin cookie session válida -> 401 —
    [Scenario: Usuario no autenticado recibe 401]."""
    app.state.auth_service = MagicMock()

    response = client.post("/auth/2fa/setup")

    assert response.status_code == 401


def _current_user_for(user_id: str):
    from src.models.user import CurrentUser

    return CurrentUser(id=user_id, email="g@example.com", role=UserRole.VIEWER)


# ---------------------------------------------------------------------------
# 3.19-3.20 — POST /auth/2fa/setup -> POST /auth/2fa/verify (setup) + backup
# codes expuestos una única vez.
# ---------------------------------------------------------------------------


def test_setup_then_verify_2fa_flow_enables_totp(client):
    """3.19: flujo completo setup -> verify con código válido —
    [Requirement: Verificación del código TOTP en el setup / Scenario:
    Código TOTP válido en el setup habilita 2FA]."""
    user_id = "3f9a2b1c-1111-2222-3333-444455556680"
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": user_id, "email": "g@example.com", "role": "viewer"}
    )
    fake_auth_service.decode_access_token = MagicMock(return_value=_current_user_for(user_id))
    fake_auth_service.enable_totp = AsyncMock(
        return_value=("otpauth://totp/GeoSpectrum:g@example.com?secret=ABC", ["AAAA-BBBB"] * 10)
    )
    fake_auth_service.verify_totp_setup = AsyncMock(return_value=None)
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    setup_response = client.post("/auth/2fa/setup")
    assert setup_response.status_code == 200
    assert setup_response.json()["otpauth_uri"].startswith("otpauth://")
    assert len(setup_response.json()["backup_codes"]) == 10

    verify_response = client.post("/auth/2fa/verify", json={"code": "123456"})
    assert verify_response.status_code == 200
    fake_auth_service.verify_totp_setup.assert_awaited_once_with(UUID(user_id), "123456")


def test_setup_2fa_rejects_when_already_enabled(client):
    """Complementa 3.19/3.20: una segunda llamada de setup mientras
    totp_enabled=true ya (sin disable previo) -> 409, no expone backup codes
    nuevos — cubre la rama TotpAlreadyEnabledError del endpoint."""
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={
            "sub": "3f9a2b1c-1111-2222-3333-444455556680",
            "email": "g@example.com",
            "role": "viewer",
        }
    )
    fake_auth_service.decode_access_token = MagicMock(
        return_value=_current_user_for("3f9a2b1c-1111-2222-3333-444455556680")
    )
    fake_auth_service.enable_totp = AsyncMock(side_effect=TotpAlreadyEnabledError())
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    response = client.post("/auth/2fa/setup")

    assert response.status_code == 409


def test_verify_2fa_setup_with_invalid_code_returns_400_and_does_not_enable(client):
    """[Requirement: Verificación del código TOTP en el setup / Scenario:
    Código TOTP inválido en el setup no habilita 2FA]."""
    user_id = "3f9a2b1c-1111-2222-3333-444455556680"
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": user_id, "email": "g@example.com", "role": "viewer"}
    )
    fake_auth_service.decode_access_token = MagicMock(return_value=_current_user_for(user_id))
    fake_auth_service.verify_totp_setup = AsyncMock(side_effect=InvalidTotpCodeError())
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    response = client.post("/auth/2fa/verify", json={"code": "000000"})

    assert response.status_code == 400


# ---------------------------------------------------------------------------
# 3.21-3.22 — POST /auth/2fa/disable
# ---------------------------------------------------------------------------


def test_disable_2fa_with_full_session_succeeds(client):
    """3.21: [Requirement: Deshabilitación de 2FA / Scenario: Usuario
    autenticado deshabilita su 2FA exitosamente]."""
    user_id = "3f9a2b1c-1111-2222-3333-444455556680"
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": user_id, "email": "g@example.com", "role": "viewer"}
    )
    fake_auth_service.decode_access_token = MagicMock(return_value=_current_user_for(user_id))
    fake_auth_service.disable_totp = AsyncMock(return_value=None)
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    response = client.post("/auth/2fa/disable")

    assert response.status_code == 200
    fake_auth_service.disable_totp.assert_awaited_once_with(UUID(user_id))


def test_disable_2fa_without_session_returns_401(client):
    """3.22: sin cookie session válida -> 401 —
    [Scenario: Usuario no autenticado recibe 401 al intentar deshabilitar 2FA]."""
    fake_auth_service = MagicMock()
    fake_auth_service.disable_totp = AsyncMock()
    app.state.auth_service = fake_auth_service

    response = client.post("/auth/2fa/disable")

    assert response.status_code == 401
    fake_auth_service.disable_totp.assert_not_awaited()


# ---------------------------------------------------------------------------
# 3.23-3.24 — GET/PATCH /account/profile
# ---------------------------------------------------------------------------


def test_get_account_profile_with_full_session_returns_profile(client):
    """3.23: perfil completo -> 200 con los tres valores; sin sesión -> 401."""
    user_id = "3f9a2b1c-1111-2222-3333-444455556680"
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": user_id, "email": "g@example.com", "role": "viewer"}
    )
    fake_auth_service.decode_access_token = MagicMock(return_value=_current_user_for(user_id))
    fake_auth_service.get_profile = AsyncMock(
        return_value=UserProfile(
            full_name="Ana Gómez",
            address="Av. Siempre Viva 742",
            phone="+54 9 11 5555-5555",
            totp_enabled=True,
        )
    )
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    response = client.get("/account/profile")

    assert response.status_code == 200
    assert response.json() == {
        "full_name": "Ana Gómez",
        "address": "Av. Siempre Viva 742",
        "phone": "+54 9 11 5555-5555",
        "totp_enabled": True,
        # i18n-dashboard: el perfil expone la preferencia de idioma; None =
        # "nunca eligió" (Scenario: Cuenta preexistente sin preferencia).
        "locale": None,
    }


def test_get_account_profile_without_session_returns_401(client):
    app.state.auth_service = MagicMock()

    response = client.get("/account/profile")

    assert response.status_code == 401


def test_patch_account_profile_updates_and_ignores_role_and_email(client):
    """3.24: cubre completar por primera vez, edición parcial, body vacío
    sin error, e intento de enviar role/email no los modifica (garantizado
    por el shape de UserProfileUpdate, que no declara esos campos — un
    intento de enviarlos es simplemente ignorado por Pydantic al no estar
    declarados en el modelo, ni siquiera llega a auth_service)."""
    user_id = "3f9a2b1c-1111-2222-3333-444455556680"
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": user_id, "email": "g@example.com", "role": "viewer"}
    )
    fake_auth_service.decode_access_token = MagicMock(return_value=_current_user_for(user_id))
    fake_auth_service.update_profile = AsyncMock(
        return_value=UserProfile(full_name="Bruno", address=None, phone=None)
    )
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    response = client.patch(
        "/account/profile",
        json={"full_name": "Bruno", "role": "superadmin", "email": "otro@example.com"},
    )

    assert response.status_code == 200
    assert response.json()["full_name"] == "Bruno"
    # El payload que efectivamente llega a auth_service.update_profile() no
    # puede tener role/email — UserProfileUpdate no declara esos campos.
    called_update = fake_auth_service.update_profile.await_args.args[1]
    assert not hasattr(called_update, "role")
    assert not hasattr(called_update, "email")


def test_patch_account_profile_without_session_returns_401(client):
    fake_auth_service = MagicMock()
    fake_auth_service.update_profile = AsyncMock()
    app.state.auth_service = fake_auth_service

    response = client.patch("/account/profile", json={"full_name": "X"})

    assert response.status_code == 401
    fake_auth_service.update_profile.assert_not_awaited()


# ---------------------------------------------------------------------------
# 3.25-3.26 — Aislamiento del perfil extendido respecto de /auth/me y del JWT
# ---------------------------------------------------------------------------


def test_me_response_never_includes_extended_profile_fields(client):
    """3.25: GET /auth/me de un usuario con perfil extendido completado NO
    incluye full_name/address/phone en el body — [Requirement: Aislamiento
    del perfil extendido respecto de /auth/me y del JWT / Scenario: El
    perfil extendido no aparece en /auth/me]. CurrentUser (el response_model
    de /auth/me) no declara esos campos — la garantía es de shape, no de un
    chequeo ad-hoc."""
    user_id = "3f9a2b1c-1111-2222-3333-444455556680"
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": user_id, "email": "g@example.com", "role": "viewer"}
    )
    fake_auth_service.decode_access_token = MagicMock(return_value=_current_user_for(user_id))
    # email-invitations (Fase 3): get_me() ahora lee onboarding_completed_at
    # de la base via get_onboarding_status() — el mock debe ser awaitable.
    fake_auth_service.get_onboarding_status = AsyncMock(return_value=None)
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    response = client.get("/auth/me")

    assert response.status_code == 200
    body = response.json()
    assert "full_name" not in body
    assert "address" not in body
    assert "phone" not in body


def test_login_jwt_claims_never_include_extended_profile_fields(client):
    """3.26: decodificar el JWT real emitido por create_access_token() de un
    usuario (sin 2FA) y confirmar que los claims no contienen
    full_name/address/phone — usa AuthService.create_access_token() real
    (no un mock del token), ya que el shape del claim es responsabilidad de
    ese método (Phase 2) y no depende de Postgres."""
    from src.services.auth_service import AuthService

    real_auth_service = AuthService(dsn="unused", secret_key="test-secret", token_expire_minutes=60)
    fake_user = _fake_user_in_db(totp_enabled=False)
    fake_user_for_email = MagicMock()
    fake_user_for_email.password_hash = fake_user.password_hash
    fake_user_for_email.id = fake_user.id
    fake_user_for_email.email = fake_user.email
    fake_user_for_email.role = fake_user.role
    fake_user_for_email.google_id = None
    fake_user_for_email.name = None
    fake_user_for_email.avatar_url = None
    fake_user_for_email.totp_enabled = False

    fake_auth_service = MagicMock()
    fake_auth_service.get_user_by_email = AsyncMock(return_value=fake_user_for_email)
    fake_auth_service.verify_password = MagicMock(return_value=True)
    fake_auth_service.create_access_token = MagicMock(
        side_effect=lambda user, pending_2fa=False: real_auth_service.create_access_token(
            user, pending_2fa=pending_2fa
        )
    )
    app.state.auth_service = fake_auth_service

    response = client.post("/auth/login", json={"email": fake_user.email, "password": "whatever1"})
    assert response.status_code == 200

    token = response.cookies.get("session")
    claims = real_auth_service.decode_token_payload(token)
    assert "full_name" not in claims
    assert "address" not in claims
    assert "phone" not in claims


# ---------------------------------------------------------------------------
# 3.27-3.28 — GET /account/export
# ---------------------------------------------------------------------------


def test_export_account_returns_json_without_sensitive_fields(client):
    """3.27: 200 JSON válido con email/role/perfil, sin password_hash/
    totp_secret/backup codes — [Requirement: Exportación de los propios
    datos de cuenta / Scenario: Usuario autenticado exporta sus propios
    datos]; sin sesión -> 401."""
    user_id = "3f9a2b1c-1111-2222-3333-444455556680"
    fake_export = AccountExport(
        account={
            "id": user_id,
            "email": "g@example.com",
            "role": "viewer",
            "google_id": None,
            "name": None,
            "avatar_url": None,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-15T00:00:00Z",
        },
        profile=UserProfile(full_name="Ana", address=None, phone=None),
        security={"has_password": True, "totp_enabled": False, "linked_google_account": False},
        exported_at="2026-07-20T12:00:00Z",
    )
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": user_id, "email": "g@example.com", "role": "viewer"}
    )
    fake_auth_service.decode_access_token = MagicMock(return_value=_current_user_for(user_id))
    fake_auth_service.export_user_data = AsyncMock(return_value=fake_export)
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    response = client.get("/account/export")

    assert response.status_code == 200
    body = response.json()
    assert body["account"]["email"] == "g@example.com"
    assert body["account"]["role"] == "viewer"
    body_str = str(body)
    assert "password_hash" not in body_str
    assert "totp_secret" not in body_str


def test_export_account_without_session_returns_401(client):
    fake_auth_service = MagicMock()
    fake_auth_service.export_user_data = AsyncMock()
    app.state.auth_service = fake_auth_service

    response = client.get("/account/export")

    assert response.status_code == 401
    fake_auth_service.export_user_data.assert_not_awaited()


def test_export_account_only_invokes_export_for_the_authenticated_user(client):
    """3.28: el export nunca incluye datos de otro usuario — a nivel HTTP
    esto se garantiza porque el endpoint SIEMPRE pasa current_user.id (el id
    resuelto de LA PROPIA cookie de sesión), nunca un id tomado de query
    params/body — se verifica que export_user_data() se invoca exactamente
    con el id del usuario autenticado por esta sesión."""
    own_user_id = "3f9a2b1c-1111-2222-3333-444455556681"
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": own_user_id, "email": "propio@example.com", "role": "viewer"}
    )
    fake_auth_service.decode_access_token = MagicMock(return_value=_current_user_for(own_user_id))
    fake_auth_service.export_user_data = AsyncMock(
        return_value=AccountExport(
            account={
                "id": own_user_id,
                "email": "propio@example.com",
                "role": "viewer",
                "google_id": None,
                "name": None,
                "avatar_url": None,
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
            },
            profile=UserProfile(),
            security={"has_password": True, "totp_enabled": False, "linked_google_account": False},
            exported_at="2026-07-20T12:00:00Z",
        )
    )
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    response = client.get("/account/export")

    assert response.status_code == 200
    fake_auth_service.export_user_data.assert_awaited_once_with(UUID(own_user_id))


# ---------------------------------------------------------------------------
# 3.29-3.32 — DELETE /account
# ---------------------------------------------------------------------------


def test_delete_account_non_last_superadmin_succeeds_and_clears_session_cookie(client):
    """3.29: usuario no-superadmin-único -> 200/204, borra también la cookie
    session — [Requirement: Eliminación de la propia cuenta / Scenario:
    Usuario no-superadmin-único elimina su propia cuenta exitosamente]."""
    user_id = "3f9a2b1c-1111-2222-3333-444455556680"
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": user_id, "email": "g@example.com", "role": "viewer"}
    )
    fake_auth_service.decode_access_token = MagicMock(return_value=_current_user_for(user_id))
    fake_auth_service.delete_account = AsyncMock(return_value=None)
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    response = client.delete("/account")

    assert response.status_code == 200
    assert response.cookies.get("session") is None


def test_delete_account_last_superadmin_returns_409_with_explicit_message(client):
    """3.30: único superadmin del sistema -> 409, mensaje explícito —
    [Scenario: El último superadmin del sistema no puede eliminar su propia
    cuenta]."""
    user_id = "3f9a2b1c-1111-2222-3333-444455556680"
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": user_id, "email": "root@example.com", "role": "superadmin"}
    )
    fake_auth_service.decode_access_token = MagicMock(return_value=_current_user_for(user_id))
    fake_auth_service.delete_account = AsyncMock(side_effect=LastSuperadminError())
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    response = client.delete("/account")

    assert response.status_code == 409
    assert "superadmin" in response.json()["error"]


def test_delete_account_non_unique_superadmin_succeeds(client):
    """3.31: superadmin no-único -> 200/204 (el mock de delete_account no
    lanza LastSuperadminError, mismo camino feliz que el test 3.29) —
    [Scenario: Un superadmin que no es el único puede eliminar su propia
    cuenta]."""
    user_id = "3f9a2b1c-1111-2222-3333-444455556680"
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": user_id, "email": "root2@example.com", "role": "superadmin"}
    )
    fake_auth_service.decode_access_token = MagicMock(return_value=_current_user_for(user_id))
    fake_auth_service.delete_account = AsyncMock(return_value=None)
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    response = client.delete("/account")

    assert response.status_code == 200


def test_delete_account_without_session_returns_401(client):
    """3.32: sin cookie session válida -> 401, ninguna fila se elimina."""
    fake_auth_service = MagicMock()
    fake_auth_service.delete_account = AsyncMock()
    app.state.auth_service = fake_auth_service

    response = client.delete("/account")

    assert response.status_code == 401


# ---------------------------------------------------------------------------
# Phase 5.2-5.4 — No-regresión explícita sobre login/registro/OAuth existente
# tras account-settings — [Requirement: No regresión sobre login/registro/
# OAuth existente]. Estos tests no duplican la lógica ya cubierta por
# test_password_login_unaffected_by_google_oauth_disabled/
# test_password_register_unaffected_by_google_oauth_disabled (arriba, del
# change google-oauth) ni por los tests de callback de Google (arriba) — acá
# se referencia explícitamente el Requirement de account-settings y se cubre
# el hueco puntual que faltaba: /auth/me sin 2FA, y el flujo Google OAuth
# completo con totp_enabled=false explícito bajo el nombre de este spec.
# ---------------------------------------------------------------------------


def test_login_without_totp_still_issues_full_session_in_one_step(client):
    """5.2: [Requirement: No regresión sobre login/registro/OAuth existente /
    Scenario: Login por password sin 2FA sigue funcionando exactamente igual
    que antes de este change]. totp_enabled=False explícito -- un solo
    request de POST /auth/login basta para obtener la cookie session
    completa, sin requires_2fa ni cookie pending_2fa_session."""
    fake_user_in_db = _fake_user_in_db(totp_enabled=False)
    fake_auth_service = MagicMock()
    fake_auth_service.get_user_by_email = AsyncMock(return_value=fake_user_in_db)
    fake_auth_service.verify_password = MagicMock(return_value=True)
    fake_auth_service.create_access_token = MagicMock(return_value="fake-full-session-jwt")
    app.state.auth_service = fake_auth_service

    response = client.post(
        "/auth/login",
        json={"email": fake_user_in_db.email, "password": "whatever1"},
    )

    assert response.status_code == 200
    assert response.cookies.get("session") == "fake-full-session-jwt"
    assert "pending_2fa_session" not in response.cookies
    assert response.json().get("requires_2fa") is None
    fake_auth_service.create_access_token.assert_called_once_with(fake_user_in_db)


def test_me_without_2fa_ever_configured_returns_current_user_normally(client):
    """5.4 (no-regresión de /auth/me): un usuario sin 2FA (totp_enabled
    ausente/false, el estado de todo usuario previo a este change) sigue
    autenticándose con la cookie session estándar y GET /auth/me responde 200
    con el shape ya especificado por multi-user-auth (id/email/role), sin
    ningún campo ni comportamiento nuevo introducido por account-settings."""
    user_id = "3f9a2b1c-1111-2222-3333-444455556690"
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": user_id, "email": "g@example.com", "role": "viewer"}
    )
    fake_auth_service.decode_access_token = MagicMock(return_value=_current_user_for(user_id))
    # email-invitations (Fase 3): get_me() ahora lee onboarding_completed_at
    # de la base via get_onboarding_status() — el mock debe ser awaitable.
    fake_auth_service.get_onboarding_status = AsyncMock(return_value=None)
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    response = client.get("/auth/me")

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == user_id
    assert body["email"] == "g@example.com"
    assert body["role"] == "viewer"


def test_google_oauth_full_flow_unaffected_by_account_settings_when_totp_disabled(
    client, monkeypatch
):
    """5.3: [Requirement: No regresión sobre login/registro/OAuth existente /
    Scenario: Login y registro vía Google siguen funcionando exactamente
    igual que antes de este change]. GET /auth/google/login -> GET
    /auth/google/callback con un usuario totp_enabled=False (explícito):
    ningún paso de 2FA se interpone, la cookie session completa se emite en
    el mismo callback, igual que especificaba google-oauth/specs/auth/spec.md
    antes de que existiera esta migración. create_access_token() se invoca
    SIN pending_2fa=True -- confirma que el flujo de Google nunca pasa por la
    rama de 2 pasos de login introducida por este change."""
    app.state.google_oauth_enabled = True
    resolved_user = UserPublic(
        id="3f9a2b1c-1111-2222-3333-444455556691",
        email="sin2fa-google@example.com",
        role=UserRole.VIEWER,
    )
    fake_auth_service = _fake_auth_service_for_callback(resolved_user)
    app.state.auth_service = fake_auth_service
    monkeypatch.setattr(
        oauth,
        "google",
        _fake_google_client(
            userinfo={
                "sub": "google-sub-no-2fa",
                "email": "sin2fa-google@example.com",
                "email_verified": True,
                "name": "Sin Dos Efe A",
                "picture": "https://lh3.googleusercontent.com/a/avatar-no2fa",
            }
        ),
        raising=False,
    )

    login_response = client.get("/auth/google/login", follow_redirects=False)
    assert login_response.status_code in (302, 307)

    callback_response = client.get(
        "/auth/google/callback",
        params={"code": "auth-code", "state": "fake-state"},
        follow_redirects=False,
    )

    assert callback_response.status_code == 302
    assert callback_response.headers["location"] == settings.dashboard_url
    assert callback_response.cookies.get("session") == "fake-google-jwt"
    assert "pending_2fa_session" not in callback_response.cookies
    # create_access_token(resolved_user) -- sin pending_2fa=True -- confirma
    # que el flujo de Google no pasa por el paso intermedio de 2FA.
    fake_auth_service.create_access_token.assert_called_once_with(resolved_user)


# =============================================================================
# email-invitations, Fase 4.5 — contrato NUEVO de POST /auth/register,
# onboarding, y el rechazo de Google sin invitación.
#
# Los tests del "registro abierto" ROMPEN POR DISEÑO con este change (previsto
# en el proposal): el registro dejó de ser público y pasó a exigir invitación.
# El único test viejo de register que sobrevive es
# test_password_register_unaffected_by_google_oauth_disabled (arriba), que
# mockea create_user() y por lo tanto verifica el contrato HTTP del endpoint
# (201 + shape), no la regla de invitación — sigue siendo válido y se conserva.
# Acá abajo se cubre la matriz completa de códigos de design.md Decision 3.
#
# Criterio de mocking: igual que el resto del archivo (auth_service fake). La
# lógica de consumo/atomicidad ya está verificada CONTRA POSTGRES REAL en
# tests/unit/test_auth_service.py (Fase 4.2/4.3); acá se verifica la
# TRADUCCIÓN excepción -> código HTTP, que es responsabilidad del endpoint.
# =============================================================================

from datetime import datetime, timezone  # noqa: E402

from src.services.auth_service import (  # noqa: E402
    EmailAlreadyRegisteredError,
    InvalidInvitationError,
    InvitationEmailMismatchError,
    InvitationRequiredError,
)


def _fake_auth_service_raising(exc: Exception) -> MagicMock:
    fake = MagicMock()
    fake.create_user = AsyncMock(side_effect=exc)
    return fake


def test_register_without_invitation_returns_403_invitation_required(client):
    """[Scenario: Registro sin token es rechazado en un sistema no vacío] —
    403 con el shape EXACTO que consume el dashboard: `invitation_required`
    con guión bajo (contrato vivo en producción)."""
    app.state.auth_service = _fake_auth_service_raising(
        InvitationRequiredError("colada@example.com")
    )

    response = client.post(
        "/auth/register",
        json={"email": "colada@example.com", "password": "longenough1"},
    )

    assert response.status_code == 403
    assert response.json() == {"error": "invitation_required"}


def test_register_with_invalid_token_returns_410_gone(client):
    """Token desconocido/expirado/revocado/consumido -> 410 (matriz Decision 3)."""
    app.state.auth_service = _fake_auth_service_raising(InvalidInvitationError("x@example.com"))

    response = client.post(
        "/auth/register",
        json={
            "email": "x@example.com",
            "password": "longenough1",
            "invitation_token": "token-muerto",
        },
    )

    assert response.status_code == 410
    assert response.json() == {"error": "invalid invitation"}


def test_register_with_email_mismatch_returns_422_not_410(client):
    """El mismatch de email es 422 y NO 410, pese a que
    InvitationEmailMismatchError es SUBCLASE de InvalidInvitationError: el
    endpoint la captura PRIMERO. Si el orden de los `except` se invirtiera,
    este test lo detecta (sería 410)."""
    app.state.auth_service = _fake_auth_service_raising(
        InvitationEmailMismatchError("usurpador@example.com")
    )

    response = client.post(
        "/auth/register",
        json={
            "email": "usurpador@example.com",
            "password": "longenough1",
            "invitation_token": "token-de-otra-persona",
        },
    )

    assert response.status_code == 422
    assert response.json() == {"error": "invitation email mismatch"}


def test_register_with_duplicate_email_returns_409(client):
    """Sin cambios respecto del contrato anterior."""
    app.state.auth_service = _fake_auth_service_raising(
        EmailAlreadyRegisteredError("repetida@example.com")
    )

    response = client.post(
        "/auth/register",
        json={"email": "repetida@example.com", "password": "longenough1"},
    )

    assert response.status_code == 409
    assert response.json() == {"error": "email already registered"}


def test_register_with_valid_invitation_returns_201_with_invited_role(client):
    """201 heredando el rol de la invitación — el `invitation_token` del
    payload LLEGA a create_user() (si el endpoint no lo reenviara, todo
    registro con token válido caería en el 403)."""
    fake_user = UserPublic(
        id="3f9a2b1c-1111-2222-3333-4444555566aa",
        email="invitada@example.com",
        role=UserRole.MODERADOR,
    )
    fake_auth_service = MagicMock()
    fake_auth_service.create_user = AsyncMock(return_value=fake_user)
    app.state.auth_service = fake_auth_service

    response = client.post(
        "/auth/register",
        json={
            "email": "invitada@example.com",
            "password": "longenough1",
            "invitation_token": "token-valido",
        },
    )

    assert response.status_code == 201
    assert response.json()["role"] == "moderador"
    kwargs = fake_auth_service.create_user.await_args.kwargs
    assert kwargs["invitation_token"] == "token-valido"


def test_register_bootstrap_on_empty_table_without_token_returns_201_superadmin(client):
    """[Scenario: No-lockout (3) bootstrap] a nivel API: con `users` vacía, un
    registro SIN token responde 201 y el usuario es superadmin. Es la válvula
    de escape de dev/staging/DR — sin ella una base nueva quedaría sin forma
    de entrar (nadie puede invitar porque no hay nadie)."""
    fake_user = UserPublic(
        id="3f9a2b1c-1111-2222-3333-4444555566bb",
        email="primero@example.com",
        role=UserRole.SUPERADMIN,
    )
    fake_auth_service = MagicMock()
    fake_auth_service.create_user = AsyncMock(return_value=fake_user)
    app.state.auth_service = fake_auth_service

    response = client.post(
        "/auth/register",
        json={"email": "primero@example.com", "password": "longenough1"},
    )

    assert response.status_code == 201
    assert response.json()["role"] == "superadmin"
    # Sin token en el payload: el bootstrap NO exige invitación.
    assert fake_auth_service.create_user.await_args.kwargs["invitation_token"] is None


def test_register_never_returns_an_invitation_token_in_the_response(client):
    """El response del registro no debe filtrar el token consumido."""
    fake_user = UserPublic(
        id="3f9a2b1c-1111-2222-3333-4444555566cc",
        email="sin-eco@example.com",
        role=UserRole.VIEWER,
    )
    fake_auth_service = MagicMock()
    fake_auth_service.create_user = AsyncMock(return_value=fake_user)
    app.state.auth_service = fake_auth_service

    response = client.post(
        "/auth/register",
        json={
            "email": "sin-eco@example.com",
            "password": "longenough1",
            "invitation_token": "token-secreto-abc123",
        },
    )

    assert response.status_code == 201
    assert "token-secreto-abc123" not in response.text
    assert "invitation_token" not in response.json()


# --- No-regresión de los logins existentes (No-lockout 1 y 2 a nivel API) ---


def test_password_login_of_existing_user_still_works_after_invitation_gate(client):
    """[Scenario: No-lockout (1)] — POST /auth/login NO se tocó en absoluto:
    un usuario existente sigue entrando con su password y recibiendo la cookie
    `session`. El gate de invitación vive en el REGISTRO, no en el login."""
    fake_user_in_db = MagicMock()
    fake_user_in_db.id = "3f9a2b1c-1111-2222-3333-4444555566dd"
    fake_user_in_db.email = "existente@example.com"
    fake_user_in_db.role = UserRole.ADMIN
    fake_user_in_db.password_hash = "hash-existente"
    fake_user_in_db.google_id = None
    fake_user_in_db.name = None
    fake_user_in_db.avatar_url = None
    fake_user_in_db.totp_enabled = False

    fake_auth_service = MagicMock()
    fake_auth_service.get_user_by_email = AsyncMock(return_value=fake_user_in_db)
    fake_auth_service.verify_password = MagicMock(return_value=True)
    fake_auth_service.create_access_token = MagicMock(return_value="fake-jwt")
    app.state.auth_service = fake_auth_service

    response = client.post(
        "/auth/login", json={"email": "existente@example.com", "password": "whatever1"}
    )

    assert response.status_code == 200
    assert response.cookies.get("session") == "fake-jwt"
    # El login NUNCA debe consultar invitaciones.
    fake_auth_service.create_user.assert_not_called()


def test_google_callback_without_invitation_redirects_to_login_without_cookie(client, monkeypatch):
    """[MODIFIED: Google sin invitación es rechazado] a nivel API — el rechazo
    debe ser un 302 a /login?error=google_no_invitation, NUNCA un 500 ni un
    JSON: el usuario está en medio de un redirect flow del browser.

    Un `Depends()` que explotara fuera del try convertiría esto en un 500
    (lección documentada del proyecto) — este test es el que lo detectaría."""
    app.state.google_oauth_enabled = True
    fake_auth_service = MagicMock()
    fake_auth_service.resolve_or_create_google_user = AsyncMock(
        side_effect=InvitationRequiredError("sin-invitacion@example.com")
    )
    app.state.auth_service = fake_auth_service
    monkeypatch.setattr(
        oauth,
        "google",
        _fake_google_client(
            userinfo={
                "sub": "google-sub-sin-invitacion",
                "email": "sin-invitacion@example.com",
                "email_verified": True,
            }
        ),
        raising=False,
    )

    response = client.get(
        "/auth/google/callback",
        params={"code": "some-code", "state": "some-state"},
        follow_redirects=False,
    )

    assert response.status_code == 302
    assert "/login?error=google_no_invitation" in response.headers["location"]
    assert response.cookies.get("session") is None


def test_google_callback_of_already_linked_user_still_works(client, monkeypatch):
    """[Scenario: No-lockout (2)] a nivel API — un usuario ya vinculado entra
    por Google exactamente igual que antes del change: 302 con cookie."""
    app.state.google_oauth_enabled = True
    resolved = UserPublic(
        id="3f9a2b1c-1111-2222-3333-4444555566ee",
        email="vinculado@example.com",
        role=UserRole.ADMIN,
    )
    app.state.auth_service = _fake_auth_service_for_callback(resolved)
    monkeypatch.setattr(
        oauth,
        "google",
        _fake_google_client(
            userinfo={
                "sub": "google-sub-vinculado",
                "email": "vinculado@example.com",
                "email_verified": True,
            }
        ),
        raising=False,
    )

    response = client.get(
        "/auth/google/callback",
        params={"code": "some-code", "state": "some-state"},
        follow_redirects=False,
    )

    assert response.status_code == 302
    assert response.cookies.get("session") == "fake-google-jwt"


# --- Onboarding (Decision 6) -------------------------------------------------


def test_me_includes_onboarding_completed_at_read_from_the_database(client):
    """[Scenario: Usuario nuevo tiene onboarding pendiente] — el campo viaja en
    /auth/me y sale de la BASE (get_onboarding_status), no del JWT: un dato
    mutable no va en un token inmutable (Decision 6). El fake del payload del
    JWT no trae el campo justamente para probar que no se lee de ahí."""
    user_id = "3f9a2b1c-1111-2222-3333-4444555566ff"
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": user_id, "email": "g@example.com", "role": "viewer"}
    )
    fake_auth_service.decode_access_token = MagicMock(return_value=_current_user_for(user_id))
    fake_auth_service.get_onboarding_status = AsyncMock(return_value=None)
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    response = client.get("/auth/me")

    assert response.status_code == 200
    assert response.json()["onboarding_completed_at"] is None
    fake_auth_service.get_onboarding_status.assert_awaited_once_with(UUID(user_id))


def test_me_of_a_user_that_already_completed_onboarding_returns_the_timestamp(client):
    """El usuario que ya completó el wizard NO debe volver a verlo: el campo
    llega con timestamp y el frontend no monta el gate."""
    user_id = "3f9a2b1c-1111-2222-3333-44445555670a"
    completed_at = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": user_id, "email": "g@example.com", "role": "viewer"}
    )
    fake_auth_service.decode_access_token = MagicMock(return_value=_current_user_for(user_id))
    fake_auth_service.get_onboarding_status = AsyncMock(return_value=completed_at)
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    response = client.get("/auth/me")

    assert response.status_code == 200
    assert response.json()["onboarding_completed_at"] is not None


def test_onboarding_complete_returns_204_and_is_idempotent(client):
    """[Scenario: Completar onboarding persiste y es idempotente] a nivel API:
    dos llamadas seguidas responden 204 (la idempotencia real, "no pisa el
    timestamp", está verificada contra la base en test_auth_service.py)."""
    user_id = "3f9a2b1c-1111-2222-3333-44445555670b"
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": user_id, "email": "g@example.com", "role": "viewer"}
    )
    fake_auth_service.decode_access_token = MagicMock(return_value=_current_user_for(user_id))
    fake_auth_service.complete_onboarding = AsyncMock(return_value=None)
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    first = client.post("/auth/me/onboarding-complete")
    second = client.post("/auth/me/onboarding-complete")

    assert first.status_code == 204
    assert second.status_code == 204
    assert fake_auth_service.complete_onboarding.await_count == 2


def test_onboarding_complete_without_session_returns_401(client):
    """[Scenario: Sin sesión no se puede marcar onboarding]."""
    app.state.auth_service = MagicMock()
    client.cookies.clear()

    response = client.post("/auth/me/onboarding-complete")

    assert response.status_code == 401


def test_onboarding_complete_is_allowed_for_any_role_including_viewer(client):
    """Sin restricción de rol: cada usuario completa SU onboarding (el
    endpoint usa get_current_user, no require_min_role)."""
    user_id = "3f9a2b1c-1111-2222-3333-44445555670c"
    fake_auth_service = MagicMock()
    fake_auth_service.decode_token_payload = MagicMock(
        return_value={"sub": user_id, "email": "g@example.com", "role": "viewer"}
    )
    fake_auth_service.decode_access_token = MagicMock(return_value=_current_user_for(user_id))
    fake_auth_service.complete_onboarding = AsyncMock(return_value=None)
    app.state.auth_service = fake_auth_service

    client.cookies.set("session", "fake-session-jwt")
    response = client.post("/auth/me/onboarding-complete")

    assert response.status_code == 204
    # Marca SU propio onboarding, el del `sub` de su sesión.
    fake_auth_service.complete_onboarding.assert_awaited_once_with(UUID(user_id))
