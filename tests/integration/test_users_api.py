"""Tests de integración de la superficie /auth/users* y de los TRES bloqueos
de una cuenta desactivada (user-management, tarea 1.17).

Contrato verificado, código por código:
- La matriz completa de status de design.md § Interfaces / Contracts para los
  3 endpoints (401/403/404/409/200/204).
- El bloqueo del login por password: 403 SOLO con la password verificada, y el
  401 genérico indistinguible cuando la password es incorrecta (no-enumerante),
  incluyendo el caso 2FA (nunca `requires_2fa`, nunca cookie de pre-auth).
- La muerte de una sesión YA emitida en el request siguiente al deactivate.
- `/report` (endpoint público con `get_current_user_optional`) tratando al
  desactivado como anónimo, nunca 500.
- El callback de Google respondiendo `account_deactivated` sin Set-Cookie y
  SIN escribir la fila (el auto-link no ocurre).

Híbrido, mismo patrón que test_locale_api.py: el `auth_service` es el REAL
contra Postgres real (las queries de deactivate/list tienen que correr de
verdad — los mocks de asyncpg son ciegos al SQL), con SOLO
`decode_access_token`/`decode_token_payload` reemplazados en la instancia para
fabricar la sesión del rol que cada test necesita. `is_user_active` NO se
mockea nunca: es justamente lo que se está verificando.

`TestClient(app)` sin `with` (lifespan no corre) y app.state seteado a mano.
"""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import asyncpg
import pytest
from fastapi.responses import RedirectResponse
from fastapi.testclient import TestClient

from src.config.settings import settings
from src.main import app, oauth
from src.models.user import CurrentUser, UserRole
from src.services.auth_service import AuthService

PASSWORD = "Sismo2026!"

# Los endpoints de administración de cuentas, para las tandas parametrizadas
# de 401/403. El de rol se manda SIN body a propósito: la dependencia de
# autenticación/autorización se resuelve ANTES de validar el payload, así que
# el 401/403 tiene que salir igual — si alguna vez saliera 422, sería la señal
# de que el guard dejó de correr primero.
PROTECTED_ENDPOINTS = [
    ("get", "/auth/users"),
    ("post", f"/auth/users/{uuid4()}/deactivate"),
    ("post", f"/auth/users/{uuid4()}/reactivate"),
    ("post", f"/auth/users/{uuid4()}/role"),
]


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_app_state():
    """app es un singleton module-level: sin esto el estado que mutó un test
    se filtra al siguiente (mismo fixture que test_invitations_api.py)."""
    yield
    for key in ("auth_service", "db_pool", "google_oauth_enabled", "totp_login_attempt_limiter"):
        if hasattr(app.state, key):
            del app.state._state[key]
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def _default_totp_login_attempt_limiter():
    """Sin lifespan, `app.state.totp_login_attempt_limiter` nunca se puebla y
    cualquier POST /auth/login rompería al resolver su Depends. Fake
    permisivo, igual que en test_auth_api.py."""
    fake_limiter = MagicMock()
    fake_limiter.check_not_locked = AsyncMock(return_value=None)
    fake_limiter.register_failure = AsyncMock(return_value=1)
    fake_limiter.reset = AsyncMock(return_value=None)
    app.state.totp_login_attempt_limiter = fake_limiter
    yield fake_limiter


class _LazyPool:
    """Proxy de asyncpg.Pool creado en el PRIMER uso, dentro del loop del
    request de TestClient (docstring largo en test_invitations_api.py: un pool
    de asyncpg está atado al loop que lo creó y TestClient estrena uno por
    request)."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pools: dict[int, asyncpg.Pool] = {}

    async def _get_pool(self) -> asyncpg.Pool:
        key = id(asyncio.get_event_loop())
        pool = self._pools.get(key)
        if pool is None:
            pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=4)
            self._pools[key] = pool
        return pool

    async def fetchrow(self, query: str, *args):
        return await (await self._get_pool()).fetchrow(query, *args)

    async def fetch(self, query: str, *args):
        return await (await self._get_pool()).fetch(query, *args)

    def acquire(self):
        outer = self

        class _AcquireCtx:
            def __init__(ctx_self):
                ctx_self._inner = None

            async def __aenter__(ctx_self):
                pool = await outer._get_pool()
                ctx_self._inner = pool.acquire()
                return await ctx_self._inner.__aenter__()

            async def __aexit__(ctx_self, *exc):
                return await ctx_self._inner.__aexit__(*exc)

        return _AcquireCtx()


@pytest.fixture
def seeded(_migrated):
    """Un usuario REAL por rol (con password bcrypt de verdad, para poder
    ejercitar el login) + el AuthService REAL publicado en app.state.

    Síncrono con psycopg2 a propósito: sembrar con asyncpg mezclaría el loop
    de pytest-asyncio con el de TestClient (ver _LazyPool).
    """
    import psycopg2

    from src.services.auth_service import _pwd_context

    password_hash = _pwd_context.hash(PASSWORD)

    users = {}
    conn = psycopg2.connect(_migrated)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            for role in (
                UserRole.SUPERADMIN,
                UserRole.ADMIN,
                UserRole.MODERADOR,
                UserRole.VIEWER,
            ):
                cur.execute(
                    "INSERT INTO users (email, password_hash, role) VALUES (%s, %s, %s) "
                    "RETURNING id, email, role",
                    (f"{role.value}@example.com", password_hash, role.value),
                )
                row = cur.fetchone()
                users[role] = CurrentUser(id=row[0], email=row[1], role=UserRole(row[2]))
    finally:
        conn.close()

    lazy_pool = _LazyPool(_migrated)
    app.state.auth_service = AuthService(
        dsn=_migrated,
        secret_key="secreto-de-test",
        token_expire_minutes=30,
        pool=lazy_pool,  # type: ignore[arg-type]
    )
    app.state.db_pool = lazy_pool
    yield users

    conn = psycopg2.connect(_migrated)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM invitations")
            cur.execute("DELETE FROM areas_of_interest WHERE NOT is_system")
            cur.execute("DELETE FROM users")
    finally:
        conn.close()


def _login_as(user: CurrentUser, client: TestClient) -> None:
    """Sesión fabricada: la cookie es opaca y los fakes de decode deciden la
    identidad. El resto del AuthService sigue siendo el REAL — en particular
    `is_user_active()`, que es lo que estos tests verifican."""
    app.state.auth_service.decode_token_payload = MagicMock(
        return_value={"sub": str(user.id), "email": user.email, "role": user.role.value}
    )
    app.state.auth_service.decode_access_token = MagicMock(return_value=user)
    client.cookies.set("session", "fake-session-jwt")


def _logout(client: TestClient) -> None:
    client.cookies.clear()


def _fetch_user_column(dsn: str, user_id, column: str):
    """Lectura directa contra la base: un 204 no prueba que la columna se haya
    escrito. psycopg2 por el mismo motivo de loops que documenta _LazyPool."""
    import psycopg2

    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(f"SELECT {column} FROM users WHERE id = %s", (str(user_id),))
            row = cur.fetchone()
    finally:
        conn.close()
    return row[0] if row else None


def _set_user_column(dsn: str, user_id, column: str, value) -> None:
    import psycopg2

    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(f"UPDATE users SET {column} = %s WHERE id = %s", (value, str(user_id)))
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 401 / 403 — la superficie está gateada por require_min_role(ADMIN)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("method,path", PROTECTED_ENDPOINTS)
def test_users_endpoints_without_session_return_401(client, seeded, method, path):
    """[Scenario: Sin sesión no hay listado] — extendido a los 3 endpoints."""
    _logout(client)

    response = getattr(client, method)(path)

    assert response.status_code == 401


@pytest.mark.parametrize("role", [UserRole.VIEWER, UserRole.MODERADOR])
@pytest.mark.parametrize("method,path", PROTECTED_ENDPOINTS)
def test_users_endpoints_with_insufficient_role_return_403(client, seeded, role, method, path):
    """[Scenario: Un viewer no puede listar usuarios] + [Scenario: Un moderador
    no puede desactivar a nadie] — el 403 sale de require_min_role(ADMIN)."""
    _login_as(seeded[role], client)

    response = getattr(client, method)(path)

    assert response.status_code == 403


# ---------------------------------------------------------------------------
# GET /auth/users
# ---------------------------------------------------------------------------


def test_admin_lists_all_users_with_state_and_never_secrets(client, seeded, _migrated):
    """[Scenario: Un admin lista los usuarios] Todos los usuarios (incluidos
    superadmins y él mismo), con rol y `deactivated_at`, sin un solo secreto."""
    _set_user_column(_migrated, seeded[UserRole.VIEWER].id, "deactivated_at", "now()")
    _login_as(seeded[UserRole.ADMIN], client)

    response = client.get("/auth/users")

    assert response.status_code == 200
    body = response.json()
    by_email = {item["email"]: item for item in body}
    assert "superadmin@example.com" in by_email
    assert "admin@example.com" in by_email

    assert by_email["viewer@example.com"]["deactivated_at"] is not None
    assert by_email["admin@example.com"]["deactivated_at"] is None
    assert by_email["admin@example.com"]["role"] == "admin"

    for item in body:
        assert "password_hash" not in item
        assert "totp_secret" not in item
        assert "google_id" not in item
        assert item["has_password"] is True


# ---------------------------------------------------------------------------
# POST /auth/users/{id}/deactivate — matriz de status
# ---------------------------------------------------------------------------


def test_deactivate_returns_204_and_writes_the_timestamp(client, seeded, _migrated):
    """[Scenario: Desactivar una cuenta activa] El assert que importa es
    contra la BASE, no contra el 204."""
    target = seeded[UserRole.VIEWER]
    _login_as(seeded[UserRole.ADMIN], client)

    response = client.post(f"/auth/users/{target.id}/deactivate")

    assert response.status_code == 204
    assert _fetch_user_column(_migrated, target.id, "deactivated_at") is not None


def test_deactivate_unknown_user_returns_404(client, seeded):
    """[Scenario: Desactivar un usuario inexistente]"""
    _login_as(seeded[UserRole.ADMIN], client)

    response = client.post(f"/auth/users/{uuid4()}/deactivate")

    assert response.status_code == 404
    assert "error" in response.json()


def test_admin_deactivating_another_admin_returns_403(client, seeded, _migrated):
    """[Scenario: Un admin no puede desactivar a otro admin ni a un
    superadmin] — nivel IGUAL también está prohibido."""
    _login_as(seeded[UserRole.ADMIN], client)
    target = seeded[UserRole.SUPERADMIN]

    response = client.post(f"/auth/users/{target.id}/deactivate")

    assert response.status_code == 403
    assert _fetch_user_column(_migrated, target.id, "deactivated_at") is None


def test_superadmin_can_deactivate_an_admin(client, seeded, _migrated):
    """[Scenario: Un superadmin puede desactivar a un admin]"""
    _login_as(seeded[UserRole.SUPERADMIN], client)
    target = seeded[UserRole.ADMIN]

    response = client.post(f"/auth/users/{target.id}/deactivate")

    assert response.status_code == 204
    assert _fetch_user_column(_migrated, target.id, "deactivated_at") is not None


def test_deactivating_yourself_returns_409(client, seeded, _migrated):
    """[Scenario: Nadie puede desactivarse a sí mismo] Con un SUPERADMIN, el
    rol más alto: ningún guard de jerarquía lo frena y aun así no puede."""
    actor = seeded[UserRole.SUPERADMIN]
    _login_as(actor, client)

    response = client.post(f"/auth/users/{actor.id}/deactivate")

    assert response.status_code == 409
    assert _fetch_user_column(_migrated, actor.id, "deactivated_at") is None


def test_deactivating_twice_returns_409_without_touching_the_timestamp(client, seeded, _migrated):
    """[Scenario: Desactivar una cuenta ya desactivada es rechazado
    explícitamente] — el timestamp ORIGINAL no se pisa."""
    target = seeded[UserRole.VIEWER]
    _login_as(seeded[UserRole.ADMIN], client)
    assert client.post(f"/auth/users/{target.id}/deactivate").status_code == 204
    original = _fetch_user_column(_migrated, target.id, "deactivated_at")

    response = client.post(f"/auth/users/{target.id}/deactivate")

    assert response.status_code == 409
    assert _fetch_user_column(_migrated, target.id, "deactivated_at") == original


# ---------------------------------------------------------------------------
# POST /auth/users/{id}/reactivate — matriz de status
# ---------------------------------------------------------------------------


def test_reactivate_returns_204_and_clears_the_timestamp(client, seeded, _migrated):
    target = seeded[UserRole.VIEWER]
    _set_user_column(_migrated, target.id, "deactivated_at", "now()")
    _login_as(seeded[UserRole.ADMIN], client)

    response = client.post(f"/auth/users/{target.id}/reactivate")

    assert response.status_code == 204
    assert _fetch_user_column(_migrated, target.id, "deactivated_at") is None


def test_reactivating_an_active_account_returns_409(client, seeded):
    """[Scenario: Reactivar una cuenta activa]"""
    _login_as(seeded[UserRole.ADMIN], client)

    response = client.post(f"/auth/users/{seeded[UserRole.VIEWER].id}/reactivate")

    assert response.status_code == 409


def test_reactivate_unknown_user_returns_404(client, seeded):
    _login_as(seeded[UserRole.ADMIN], client)

    response = client.post(f"/auth/users/{uuid4()}/reactivate")

    assert response.status_code == 404


def test_reactivate_applies_the_hierarchy_guard_too(client, seeded, _migrated):
    """Reactivar no es una puerta trasera de la jerarquía."""
    target = seeded[UserRole.SUPERADMIN]
    _set_user_column(_migrated, target.id, "deactivated_at", "now()")
    _login_as(seeded[UserRole.ADMIN], client)

    response = client.post(f"/auth/users/{target.id}/reactivate")

    assert response.status_code == 403
    assert _fetch_user_column(_migrated, target.id, "deactivated_at") is not None


# ---------------------------------------------------------------------------
# POST /auth/users/{id}/role — matriz de status COMPLETA, por API directa
#
# (role-management, tareas 3.8 y 3.9) Todo por HTTP crudo, nunca "el botón
# estaba deshabilitado": el enforcement es server-side y se prueba sin la UI.
# El AuthService es el REAL contra Postgres real, igual que el resto del
# archivo — sólo se fabrica la identidad de la sesión.
# ---------------------------------------------------------------------------


def _change_role(client: TestClient, target_id, role: UserRole):
    return client.post(f"/auth/users/{target_id}/role", json={"role": role.value})


def test_admin_promotes_a_viewer_to_moderador(client, seeded, _migrated):
    """[Scenario: Un admin promueve a un viewer a moderador] El assert que
    importa es contra la BASE, no contra el 204."""
    target = seeded[UserRole.VIEWER]
    _login_as(seeded[UserRole.ADMIN], client)

    response = _change_role(client, target.id, UserRole.MODERADOR)

    assert response.status_code == 204
    assert response.content == b""
    assert _fetch_user_column(_migrated, target.id, "role") == "moderador"


def test_superadmin_demotes_an_admin_to_viewer(client, seeded, _migrated):
    """[Scenario: Un superadmin degrada a un admin a viewer]"""
    target = seeded[UserRole.ADMIN]
    _login_as(seeded[UserRole.SUPERADMIN], client)

    response = _change_role(client, target.id, UserRole.VIEWER)

    assert response.status_code == 204
    assert _fetch_user_column(_migrated, target.id, "role") == "viewer"


def test_changing_the_role_of_a_deactivated_account_keeps_it_deactivated(client, seeded, _migrated):
    """[Scenario: Cambiar el rol de una cuenta desactivada es válido] El rol
    cambia y `deactivated_at` conserva su timestamp original."""
    target = seeded[UserRole.VIEWER]
    _set_user_column(_migrated, target.id, "deactivated_at", "now()")
    original = _fetch_user_column(_migrated, target.id, "deactivated_at")
    _login_as(seeded[UserRole.ADMIN], client)

    response = _change_role(client, target.id, UserRole.MODERADOR)

    assert response.status_code == 204
    assert _fetch_user_column(_migrated, target.id, "role") == "moderador"
    assert _fetch_user_column(_migrated, target.id, "deactivated_at") == original


@pytest.mark.parametrize("requested", [UserRole.ADMIN, UserRole.SUPERADMIN])
def test_admin_cannot_assign_its_own_level_or_higher(client, seeded, _migrated, requested):
    """[Scenario: Un admin no puede promover a nadie a admin] +
    [Scenario: ... ni a superadmin] — guard 5, sobre el rol PEDIDO."""
    target = seeded[UserRole.VIEWER]
    _login_as(seeded[UserRole.ADMIN], client)

    response = _change_role(client, target.id, requested)

    assert response.status_code == 403
    assert _fetch_user_column(_migrated, target.id, "role") == "viewer"


def test_not_even_a_superadmin_creates_another_superadmin_by_this_door(client, seeded, _migrated):
    """[Scenario: Ni siquiera un superadmin puede crear otro superadmin por
    esta vía] Nivel IGUAL al propio: 403."""
    target = seeded[UserRole.VIEWER]
    _login_as(seeded[UserRole.SUPERADMIN], client)

    response = _change_role(client, target.id, UserRole.SUPERADMIN)

    assert response.status_code == 403
    assert _fetch_user_column(_migrated, target.id, "role") == "viewer"


def test_superadmin_can_assign_the_admin_role(client, seeded, _migrated):
    """[Scenario: Un superadmin sí puede asignar el rol admin]"""
    target = seeded[UserRole.VIEWER]
    _login_as(seeded[UserRole.SUPERADMIN], client)

    response = _change_role(client, target.id, UserRole.ADMIN)

    assert response.status_code == 204
    assert _fetch_user_column(_migrated, target.id, "role") == "admin"


def _insert_user(dsn: str, email: str, role: UserRole):
    """Fila extra fuera del `seeded` (que tiene UNA por rol), para los casos
    que necesitan DOS usuarios del mismo rol."""
    import psycopg2

    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (email, role) VALUES (%s, %s) RETURNING id",
                (email, role.value),
            )
            return cur.fetchone()[0]
    finally:
        conn.close()


@pytest.mark.parametrize("actor_role", [UserRole.ADMIN, UserRole.SUPERADMIN])
def test_nobody_changes_the_role_of_a_superadmin(client, seeded, _migrated, actor_role):
    """[Scenario: Un admin tampoco puede tocar a un superadmin] +
    [Scenario: Un superadmin no puede degradar a otro superadmin].

    El objetivo es un superadmin DISTINTO del actor a propósito: apuntar al
    propio devolvería 409 por el guard de self y no probaría nada sobre la
    intocabilidad del rol.
    """
    target_id = _insert_user(_migrated, "otro-superadmin@example.com", UserRole.SUPERADMIN)
    _login_as(seeded[actor_role], client)

    response = _change_role(client, target_id, UserRole.VIEWER)

    assert response.status_code == 403
    assert _fetch_user_column(_migrated, target_id, "role") == "superadmin"


def test_admin_cannot_change_the_role_of_another_admin(client, seeded, _migrated):
    """[Scenario: Un admin no puede cambiarle el rol a otro admin] Guard 3,
    sobre el rol ACTUAL del objetivo: nivel IGUAL también está prohibido."""
    other_admin_id = _insert_user(_migrated, "otro-admin@example.com", UserRole.ADMIN)
    _login_as(seeded[UserRole.ADMIN], client)

    response = _change_role(client, other_admin_id, UserRole.VIEWER)

    assert response.status_code == 403
    assert _fetch_user_column(_migrated, other_admin_id, "role") == "admin"


def test_changing_your_own_role_returns_409(client, seeded, _migrated):
    """[Scenario: Nadie puede cambiarse el rol a sí mismo] Con un SUPERADMIN,
    el rol más alto: ningún guard de jerarquía lo frena y aun así no puede."""
    actor = seeded[UserRole.SUPERADMIN]
    _login_as(actor, client)

    response = _change_role(client, actor.id, UserRole.VIEWER)

    assert response.status_code == 409
    assert _fetch_user_column(_migrated, actor.id, "role") == "superadmin"


def test_self_guard_wins_over_the_requested_role_guard(client, seeded, _migrated):
    """[Scenario: El orden de los guards no se altera] Un admin pidiendo
    `superadmin` para sí mismo viola self (409) y rol-pedido (403) a la vez:
    gana el self."""
    actor = seeded[UserRole.ADMIN]
    _login_as(actor, client)

    response = _change_role(client, actor.id, UserRole.SUPERADMIN)

    assert response.status_code == 409
    assert _fetch_user_column(_migrated, actor.id, "role") == "admin"


def test_assigning_the_role_the_user_already_has_returns_409(client, seeded, _migrated):
    """[Scenario: Asignar el rol actual responde 409] No-op explícito, no un
    204 engañoso."""
    target = seeded[UserRole.MODERADOR]
    _login_as(seeded[UserRole.ADMIN], client)

    response = _change_role(client, target.id, UserRole.MODERADOR)

    assert response.status_code == 409
    assert _fetch_user_column(_migrated, target.id, "role") == "moderador"


def test_change_role_of_an_unknown_user_returns_404(client, seeded):
    """[Scenario: Usuario inexistente]"""
    _login_as(seeded[UserRole.ADMIN], client)

    response = _change_role(client, uuid4(), UserRole.VIEWER)

    assert response.status_code == 404


def test_not_found_wins_over_the_requested_role_guard(client, seeded):
    """El guard del rol pedido NO se evalúa antes de ir a la base: un target
    inexistente con un rol pedido inválido por jerarquía sale 404, no 403. La
    diferencia entre uno y otro no puede volverse un oráculo de existencia."""
    _login_as(seeded[UserRole.ADMIN], client)

    response = _change_role(client, uuid4(), UserRole.SUPERADMIN)

    assert response.status_code == 404


def test_an_invented_role_is_rejected_with_422(client, seeded, _migrated):
    """[Scenario: Un rol inexistente se rechaza con 422] Lo rechaza Pydantic
    contra el enum, antes de llegar al servicio: no es un guard de dominio."""
    target = seeded[UserRole.VIEWER]
    _login_as(seeded[UserRole.ADMIN], client)

    response = client.post(f"/auth/users/{target.id}/role", json={"role": "root"})

    assert response.status_code == 422
    assert _fetch_user_column(_migrated, target.id, "role") == "viewer"


# ---------------------------------------------------------------------------
# Bodies LITERALES (tarea 3.9) — el frontend discrimina los 409 por el TEXTO
# ---------------------------------------------------------------------------


def test_the_self_conflict_body_contains_the_marker_the_frontend_matches(client, seeded):
    """EL test de contrato del change. `UsersPanel.tsx` distingue el 409 de
    auto-gestión del de no-op con `err.message.includes('own account')`, así
    que el TEXTO del body es contrato de facto.

    El design proponía "cannot change your own role", que NO contiene esa
    subcadena y habría caído en la clave i18n equivocada ('conflict' en vez de
    'self') sin romper un solo test. Este assert es el que hace ruido en el
    backend si alguien reescribe el mensaje.
    """
    actor = seeded[UserRole.SUPERADMIN]
    _login_as(actor, client)

    response = _change_role(client, actor.id, UserRole.VIEWER)

    assert response.status_code == 409
    assert response.json() == {"error": "cannot change your own account role"}
    assert "own account" in response.json()["error"]


def test_the_noop_conflict_body_does_not_contain_the_self_marker(client, seeded):
    """El otro 409 tiene que caer del lado contrario del mismo match: si
    contuviera "own account", el frontend mostraría el copy de auto-gestión
    para un conflicto que no lo es."""
    target = seeded[UserRole.MODERADOR]
    _login_as(seeded[UserRole.ADMIN], client)

    response = _change_role(client, target.id, UserRole.MODERADOR)

    assert response.status_code == 409
    assert response.json() == {"error": "user already has that role"}
    assert "own account" not in response.json()["error"]


def test_the_not_found_body_is_literal(client, seeded):
    _login_as(seeded[UserRole.ADMIN], client)

    response = _change_role(client, uuid4(), UserRole.VIEWER)

    assert response.status_code == 404
    assert response.json() == {"error": "user not found"}


def test_the_hierarchy_body_is_literal(client, seeded, _migrated):
    """Guard 3 (rol ACTUAL del objetivo) — el mismo texto que ya usan
    deactivate/reactivate, porque es la misma regla."""
    other_admin_id = _insert_user(_migrated, "admin-body@example.com", UserRole.ADMIN)
    _login_as(seeded[UserRole.ADMIN], client)

    response = _change_role(client, other_admin_id, UserRole.VIEWER)

    assert response.status_code == 403
    assert response.json() == {"error": "cannot manage a user with an equal or higher role"}


def test_the_superadmin_body_is_literal(client, seeded):
    """El body del guard dedicado nombra la causa REAL ("a un superadmin no se
    le cambia el rol"), no "tu jerarquía no alcanza"."""
    _login_as(seeded[UserRole.ADMIN], client)

    response = _change_role(client, seeded[UserRole.SUPERADMIN].id, UserRole.VIEWER)

    assert response.status_code == 403
    # OJO: hoy el que dispara para un actor admin es el guard 3 (jerarquía),
    # que corre ANTES del dedicado — el body es el de jerarquía. El body del
    # guard dedicado se verifica en el test unitario, que es donde se puede
    # llegar a él (ver test_the_superadmin_rejection_comes_from_the_dedicated_guard).
    assert response.json() == {"error": "cannot manage a user with an equal or higher role"}


def test_the_assign_higher_role_body_is_literal(client, seeded):
    """Guard 5, el que NO existía antes de este change: el body tiene que
    distinguirse del de jerarquía-sobre-el-objetivo, porque son reglas
    distintas (a quién tocás vs. en qué lo convertís)."""
    _login_as(seeded[UserRole.ADMIN], client)

    response = _change_role(client, seeded[UserRole.VIEWER].id, UserRole.ADMIN)

    assert response.status_code == 403
    assert response.json() == {"error": "cannot assign a role equal to or higher than your own"}


# ---------------------------------------------------------------------------
# Bloqueo 1 — POST /auth/login (password), NO enumerante
# ---------------------------------------------------------------------------


def test_login_with_correct_password_of_a_deactivated_account_returns_403(
    client, seeded, _migrated
):
    """[Scenario: Login con password correcta de cuenta desactivada] 403
    explícito y CERO cookies: ni `session` ni `pending_2fa_session`."""
    target = seeded[UserRole.VIEWER]
    _set_user_column(_migrated, target.id, "deactivated_at", "now()")
    _logout(client)

    response = client.post("/auth/login", json={"email": target.email, "password": PASSWORD})

    assert response.status_code == 403
    assert response.json() == {"error": "account deactivated"}
    assert response.cookies.get("session") is None
    assert response.cookies.get("pending_2fa_session") is None


def test_login_with_wrong_password_of_a_deactivated_account_does_not_leak_state(
    client, seeded, _migrated
):
    """[Scenario: Login con password incorrecta de cuenta desactivada no filtra
    estado] La respuesta debe ser indistinguible de la de un email
    INEXISTENTE — se comparan las dos, no se afirma solo el 401."""
    target = seeded[UserRole.VIEWER]
    _set_user_column(_migrated, target.id, "deactivated_at", "now()")
    _logout(client)

    deactivated = client.post(
        "/auth/login", json={"email": target.email, "password": "password-incorrecta"}
    )
    unknown = client.post(
        "/auth/login", json={"email": "no-existe@example.com", "password": "password-incorrecta"}
    )

    assert deactivated.status_code == unknown.status_code == 401
    assert deactivated.json() == unknown.json() == {"error": "invalid credentials"}
    assert deactivated.content == unknown.content


def test_deactivated_account_with_2fa_never_receives_the_pre_auth_cookie(client, seeded, _migrated):
    """[Scenario: Cuenta desactivada con 2FA habilitado tampoco recibe
    pre-auth] El guard corre ANTES de la rama de 2FA: nunca
    {"requires_2fa": true}, nunca cookie de pre-auth."""
    target = seeded[UserRole.VIEWER]
    _set_user_column(_migrated, target.id, "totp_enabled", True)
    _set_user_column(_migrated, target.id, "deactivated_at", "now()")
    _logout(client)

    response = client.post("/auth/login", json={"email": target.email, "password": PASSWORD})

    assert response.status_code == 403
    assert response.json() == {"error": "account deactivated"}
    assert "requires_2fa" not in response.text
    assert response.cookies.get("pending_2fa_session") is None


def test_login_of_an_active_account_is_unchanged(client, seeded):
    """[Scenario: Login de usuario activo no cambia] No-regresión explícita:
    el guard nuevo no debe tocar el camino feliz."""
    _logout(client)

    response = client.post(
        "/auth/login",
        json={"email": seeded[UserRole.VIEWER].email, "password": PASSWORD},
    )

    assert response.status_code == 200
    assert response.cookies.get("session") is not None


def test_reactivating_restores_the_password_login(client, seeded, _migrated):
    """[Scenario: Reactivar restaura el login] Ciclo completo por HTTP:
    desactivar -> login bloqueado -> reactivar -> login OK."""
    target = seeded[UserRole.VIEWER]
    _login_as(seeded[UserRole.ADMIN], client)
    assert client.post(f"/auth/users/{target.id}/deactivate").status_code == 204

    _logout(client)
    blocked = client.post("/auth/login", json={"email": target.email, "password": PASSWORD})
    assert blocked.status_code == 403

    _login_as(seeded[UserRole.ADMIN], client)
    assert client.post(f"/auth/users/{target.id}/reactivate").status_code == 204

    _logout(client)
    restored = client.post("/auth/login", json={"email": target.email, "password": PASSWORD})
    assert restored.status_code == 200
    assert restored.cookies.get("session") is not None


# ---------------------------------------------------------------------------
# Bloqueo 2 — sesiones YA emitidas mueren en el request SIGUIENTE
# ---------------------------------------------------------------------------


def test_a_live_session_dies_on_the_next_request_after_deactivation(client, seeded, _migrated):
    """[Scenario: Sesión viva muere al desactivar la cuenta] El JWT sigue
    siendo válido en firma y sin vencer: lo único que cambió es la fila. Es EL
    requisito del change — sin esto, la desactivación tardaría hasta 24 h."""
    victim = seeded[UserRole.VIEWER]
    _login_as(victim, client)
    assert client.get("/auth/me").status_code == 200

    _set_user_column(_migrated, victim.id, "deactivated_at", "now()")

    response = client.get("/auth/me")

    assert response.status_code == 401


def test_a_jwt_of_a_deleted_account_also_dies(client, seeded, _migrated):
    """[Scenario: JWT válido de una cuenta borrada también muere] Agujero
    preexistente que este chequeo cierra de regalo."""
    victim = seeded[UserRole.VIEWER]
    _login_as(victim, client)
    assert client.get("/auth/me").status_code == 200

    import psycopg2

    conn = psycopg2.connect(_migrated)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (str(victim.id),))
    finally:
        conn.close()

    assert client.get("/auth/me").status_code == 401


def test_a_deactivated_admin_can_no_longer_manage_users(client, seeded, _migrated):
    """El admin desactivado pierde la superficie de administración en el acto:
    no puede desactivar a nadie más. Cierra la ventana descripta en el Risk
    #3 del proposal."""
    rogue = seeded[UserRole.ADMIN]
    _login_as(rogue, client)
    _set_user_column(_migrated, rogue.id, "deactivated_at", "now()")

    response = client.post(f"/auth/users/{seeded[UserRole.VIEWER].id}/deactivate")

    assert response.status_code == 401
    assert _fetch_user_column(_migrated, seeded[UserRole.VIEWER].id, "deactivated_at") is None


def test_demotion_in_the_database_is_effective_without_relogin(client, seeded, _migrated):
    """[role-management, design.md Decision 2] El JWT sigue diciendo `admin`:
    firma válida, sin vencer, la MISMA cookie del request anterior. Lo único
    que cambió es la columna `role` de la fila.

    Este test es el que muere si `get_current_user()` vuelve a confiar en el
    claim del token (`return current_user` en vez de la sobrescritura con el
    rol de la base). Los fakes de test_auth_api.py y test_invitations_api.py
    ESPEJAN el rol desde `decode_access_token`, así que allá token y base no
    pueden discrepar y la sobrescritura es un no-op indetectable: acá el
    AuthService es el REAL contra Postgres real y la divergencia es explícita.
    """
    actor = seeded[UserRole.ADMIN]
    _login_as(actor, client)
    assert client.get("/auth/users").status_code == 200

    _set_user_column(_migrated, actor.id, "role", UserRole.VIEWER.value)

    response = client.get("/auth/users")

    # 403 de require_min_role(ADMIN), que devuelve `detail` crudo — no pasa por
    # el envelope {"error": ...} de los handlers de /auth/users*.
    assert response.status_code == 403
    assert response.json() == {"detail": "insufficient role"}


def test_promotion_in_the_database_is_effective_without_relogin(client, seeded, _migrated):
    """Imagen especular del anterior: el token dice `viewer` y la base dice
    `admin` ⇒ 200, no 401.

    Mata la variante "comparar el claim contra la base y rechazar cuando
    difieren", que a nivel unitario también haría pasar al test de degradación
    pero convertiría toda PROMOCIÓN en un deslogueo. La sobrescritura tiene que
    andar en las DOS direcciones y sin re-login.
    """
    actor = seeded[UserRole.VIEWER]
    _login_as(actor, client)
    assert client.get("/auth/users").status_code == 403

    _set_user_column(_migrated, actor.id, "role", UserRole.ADMIN.value)

    response = client.get("/auth/users")

    assert response.status_code == 200
    by_email = {item["email"]: item for item in response.json()}
    assert by_email[actor.email]["role"] == "admin"


def test_report_treats_a_deactivated_user_as_anonymous(client, seeded, _migrated):
    """[Scenario: Endpoint público con personalización trata al desactivado
    como anónimo] `/report` usa get_current_user_optional, que hereda el
    bloqueo por delegación: 200 anónimo, NUNCA 500 (el bug histórico del
    Depends resuelto antes del try)."""
    victim = seeded[UserRole.VIEWER]
    _login_as(victim, client)
    _set_user_column(_migrated, victim.id, "deactivated_at", "now()")

    response = client.get("/report")

    assert response.status_code == 200


# ---------------------------------------------------------------------------
# Bloqueo 3 — GET /auth/google/callback
# ---------------------------------------------------------------------------


def _fake_google_client(userinfo: dict):
    """Reemplazo de `oauth.google` (RemoteApp de Authlib) — nunca pega a Google
    real. Mismo patrón que test_auth_api.py."""
    fake = SimpleNamespace()
    fake.authorize_redirect = AsyncMock(
        return_value=RedirectResponse(
            url="https://accounts.google.com/o/oauth2/v2/auth", status_code=302
        )
    )
    fake.authorize_access_token = AsyncMock(return_value={"userinfo": userinfo})
    return fake


def test_google_callback_of_a_deactivated_linked_account_redirects_without_cookie(
    client, seeded, _migrated, monkeypatch
):
    """[Scenario: Google login de cuenta desactivada] 302 al login con
    `account_deactivated`, sin Set-Cookie y sin tocar la fila."""
    victim = seeded[UserRole.VIEWER]
    _set_user_column(_migrated, victim.id, "google_id", "google-sub-victima")
    _set_user_column(_migrated, victim.id, "deactivated_at", "now()")
    app.state.google_oauth_enabled = True
    monkeypatch.setattr(
        oauth,
        "google",
        _fake_google_client(
            {
                "sub": "google-sub-victima",
                "email": victim.email,
                "email_verified": True,
                "name": "Nombre Nuevo",
                "picture": "https://example.com/nuevo.png",
            }
        ),
        raising=False,
    )
    _logout(client)

    response = client.get("/auth/google/callback?code=fake-code", follow_redirects=False)

    assert response.status_code == 302
    assert response.headers["location"] == (
        f"{settings.dashboard_url}/login?error=account_deactivated"
    )
    assert "set-cookie" not in {k.lower() for k in response.headers}
    # La fila NO se modificó: el guard corre ANTES del refresco de perfil.
    assert _fetch_user_column(_migrated, victim.id, "name") is None
    assert _fetch_user_column(_migrated, victim.id, "avatar_url") is None


def test_google_callback_does_not_auto_link_a_deactivated_account(
    client, seeded, _migrated, monkeypatch
):
    """[Scenario: Auto-link no se aplica a cuentas desactivadas] La cuenta es
    de password puro (google_id NULL) y está desactivada: tras el intento,
    `google_id` SIGUE en NULL."""
    victim = seeded[UserRole.VIEWER]
    _set_user_column(_migrated, victim.id, "deactivated_at", "now()")
    app.state.google_oauth_enabled = True
    monkeypatch.setattr(
        oauth,
        "google",
        _fake_google_client(
            {
                "sub": "google-sub-nuevo",
                "email": victim.email,
                "email_verified": True,
            }
        ),
        raising=False,
    )
    _logout(client)

    response = client.get("/auth/google/callback?code=fake-code", follow_redirects=False)

    assert response.status_code == 302
    assert "error=account_deactivated" in response.headers["location"]
    assert _fetch_user_column(_migrated, victim.id, "google_id") is None
