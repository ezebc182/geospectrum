"""Hilo de conversación por ventana analizada, contra Postgres REAL.

Mismo patrón híbrido que test_picks_api.py: servicio real contra el
testcontainer (fixture `_migrated`, que aplica la 017 por glob), auth mockeada
solo en el round-trip de sesión, `TestClient(app)` sin `with` y app.state a
mano. Las lecturas de control van por una conexión psycopg2 NUEVA.

La diferencia de contrato con los picks: los comentarios son COLABORATIVOS —
todos los usuarios leen todos los hilos (decisión 2026-08-26); el ownership
aplica solo al DELETE.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import asyncpg
import psycopg2
import pytest
from fastapi.testclient import TestClient

from src.main import app
from src.models.user import CurrentUser, UserRole
from src.services.auth_service import UserAuthState
from src.services.window_comments import WindowCommentService

CHANNEL = "AK.FIRE..BHZ"
BASE = f"/stations/{CHANNEL}/comments"

W_START = "2026-08-24T12:00:00Z"
W_END = "2026-08-24T12:10:00Z"


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_app_state():
    yield
    for key in ("auth_service", "window_comment_service"):
        if hasattr(app.state, key):
            del app.state._state[key]
    app.dependency_overrides.clear()


class _LazyPool:
    """Proxy de asyncpg.Pool creado en el PRIMER uso (ver test_picks_api.py)."""

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


def _insert_user(dsn: str, email: str) -> CurrentUser:
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (email, password_hash, role) VALUES (%s, %s, %s) "
                "RETURNING id, email, role",
                (email, "$2b$12$hash-irrelevante", UserRole.VIEWER.value),
            )
            row = cur.fetchone()
            return CurrentUser(id=row[0], email=row[1], role=UserRole(row[2]))
    finally:
        conn.close()


@pytest.fixture
def two_users(_migrated):
    user_a = _insert_user(_migrated, "comment-a@example.com")
    user_b = _insert_user(_migrated, "comment-b@example.com")

    app.state.window_comment_service = WindowCommentService(_LazyPool(_migrated))
    yield user_a, user_b, _migrated

    conn = psycopg2.connect(_migrated)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM window_comments")
            cur.execute("DELETE FROM users")
    finally:
        conn.close()


def _auth_service_mock() -> MagicMock:
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


def _post_comment(client: TestClient, body: str, start: str = W_START, end: str = W_END):
    return client.post(BASE, json={"body": body, "window_start": start, "window_end": end})


def _listar(client: TestClient, start: str = W_START, end: str = W_END):
    return client.get(f"{BASE}?start={start}&end={end}")


PROTECTED = [
    ("GET", f"{BASE}?start={W_START}&end={W_END}", None),
    ("POST", BASE, {"body": "hola", "window_start": W_START, "window_end": W_END}),
    ("DELETE", f"{BASE}/00000000-0000-0000-0000-000000000000", None),
]


@pytest.mark.parametrize("method,path,body", PROTECTED)
def test_sin_sesion_todo_da_401(client, two_users, method, path, body):
    # Auth service presente pero SIN cookie de sesión: el 401 sale del
    # get_current_user, no de un state a medio armar.
    app.state.auth_service = _auth_service_mock()
    resp = client.request(method, path, json=body)
    assert resp.status_code == 401


def test_crear_y_leer_persiste_en_la_base(client, two_users):
    user_a, _, dsn = two_users
    _login_as(user_a, client)

    resp = _post_comment(client, "MIRAR ESTO: el pico de las 12:03")
    assert resp.status_code == 201, resp.text
    created = resp.json()
    assert created["body"] == "MIRAR ESTO: el pico de las 12:03"
    assert created["author_email"] == "comment-a@example.com"

    # Lectura de control por una conexión NUEVA, directa a la base.
    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT body FROM window_comments WHERE channel = %s", (CHANNEL,))
            assert cur.fetchone()[0] == "MIRAR ESTO: el pico de las 12:03"
    finally:
        conn.close()


def test_los_comentarios_son_colaborativos_y_en_orden_de_llegada(client, two_users):
    """La diferencia clave con los picks: B VE lo que escribió A. El hilo es
    una conversación de equipo, no notas privadas."""
    user_a, user_b, _ = two_users
    _login_as(user_a, client)
    _post_comment(client, "primero")
    _login_as(user_b, client)
    _post_comment(client, "segundo")

    resp = _listar(client)
    assert resp.status_code == 200
    comments = resp.json()["comments"]
    assert [c["body"] for c in comments] == ["primero", "segundo"]
    assert [c["author_email"] for c in comments] == [
        "comment-a@example.com",
        "comment-b@example.com",
    ]


def test_la_ventana_filtra_por_solapamiento_no_por_igualdad_exacta(client, two_users):
    """Un zoom corre la ventana unos segundos: exigir igualdad exacta haría
    desaparecer el hilo con cada ajuste. Solapa ⇒ se ve; disjunta ⇒ no."""
    user_a, _, _ = two_users
    _login_as(user_a, client)
    _post_comment(client, "sobre las 12:00-12:10")

    solapada = _listar(client, "2026-08-24T12:05:00Z", "2026-08-24T12:15:00Z")
    assert [c["body"] for c in solapada.json()["comments"]] == ["sobre las 12:00-12:10"]

    disjunta = _listar(client, "2026-08-24T13:00:00Z", "2026-08-24T13:10:00Z")
    assert disjunta.json()["comments"] == []


def test_borrar_solo_lo_propio(client, two_users):
    user_a, user_b, dsn = two_users
    _login_as(user_a, client)
    comment_id = _post_comment(client, "para borrar").json()["id"]

    # B no puede borrar lo de A: 404 idéntico al de un id inexistente.
    _login_as(user_b, client)
    assert client.delete(f"{BASE}/{comment_id}").status_code == 404

    _login_as(user_a, client)
    assert client.delete(f"{BASE}/{comment_id}").status_code == 204

    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM window_comments")
            assert cur.fetchone()[0] == 0
    finally:
        conn.close()


def test_body_vacio_o_gigante_da_422(client, two_users):
    user_a, _, _ = two_users
    _login_as(user_a, client)
    assert _post_comment(client, "").status_code == 422
    assert _post_comment(client, "x" * 501).status_code == 422


def test_ventana_degenerada_da_422(client, two_users):
    user_a, _, _ = two_users
    _login_as(user_a, client)
    resp = _post_comment(client, "hola", start=W_END, end=W_START)
    assert resp.status_code == 422
