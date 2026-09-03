"""API de feedback de beta (tablero Kanban), contra Postgres REAL.

Molde `test_window_comments_api.py`: servicio real contra el testcontainer
(fixture `_migrated`, que aplica la 019 por glob), auth mockeada solo en el
round-trip de sesión, `TestClient(app)` SIN `with` (el `with` dispara el
lifespan real y choca con otros archivos por "Event loop is closed") y
`app.state` a mano. Toda lectura de control va por una conexión psycopg2
NUEVA: "no se creó fila" y "el timestamp no cambió" se afirman con SELECT,
nunca con mocks.

Diferencia con el molde: `_insert_user` recibe el ROL, porque la matriz
401/403 se recorre con los cuatro roles reales (viewer, moderador, admin,
superadmin) y con una cuenta desactivada.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

import asyncpg
import psycopg2
import pytest
from fastapi.testclient import TestClient

from src.main import app
from src.models.user import CurrentUser, UserRole
from src.services.auth_service import UserAuthState
from src.services.feedback_service import FeedbackService

BASE = "/feedback"
MISSING_ID = "00000000-0000-0000-0000-000000000000"
ITEM_KEYS = {
    "id",
    "type",
    "body",
    "route",
    "url",
    "user_agent",
    "author_email",
    "created_at",
    "status",
    "status_changed_at",
    "admin_comment",
    "admin_comment_updated_at",
}


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_app_state():
    yield
    for key in ("auth_service", "feedback_service"):
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


# --- helpers de base ---------------------------------------------------------


def _connect(dsn: str):
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    return conn


def _insert_user(dsn: str, email: str, role: UserRole) -> CurrentUser:
    """A diferencia del molde de comments, recibe el ROL: la matriz de
    permisos se recorre con los cuatro roles reales."""
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (email, password_hash, role) VALUES (%s, %s, %s) "
                "RETURNING id, email, role",
                (email, "$2b$12$hash-irrelevante", role.value),
            )
            row = cur.fetchone()
            return CurrentUser(id=row[0], email=row[1], role=UserRole(row[2]))
    finally:
        conn.close()


def _seed_report(dsn: str, user_id, **overrides) -> str:
    """Siembra una fila por SQL directo (sin pasar por la API) y devuelve el id."""
    row = {
        "user_id": str(user_id),  # psycopg2 sin adaptador de uuid.UUID
        "type": "bug",
        "body": "sembrado",
        "route": "/spectrograms",
        "url": "https://app.example.com/spectrograms",
        "user_agent": "pytest",
    }
    row.update(overrides)
    columns = ", ".join(row)
    placeholders = ", ".join(["%s"] * len(row))
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"INSERT INTO feedback_reports ({columns}) VALUES ({placeholders}) RETURNING id",
                tuple(row.values()),
            )
            return str(cur.fetchone()[0])
    finally:
        conn.close()


def _row(dsn: str, report_id: str) -> dict:
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT user_id, type, body, route, url, user_agent, created_at, status, "
                "status_changed_at, admin_comment, admin_comment_updated_at "
                "FROM feedback_reports WHERE id = %s",
                (report_id,),
            )
            fetched = cur.fetchone()
            assert fetched is not None, f"no hay fila {report_id}"
            keys = (
                "user_id",
                "type",
                "body",
                "route",
                "url",
                "user_agent",
                "created_at",
                "status",
                "status_changed_at",
                "admin_comment",
                "admin_comment_updated_at",
            )
            row = dict(zip(keys, fetched))
            # psycopg2 sin adaptador devuelve el UUID como str; se normaliza
            # para comparar contra `CurrentUser.id` (uuid.UUID).
            row["user_id"] = UUID(str(row["user_id"]))
            return row
    finally:
        conn.close()


def _count(dsn: str) -> int:
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM feedback_reports")
            return cur.fetchone()[0]
    finally:
        conn.close()


# --- fixtures ----------------------------------------------------------------


@pytest.fixture
def users(_migrated):
    """Los cuatro roles + un segundo viewer (para autoría ajena). Setea el
    service real en app.state y limpia todo al salir."""
    people = {
        "viewer": _insert_user(_migrated, "fb-viewer@example.com", UserRole.VIEWER),
        "viewer_b": _insert_user(_migrated, "fb-viewer-b@example.com", UserRole.VIEWER),
        "moderador": _insert_user(_migrated, "fb-mod@example.com", UserRole.MODERADOR),
        "admin": _insert_user(_migrated, "fb-admin@example.com", UserRole.ADMIN),
        "superadmin": _insert_user(_migrated, "fb-super@example.com", UserRole.SUPERADMIN),
    }
    app.state.feedback_service = FeedbackService(_LazyPool(_migrated))
    yield people, _migrated

    conn = _connect(_migrated)
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM feedback_reports")
            cur.execute("DELETE FROM users")
    finally:
        conn.close()


def _auth_service_mock(active: bool = True) -> MagicMock:
    fake = MagicMock()
    fake.is_user_active = AsyncMock(return_value=active)

    async def _auth_state(user_id) -> UserAuthState:
        if not active:
            # Cuenta desactivada: `deactivated_at` seteado ⇒ is_active False.
            return UserAuthState(is_active=False, role=None)
        decoded = fake.decode_access_token.return_value
        role = decoded.role if isinstance(decoded, CurrentUser) else UserRole.VIEWER
        return UserAuthState(is_active=True, role=role)

    fake.get_user_auth_state = _auth_state
    return fake


def _login_as(user: CurrentUser, client: TestClient, active: bool = True) -> None:
    fake_auth_service = _auth_service_mock(active=active)
    fake_auth_service.decode_access_token = MagicMock(return_value=user)
    app.state.auth_service = fake_auth_service
    client.cookies.set("session", "fake-session-jwt")


def _no_session(client: TestClient) -> None:
    """Auth service presente pero SIN cookie: el 401 sale de get_current_user,
    no de un state a medio armar."""
    app.state.auth_service = _auth_service_mock()
    client.cookies.clear()


def _payload(**overrides) -> dict:
    data = {
        "type": "bug",
        "body": "El helicorder no carga",
        "route": "/spectrograms",
        "url": "https://app.example.com/spectrograms",
        "user_agent": "Mozilla/5.0 (pytest)",
    }
    data.update(overrides)
    return data


# =============================================================================
# POST /feedback (2.4)
# =============================================================================


def test_post_viewer_crea_y_recibe_ack_minimo(client, users):
    people, dsn = users
    _login_as(people["viewer"], client)

    resp = client.post(BASE, json=_payload())
    assert resp.status_code == 201, resp.text
    ack = resp.json()
    assert set(ack) == {"id", "created_at"}

    row = _row(dsn, ack["id"])
    assert row["user_id"] == people["viewer"].id
    assert row["status"] == "new"
    assert row["status_changed_at"] is None
    assert row["admin_comment"] is None
    assert row["admin_comment_updated_at"] is None
    assert row["created_at"] == datetime.fromisoformat(ack["created_at"].replace("Z", "+00:00"))


def test_post_sin_sesion_da_401_y_cero_filas(client, users):
    _, dsn = users
    _no_session(client)
    resp = client.post(BASE, json=_payload())
    assert resp.status_code == 401
    assert "detail" in resp.json()
    assert _count(dsn) == 0


def test_post_cuenta_desactivada_da_401_y_cero_filas(client, users):
    people, dsn = users
    _login_as(people["viewer"], client, active=False)
    resp = client.post(BASE, json=_payload())
    assert resp.status_code == 401
    assert "detail" in resp.json()
    assert _count(dsn) == 0


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param({"body": ""}, id="body-vacio"),
        pytest.param({"body": "   \n\t  "}, id="body-solo-espacios"),
        pytest.param({"body": "x" * 2001}, id="body-2001"),
        pytest.param({"type": "question"}, id="type-invalido"),
        pytest.param({"url": "u" * 2001}, id="url-2001"),
        pytest.param({"route": "r" * 301}, id="route-301"),
        pytest.param({"user_agent": "a" * 401}, id="user-agent-401"),
    ],
)
def test_post_payload_invalido_da_422_sin_fila(client, users, overrides):
    people, dsn = users
    _login_as(people["viewer"], client)
    resp = client.post(BASE, json=_payload(**overrides))
    assert resp.status_code == 422, resp.text
    assert "detail" in resp.json()
    assert _count(dsn) == 0


@pytest.mark.parametrize("missing", ["url", "route", "user_agent"])
def test_post_contexto_ausente_da_422_sin_fila(client, users, missing):
    people, dsn = users
    _login_as(people["viewer"], client)
    data = _payload()
    del data[missing]
    resp = client.post(BASE, json=data)
    assert resp.status_code == 422, resp.text
    assert "detail" in resp.json()
    assert _count(dsn) == 0


def test_post_body_de_2000_exactos_se_persiste_completo(client, users):
    people, dsn = users
    _login_as(people["viewer"], client)
    body = "b" * 2000
    resp = client.post(BASE, json=_payload(body=body))
    assert resp.status_code == 201, resp.text
    assert _row(dsn, resp.json()["id"])["body"] == body


def test_post_ambos_tipos_persisten_su_type(client, users):
    people, dsn = users
    _login_as(people["viewer"], client)
    bug = client.post(BASE, json=_payload(type="bug"))
    suggestion = client.post(BASE, json=_payload(type="suggestion"))
    assert (bug.status_code, suggestion.status_code) == (201, 201)
    assert _row(dsn, bug.json()["id"])["type"] == "bug"
    assert _row(dsn, suggestion.json()["id"])["type"] == "suggestion"


def test_post_user_id_inyectado_en_el_body_se_ignora(client, users):
    """La sesión manda: A envía con el user_id de B y la fila es de A."""
    people, dsn = users
    _login_as(people["viewer"], client)
    resp = client.post(BASE, json=_payload(user_id=str(people["viewer_b"].id)))
    assert resp.status_code == 201, resp.text
    row = _row(dsn, resp.json()["id"])
    assert row["user_id"] == people["viewer"].id
    assert row["user_id"] != people["viewer_b"].id


def test_post_status_inyectado_en_el_body_se_ignora(client, users):
    """El estado inicial es contrato: nace en `new` aunque el body lo pida."""
    people, dsn = users
    _login_as(people["viewer"], client)
    resp = client.post(BASE, json=_payload(status="done"))
    assert resp.status_code == 201, resp.text
    assert _row(dsn, resp.json()["id"])["status"] == "new"


def test_post_created_at_del_cliente_no_manda(client, users):
    people, dsn = users
    _login_as(people["viewer"], client)
    past = "2001-01-01T00:00:00Z"
    resp = client.post(BASE, json=_payload(created_at=past))
    assert resp.status_code == 201, resp.text
    created = _row(dsn, resp.json()["id"])["created_at"]
    assert created > datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert created != datetime(2001, 1, 1, tzinfo=timezone.utc)


def test_post_contexto_con_query_params_se_persiste_tal_cual(client, users):
    people, dsn = users
    _login_as(people["viewer"], client)
    url = "https://app.example/analytics?channel=AK.FIRE..BHZ&start=2026-08-24T12:00:00Z"
    ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0"
    resp = client.post(BASE, json=_payload(route="/analytics", url=url, user_agent=ua))
    assert resp.status_code == 201, resp.text
    row = _row(dsn, resp.json()["id"])
    assert (row["route"], row["url"], row["user_agent"]) == ("/analytics", url, ua)


# =============================================================================
# GET /feedback (2.5)
# =============================================================================


def _seed_board(people, dsn) -> dict[str, str]:
    """A (viewer) en `new`, B en `in_progress` con comentario, C (moderador)
    en `discarded`; created_at escalonado para que el orden sea observable."""
    t0 = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
    a = _seed_report(dsn, people["viewer"].id, body="de A", created_at=t0)
    b = _seed_report(
        dsn,
        people["viewer_b"].id,
        body="de B",
        status="in_progress",
        status_changed_at=t0 + timedelta(hours=2),
        admin_comment="lo estoy mirando",
        admin_comment_updated_at=t0 + timedelta(hours=3),
        created_at=t0 + timedelta(hours=1),
    )
    c = _seed_report(
        dsn,
        people["moderador"].id,
        body="de C",
        status="discarded",
        status_changed_at=t0 + timedelta(hours=4),
        created_at=t0 + timedelta(hours=2),
    )
    return {"a": a, "b": b, "c": c}


def test_get_sin_sesion_da_401_sin_datos_de_reportes(client, users):
    people, dsn = users
    _seed_report(dsn, people["viewer"].id, body="TEXTO-QUE-NO-DEBE-FILTRARSE")
    _no_session(client)
    resp = client.get(BASE)
    assert resp.status_code == 401
    assert "detail" in resp.json()
    assert "TEXTO-QUE-NO-DEBE-FILTRARSE" not in resp.text


def test_get_cuenta_desactivada_da_401(client, users):
    people, dsn = users
    _seed_report(dsn, people["viewer"].id, body="TEXTO-QUE-NO-DEBE-FILTRARSE")
    _login_as(people["viewer"], client, active=False)
    resp = client.get(BASE)
    assert resp.status_code == 401
    assert "TEXTO-QUE-NO-DEBE-FILTRARSE" not in resp.text


@pytest.mark.parametrize("role", ["viewer", "moderador", "admin", "superadmin"])
def test_get_todos_los_roles_leen_200(client, users, role):
    people, dsn = users
    _seed_board(people, dsn)
    _login_as(people[role], client)
    resp = client.get(BASE)
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["reports"]) == 3


def test_get_viewer_ve_el_tablero_completo_con_autores_y_orden(client, users):
    people, dsn = users
    ids = _seed_board(people, dsn)
    _login_as(people["viewer"], client)

    resp = client.get(BASE)
    assert resp.status_code == 200, resp.text
    reports = resp.json()["reports"]

    # created_at DESC: C, B, A.
    assert [r["id"] for r in reports] == [ids["c"], ids["b"], ids["a"]]
    assert [r["author_email"] for r in reports] == [
        "fb-mod@example.com",
        "fb-viewer-b@example.com",
        "fb-viewer@example.com",
    ]
    assert [r["status"] for r in reports] == ["discarded", "in_progress", "new"]
    assert [r["admin_comment"] for r in reports] == [None, "lo estoy mirando", None]
    assert [r["admin_comment_updated_at"] is not None for r in reports] == [False, True, False]
    assert [r["status_changed_at"] is not None for r in reports] == [True, True, False]
    for report in reports:
        assert set(report) == ITEM_KEYS
        assert "user_id" not in report


def test_get_viewer_y_admin_leen_lo_mismo(client, users):
    people, dsn = users
    _seed_board(people, dsn)
    _login_as(people["viewer"], client)
    as_viewer = client.get(BASE).json()
    _login_as(people["admin"], client)
    as_admin = client.get(BASE).json()
    assert as_viewer == as_admin
    assert len(as_viewer["reports"]) == 3


def test_get_tablero_vacio_es_lista_vacia(client, users):
    people, _ = users
    _login_as(people["viewer"], client)
    resp = client.get(BASE)
    assert resp.status_code == 200
    assert resp.json() == {"reports": []}


# =============================================================================
# PUT /feedback/{report_id}/status (2.6)
# =============================================================================


def _status_url(report_id: str) -> str:
    return f"{BASE}/{report_id}/status"


def test_status_admin_mueve_new_a_in_progress_y_persiste(client, users):
    people, dsn = users
    report_id = _seed_report(dsn, people["viewer"].id)
    _login_as(people["admin"], client)

    resp = client.put(_status_url(report_id), json={"status": "in_progress"})
    assert resp.status_code == 200, resp.text
    item = resp.json()
    assert set(item) == ITEM_KEYS
    assert item["status"] == "in_progress"
    assert item["status_changed_at"] is not None
    assert item["author_email"] == "fb-viewer@example.com"

    row = _row(dsn, report_id)
    assert row["status"] == "in_progress"
    assert row["status_changed_at"] is not None

    # Cualquier usuario la ve movida en el GET siguiente.
    _login_as(people["viewer"], client)
    board = client.get(BASE).json()["reports"]
    assert board[0]["id"] == report_id and board[0]["status"] == "in_progress"


def test_status_repetir_el_mismo_estado_es_no_op_y_no_toca_el_timestamp(client, users):
    people, dsn = users
    report_id = _seed_report(dsn, people["viewer"].id)
    _login_as(people["admin"], client)

    assert client.put(_status_url(report_id), json={"status": "in_progress"}).status_code == 200
    t1 = _row(dsn, report_id)["status_changed_at"]
    assert t1 is not None

    resp = client.put(_status_url(report_id), json={"status": "in_progress"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "in_progress"
    assert _row(dsn, report_id)["status_changed_at"] == t1


def test_status_mover_hacia_atras_avanza_el_timestamp(client, users):
    people, dsn = users
    report_id = _seed_report(dsn, people["viewer"].id)
    _login_as(people["admin"], client)

    client.put(_status_url(report_id), json={"status": "in_progress"})
    t1 = _row(dsn, report_id)["status_changed_at"]
    resp = client.put(_status_url(report_id), json={"status": "new"})
    assert resp.status_code == 200, resp.text
    t2 = _row(dsn, report_id)["status_changed_at"]
    assert _row(dsn, report_id)["status"] == "new"
    assert t2 > t1


def test_status_salir_de_los_terminales_esta_permitido(client, users):
    people, dsn = users
    discarded = _seed_report(dsn, people["viewer"].id, status="discarded")
    done = _seed_report(dsn, people["viewer"].id, status="done")
    _login_as(people["admin"], client)

    assert client.put(_status_url(discarded), json={"status": "in_analysis"}).status_code == 200
    assert client.put(_status_url(done), json={"status": "new"}).status_code == 200
    assert _row(dsn, discarded)["status"] == "in_analysis"
    assert _row(dsn, done)["status"] == "new"


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"status": "resolved"}, id="resolved"),
        pytest.param({"status": "Hecho"}, id="etiqueta-castellano"),
        pytest.param({}, id="status-ausente"),
    ],
)
def test_status_fuera_del_enum_da_422_y_fila_intacta(client, users, body):
    people, dsn = users
    report_id = _seed_report(dsn, people["viewer"].id)
    _login_as(people["admin"], client)

    resp = client.put(_status_url(report_id), json=body)
    assert resp.status_code == 422, resp.text
    assert "detail" in resp.json()
    row = _row(dsn, report_id)
    assert (row["status"], row["status_changed_at"]) == ("new", None)


def test_status_uuid_inexistente_da_404(client, users):
    people, _ = users
    _login_as(people["admin"], client)
    resp = client.put(_status_url(MISSING_ID), json={"status": "done"})
    assert resp.status_code == 404
    # El 404 es del service (fila inexistente), no el "Not Found" de una ruta
    # sin registrar: sin esta distinción el test pasa con el router ausente.
    assert resp.json()["detail"] != "Not Found"


def test_status_id_malformado_da_422(client, users):
    people, _ = users
    _login_as(people["admin"], client)
    resp = client.put(_status_url("no-es-un-uuid"), json={"status": "done"})
    assert resp.status_code == 422
    assert "detail" in resp.json()


@pytest.mark.parametrize(
    "role,expected",
    [
        ("none", 401),
        ("viewer", 403),
        ("moderador", 403),
        ("admin", 200),
        ("superadmin", 200),
    ],
)
def test_status_matriz_de_roles(client, users, role, expected):
    people, dsn = users
    report_id = _seed_report(dsn, people["viewer"].id)
    if role == "none":
        _no_session(client)
    else:
        _login_as(people[role], client)

    resp = client.put(_status_url(report_id), json={"status": "done"})
    assert resp.status_code == expected, resp.text
    assert "detail" in resp.json() or expected == 200
    row = _row(dsn, report_id)
    if expected == 200:
        assert row["status"] == "done"
    else:
        assert (row["status"], row["status_changed_at"]) == ("new", None)


def test_status_mover_no_toca_comentario_ni_body_ni_type(client, users):
    people, dsn = users
    c1 = datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc)
    report_id = _seed_report(
        dsn,
        people["viewer"].id,
        type="suggestion",
        body="texto original",
        admin_comment="ya visto",
        admin_comment_updated_at=c1,
    )
    _login_as(people["admin"], client)

    assert client.put(_status_url(report_id), json={"status": "done"}).status_code == 200
    row = _row(dsn, report_id)
    assert (row["admin_comment"], row["admin_comment_updated_at"]) == ("ya visto", c1)
    assert (row["type"], row["body"]) == ("suggestion", "texto original")


def test_status_no_existe_delete_del_reporte(client, users):
    people, dsn = users
    report_id = _seed_report(dsn, people["viewer"].id)
    _login_as(people["admin"], client)
    assert client.delete(f"{BASE}/{report_id}").status_code in (404, 405)
    assert _count(dsn) == 1


# =============================================================================
# PUT /feedback/{report_id}/comment (2.7)
# =============================================================================


def _comment_url(report_id: str) -> str:
    return f"{BASE}/{report_id}/comment"


def test_comment_admin_escribe_y_el_viewer_lo_ve(client, users):
    people, dsn = users
    report_id = _seed_report(dsn, people["viewer"].id)
    _login_as(people["admin"], client)

    resp = client.put(_comment_url(report_id), json={"comment": "hola"})
    assert resp.status_code == 200, resp.text
    item = resp.json()
    assert set(item) == ITEM_KEYS
    assert item["admin_comment"] == "hola"
    assert item["admin_comment_updated_at"] is not None

    row = _row(dsn, report_id)
    assert row["admin_comment"] == "hola"
    assert row["admin_comment_updated_at"] is not None

    _login_as(people["viewer"], client)
    board = client.get(BASE).json()["reports"]
    assert board[0]["admin_comment"] == "hola"


def test_comment_repetir_el_mismo_texto_no_toca_el_timestamp(client, users):
    people, dsn = users
    report_id = _seed_report(dsn, people["viewer"].id)
    _login_as(people["admin"], client)

    client.put(_comment_url(report_id), json={"comment": "hola"})
    c1 = _row(dsn, report_id)["admin_comment_updated_at"]
    assert c1 is not None

    resp = client.put(_comment_url(report_id), json={"comment": "hola"})
    assert resp.status_code == 200, resp.text
    assert _row(dsn, report_id)["admin_comment_updated_at"] == c1

    # Misma cadena con espacios exteriores: normalizada ⇒ sigue siendo no-op.
    resp = client.put(_comment_url(report_id), json={"comment": "  hola  "})
    assert resp.status_code == 200, resp.text
    assert resp.json()["admin_comment"] == "hola"
    row = _row(dsn, report_id)
    assert (row["admin_comment"], row["admin_comment_updated_at"]) == ("hola", c1)


def test_comment_editar_reemplaza_y_avanza_el_timestamp(client, users):
    people, dsn = users
    report_id = _seed_report(dsn, people["viewer"].id)
    _login_as(people["admin"], client)

    client.put(_comment_url(report_id), json={"comment": "v1"})
    c1 = _row(dsn, report_id)["admin_comment_updated_at"]
    resp = client.put(_comment_url(report_id), json={"comment": "v2"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["admin_comment"] == "v2"
    c2 = _row(dsn, report_id)["admin_comment_updated_at"]
    assert c2 > c1

    # Sin historial: "v1" no aparece en ningún campo del tablero.
    _login_as(people["viewer"], client)
    board = client.get(BASE)
    assert '"v1"' not in board.text
    assert board.json()["reports"][0]["admin_comment"] == "v2"


@pytest.mark.parametrize(
    "value",
    [
        pytest.param(None, id="null"),
        pytest.param("", id="vacio"),
        pytest.param("   ", id="solo-espacios"),
    ],
)
def test_comment_vaciar_pone_ambas_columnas_en_null(client, users, value):
    people, dsn = users
    report_id = _seed_report(
        dsn,
        people["viewer"].id,
        admin_comment="texto",
        admin_comment_updated_at=datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc),
    )
    _login_as(people["admin"], client)

    resp = client.put(_comment_url(report_id), json={"comment": value})
    assert resp.status_code == 200, resp.text
    item = resp.json()
    assert (item["admin_comment"], item["admin_comment_updated_at"]) == (None, None)
    row = _row(dsn, report_id)
    assert (row["admin_comment"], row["admin_comment_updated_at"]) == (None, None)


def test_comment_vaciar_un_null_responde_200(client, users):
    people, dsn = users
    report_id = _seed_report(dsn, people["viewer"].id)
    _login_as(people["admin"], client)
    resp = client.put(_comment_url(report_id), json={"comment": None})
    assert resp.status_code == 200, resp.text
    row = _row(dsn, report_id)
    assert (row["admin_comment"], row["admin_comment_updated_at"]) == (None, None)


def test_comment_de_2001_da_422_y_conserva_el_previo(client, users):
    people, dsn = users
    c1 = datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc)
    report_id = _seed_report(
        dsn, people["viewer"].id, admin_comment="previo", admin_comment_updated_at=c1
    )
    _login_as(people["admin"], client)

    resp = client.put(_comment_url(report_id), json={"comment": "c" * 2001})
    assert resp.status_code == 422, resp.text
    assert "detail" in resp.json()
    row = _row(dsn, report_id)
    assert (row["admin_comment"], row["admin_comment_updated_at"]) == ("previo", c1)


def test_comment_de_2000_exactos_se_persiste_completo(client, users):
    people, dsn = users
    report_id = _seed_report(dsn, people["viewer"].id)
    _login_as(people["admin"], client)
    text = "c" * 2000
    resp = client.put(_comment_url(report_id), json={"comment": text})
    assert resp.status_code == 200, resp.text
    assert _row(dsn, report_id)["admin_comment"] == text


def test_comment_no_mueve_la_tarjeta(client, users):
    people, dsn = users
    t1 = datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc)
    report_id = _seed_report(dsn, people["viewer"].id, status="in_analysis", status_changed_at=t1)
    _login_as(people["admin"], client)

    assert client.put(_comment_url(report_id), json={"comment": "mirando"}).status_code == 200
    assert client.put(_comment_url(report_id), json={"comment": "editado"}).status_code == 200
    row = _row(dsn, report_id)
    assert (row["status"], row["status_changed_at"]) == ("in_analysis", t1)


def test_comment_uuid_inexistente_da_404(client, users):
    people, _ = users
    _login_as(people["admin"], client)
    resp = client.put(_comment_url(MISSING_ID), json={"comment": "hola"})
    assert resp.status_code == 404
    assert resp.json()["detail"] != "Not Found"


def test_comment_id_malformado_da_422(client, users):
    people, _ = users
    _login_as(people["admin"], client)
    resp = client.put(_comment_url("no-es-un-uuid"), json={"comment": "hola"})
    assert resp.status_code == 422
    assert "detail" in resp.json()


@pytest.mark.parametrize(
    "role,expected",
    [
        ("none", 401),
        ("viewer", 403),
        ("moderador", 403),
        ("admin", 200),
        ("superadmin", 200),
    ],
)
def test_comment_matriz_de_roles(client, users, role, expected):
    people, dsn = users
    report_id = _seed_report(dsn, people["viewer"].id)
    if role == "none":
        _no_session(client)
    else:
        _login_as(people[role], client)

    resp = client.put(_comment_url(report_id), json={"comment": "intento"})
    assert resp.status_code == expected, resp.text
    assert "detail" in resp.json() or expected == 200
    row = _row(dsn, report_id)
    if expected == 200:
        assert row["admin_comment"] == "intento"
    else:
        assert (row["admin_comment"], row["admin_comment_updated_at"]) == (None, None)
