"""Endpoints /walls por HTTP: auth, mapeo de errores y el muro global público.

La cobertura fina del CRUD vive en test_walls_service.py; acá se verifica la
capa HTTP: 401 sin sesión, códigos de error y serialización.

Mismo patrón híbrido que test_invitations_api.py: `WallService` es el REAL
contra Postgres real (fixture `_migrated`), `auth_service` se mockea solo en
`decode_access_token`/`get_user_auth_state`. `TestClient(app)` sin `with`
(lifespan no corre) y app.state seteado a mano.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import asyncpg
import pytest
from fastapi.testclient import TestClient

from src.main import app
from src.models.user import CurrentUser, UserRole
from src.services.auth_service import UserAuthState
from src.services.wall_service import WallService


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_app_state():
    """app es un singleton module-level: sin esto, el estado que mutó un test
    se filtra al siguiente (mismo fixture que test_invitations_api.py)."""
    yield
    for key in ("auth_service", "wall_service"):
        if hasattr(app.state, key):
            del app.state._state[key]
    app.dependency_overrides.clear()


class _LazyPool:
    """Proxy de asyncpg.Pool que se crea en el PRIMER uso, no en el fixture.

    Por qué existe: `TestClient` corre la app en SU PROPIO event loop (uno por
    request, vía portal de anyio), distinto del loop de pytest-asyncio donde
    vive el fixture `db_pool`. Un pool de asyncpg está atado al loop que lo
    creó; compartirlo entre ambos revienta con "another operation is in
    progress" / "connection was closed in the middle of operation" —
    verificado, no supuesto.

    La solución es que el pool que usa el servicio NAZCA dentro del loop del
    request. `acquire()` es el único método que WallService usa, y es donde se
    hace el lazy-init: para cuando se ejecuta, ya estamos en el loop correcto.
    Se guarda un pool por loop porque cada request de TestClient estrena uno.
    """

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pools: dict[int, asyncpg.Pool] = {}

    def acquire(self):
        loop = asyncio.get_event_loop()
        key = id(loop)

        class _AcquireCtx:
            def __init__(ctx_self, outer):
                ctx_self._outer = outer
                ctx_self._inner = None

            async def __aenter__(ctx_self):
                pool = ctx_self._outer._pools.get(key)
                if pool is None:
                    pool = await asyncpg.create_pool(ctx_self._outer._dsn, min_size=1, max_size=4)
                    ctx_self._outer._pools[key] = pool
                ctx_self._inner = pool.acquire()
                return await ctx_self._inner.__aenter__()

            async def __aexit__(ctx_self, *exc):
                return await ctx_self._inner.__aexit__(*exc)

        return _AcquireCtx(self)

    async def aclose_all(self) -> None:
        for pool in self._pools.values():
            await pool.close()
        self._pools.clear()


@pytest.fixture
def viewer_user(_migrated):
    """Un user real (vía psycopg2, síncrono) + el WallService real publicado
    en app.state sobre un `_LazyPool`.

    Síncrono a propósito: sembrar con psycopg2 evita mezclar el loop de
    pytest-asyncio con el de TestClient (ver docstring de _LazyPool).
    """
    import psycopg2

    conn = psycopg2.connect(_migrated)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (email, password_hash, role) VALUES (%s, %s, %s) "
                "RETURNING id, email, role",
                ("viewer@example.com", "$2b$12$hash-irrelevante", UserRole.VIEWER.value),
            )
            row = cur.fetchone()
            user = CurrentUser(id=row[0], email=row[1], role=UserRole(row[2]))
    finally:
        conn.close()

    lazy_pool = _LazyPool(_migrated)
    app.state.wall_service = WallService(lazy_pool)
    yield user

    conn = psycopg2.connect(_migrated)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM walls")
            cur.execute("DELETE FROM users")
    finally:
        conn.close()


def _auth_service_mock() -> MagicMock:
    """Fake de AuthService con el round-trip de `get_current_user()` awaitable
    (mismo patrón que test_invitations_api.py)."""
    fake = MagicMock()
    fake.is_user_active = AsyncMock(return_value=True)

    async def _auth_state(user_id) -> UserAuthState:
        decoded = fake.decode_access_token.return_value
        role = decoded.role if isinstance(decoded, CurrentUser) else UserRole.VIEWER
        return UserAuthState(is_active=True, role=role)

    fake.get_user_auth_state = _auth_state
    return fake


def _login_as(user: CurrentUser, client: TestClient) -> None:
    fake_auth_service = _auth_service_mock()
    fake_auth_service.decode_access_token = MagicMock(return_value=user)
    app.state.auth_service = fake_auth_service
    client.cookies.set("session", "fake-session-jwt")


def _logout(client: TestClient) -> None:
    app.state.auth_service = _auth_service_mock()
    client.cookies.clear()


LAYOUT = {
    "columns": [
        {"groups": [{"title": "ASIA", "channels": [{"channel": "IU.MAJO.00.BHZ", "label": "Tokyo"}]}]}
    ],
    "showMetrics": False,
}

PROTECTED_ENDPOINTS = [
    ("GET", "/walls", None),
    ("POST", "/walls", {"name": "x", "layout": LAYOUT}),
    ("PUT", "/walls/00000000-0000-0000-0000-000000000000", {"name": "x", "layout": LAYOUT}),
    ("DELETE", "/walls/00000000-0000-0000-0000-000000000000", None),
]


@pytest.mark.parametrize("method,path,body", PROTECTED_ENDPOINTS)
def test_sin_sesion_todo_da_401(client, viewer_user, method, path, body):
    _logout(client)

    response = client.request(method, path, json=body)

    assert response.status_code == 401


def test_walls_global_es_publico(client):
    response = client.get("/walls/global")
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "global"
    assert body["layout"]["columns"]


def test_crud_feliz(client, viewer_user):
    _login_as(viewer_user, client)
    created = client.post("/walls", json={"name": "Mi muro", "layout": LAYOUT})
    assert created.status_code == 201
    wall_id = created.json()["id"]

    listed = client.get("/walls")
    assert [w["name"] for w in listed.json()] == ["Mi muro"]

    updated = client.put(f"/walls/{wall_id}", json={"name": "Renombrado", "layout": LAYOUT})
    assert updated.status_code == 200
    assert updated.json()["name"] == "Renombrado"

    deleted = client.delete(f"/walls/{wall_id}")
    assert deleted.status_code == 204
    assert client.get("/walls").json() == []


def test_nombre_duplicado_da_409(client, viewer_user):
    _login_as(viewer_user, client)
    assert client.post("/walls", json={"name": "Uno", "layout": LAYOUT}).status_code == 201
    assert client.post("/walls", json={"name": "Uno", "layout": LAYOUT}).status_code == 409


def test_layout_invalido_da_422(client, viewer_user):
    _login_as(viewer_user, client)
    bad = {"columns": [], "showMetrics": False}
    assert client.post("/walls", json={"name": "Roto", "layout": bad}).status_code == 422


def test_muro_inexistente_da_404(client, viewer_user):
    _login_as(viewer_user, client)
    ghost = "00000000-0000-0000-0000-000000000000"
    assert client.put(f"/walls/{ghost}", json={"name": "x", "layout": LAYOUT}).status_code == 404
    assert client.delete(f"/walls/{ghost}").status_code == 404
