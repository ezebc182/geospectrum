"""Endpoints /stations/{channel}/picks por HTTP contra Postgres REAL.

Mismo patrón híbrido que test_walls_api.py: `SignalPickService` es el REAL
contra el testcontainer (fixture `_migrated`, que ya aplica la 015),
`auth_service` se mockea solo en el round-trip de sesión. `TestClient(app)`
sin `with` (lifespan no corre) y app.state seteado a mano.

Los escenarios de ownership y persistencia vienen de la spec backend-api:
un test que solo verificara "se lee después de escribirlo en la misma sesión"
pasaría igual con localStorage y NO sirve — acá la lectura de control va por
una conexión psycopg2 NUEVA, directa a la base.
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
from src.services.signal_picks import SignalPickService

CHANNEL = "AK.FIRE..BHZ"
BASE = f"/stations/{CHANNEL}/picks"

# Instantes con valores derivados calculados a mano:
# S-P = 11.4 s ⇒ d = 11.4 * 8.219178 = 93.699 km
# coda - P = 92.6 s ⇒ Mc = 1.86*log10(92.6) - 0.85 = 2.808
P_TIME = "2026-08-23T14:03:12.400Z"
S_TIME = "2026-08-23T14:03:23.800Z"
CODA_TIME = "2026-08-23T14:04:45.000Z"


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_app_state():
    """app es un singleton module-level: sin esto, el estado que mutó un test
    se filtra al siguiente (mismo fixture que test_walls_api.py)."""
    yield
    for key in ("auth_service", "signal_pick_service"):
        if hasattr(app.state, key):
            del app.state._state[key]
    app.dependency_overrides.clear()


class _LazyPool:
    """Proxy de asyncpg.Pool creado en el PRIMER uso (ver test_walls_api.py:
    TestClient corre cada request en su propio event loop y un pool de asyncpg
    está atado al loop que lo creó)."""

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
    """Dos users reales + SignalPickService real en app.state, con limpieza."""
    user_a = _insert_user(_migrated, "picker-a@example.com")
    user_b = _insert_user(_migrated, "picker-b@example.com")

    app.state.signal_pick_service = SignalPickService(_LazyPool(_migrated))
    yield user_a, user_b, _migrated

    conn = psycopg2.connect(_migrated)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM signal_picks")
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


def _logout(client: TestClient) -> None:
    app.state.auth_service = _auth_service_mock()
    client.cookies.clear()


def _post_pick(client: TestClient, phase: str, pick_time: str, note: str | None = None):
    return client.post(BASE, json={"phase": phase, "pick_time": pick_time, "note": note})


PROTECTED_ENDPOINTS = [
    ("GET", BASE, None),
    ("POST", BASE, {"phase": "P", "pick_time": P_TIME, "note": None}),
    ("PUT", f"{BASE}/00000000-0000-0000-0000-000000000000",
     {"phase": "P", "pick_time": P_TIME, "note": None}),
    ("DELETE", f"{BASE}/00000000-0000-0000-0000-000000000000", None),
    ("GET", f"{BASE}/export.csv", None),
]


@pytest.mark.parametrize("method,path,body", PROTECTED_ENDPOINTS)
def test_sin_sesion_todo_da_401(client, two_users, method, path, body):
    _logout(client)

    response = client.request(method, path, json=body)

    assert response.status_code == 401


def test_pick_persiste_en_la_base_leido_por_conexion_nueva(client, two_users):
    """El escenario anti-localStorage: la lectura de control NO pasa por la
    API ni por la sesión que escribió — es una conexión nueva a Postgres."""
    user_a, _, dsn = two_users
    _login_as(user_a, client)

    created = _post_pick(client, "P", P_TIME, "primera llegada")
    assert created.status_code == 201, created.text
    pick_id = created.json()["id"]

    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT channel, phase, note, pick_time FROM signal_picks WHERE id = %s",
                (pick_id,),
            )
            row = cur.fetchone()
    finally:
        conn.close()

    assert row is not None, "el pick no está en la base: esto pasaría con localStorage"
    assert row[0] == CHANNEL
    assert row[1] == "P"
    assert row[2] == "primera llegada"
    # El instante guardado es el que se mandó, al milisegundo.
    assert row[3].isoformat().startswith("2026-08-23T14:03:12.400")


def test_doble_post_identico_deja_una_sola_fila(client, two_users):
    """El UNIQUE (user, channel, phase, pick_time) hace idempotente el doble clic."""
    user_a, _, dsn = two_users
    _login_as(user_a, client)

    first = _post_pick(client, "P", P_TIME)
    second = _post_pick(client, "P", P_TIME)
    assert first.status_code == 201
    assert second.status_code == 201

    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM signal_picks")
            assert cur.fetchone()[0] == 1
    finally:
        conn.close()
    assert first.json()["id"] == second.json()["id"]


def test_ownership_el_pick_de_a_es_invisible_e_intocable_para_b(client, two_users):
    user_a, user_b, dsn = two_users

    _login_as(user_a, client)
    pick_id = _post_pick(client, "P", P_TIME).json()["id"]

    _login_as(user_b, client)
    listed = client.get(BASE)
    assert listed.status_code == 200
    assert listed.json()["picks"] == []

    deleted = client.delete(f"{BASE}/{pick_id}")
    assert deleted.status_code == 404  # indistinguible de inexistente

    # El pick de A sigue existiendo: el intento de B no lo tocó.
    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM signal_picks WHERE id = %s", (pick_id,))
            assert cur.fetchone()[0] == 1
    finally:
        conn.close()


def test_borrar_el_usuario_borra_sus_picks_por_cascade(client, two_users):
    user_a, _, dsn = two_users
    _login_as(user_a, client)
    _post_pick(client, "P", P_TIME)

    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (str(user_a.id),))
            cur.execute("SELECT count(*) FROM signal_picks")
            assert cur.fetchone()[0] == 0
    finally:
        conn.close()


def test_get_devuelve_mediciones_derivadas(client, two_users):
    user_a, _, _ = two_users
    _login_as(user_a, client)
    _post_pick(client, "P", P_TIME)
    _post_pick(client, "S", S_TIME)
    _post_pick(client, "coda", CODA_TIME)

    body = client.get(BASE).json()

    assert len(body["picks"]) == 3
    m = body["measurements"]
    assert m["sp_seconds"] == pytest.approx(11.4, abs=1e-6)
    assert m["distance_km"] == pytest.approx(93.699, abs=0.001)
    assert m["coda_seconds"] == pytest.approx(92.6, abs=1e-6)
    assert m["coda_magnitude"] == pytest.approx(2.808, abs=0.001)


def test_crud_actualizar_y_borrar(client, two_users):
    user_a, _, _ = two_users
    _login_as(user_a, client)
    pick_id = _post_pick(client, "P", P_TIME, "inicial").json()["id"]

    updated = client.put(
        f"{BASE}/{pick_id}",
        json={"phase": "P", "pick_time": P_TIME, "note": "corregida"},
    )
    assert updated.status_code == 200
    assert updated.json()["note"] == "corregida"

    assert client.delete(f"{BASE}/{pick_id}").status_code == 204
    assert client.get(BASE).json()["picks"] == []
    # Borrar dos veces: 404, no 500.
    assert client.delete(f"{BASE}/{pick_id}").status_code == 404


def test_export_csv_trae_las_derivadas_del_service(client, two_users):
    """Las columnas derivadas salen del service (no vacías ni placeholders) y
    el archivo se parsea limpio con el propio módulo csv."""
    import csv as csv_module
    import io

    user_a, _, _ = two_users
    _login_as(user_a, client)
    _post_pick(client, "P", P_TIME)
    _post_pick(client, "S", S_TIME, "nota con, coma")
    _post_pick(client, "coda", CODA_TIME)

    response = client.get(f"{BASE}/export.csv")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "attachment" in response.headers["content-disposition"]

    rows = list(csv_module.reader(io.StringIO(response.text)))
    assert rows[0] == [
        "channel", "phase", "pick_time_utc", "note",
        "sp_seconds", "distance_km", "coda_seconds", "coda_magnitude",
    ]
    assert len(rows) == 4  # header + P + S + coda, sin corrupción de separadores

    by_phase = {row[1]: row for row in rows[1:]}
    # Filas P y S llevan S-P y distancia; la fila coda lleva duración y Mc.
    assert by_phase["P"][4] == "11.400"
    assert by_phase["P"][5] == "93.699"
    assert by_phase["S"][4] == "11.400"
    assert by_phase["S"][3] == "nota con, coma"  # la coma no rompió columnas
    assert by_phase["coda"][6] == "92.600"
    assert by_phase["coda"][7] == "2.808"
    assert by_phase["coda"][4] == ""  # la coda no lleva S-P
