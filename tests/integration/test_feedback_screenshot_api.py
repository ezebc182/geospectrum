"""API de captura de pantalla del feedback (feedback-screenshot-attachment),
contra Postgres REAL. Molde `test_feedback_api.py`: servicio real contra el
testcontainer (fixture `_migrated`, aplica 019+020 por glob), auth mockeada
solo en el round-trip de sesión, `TestClient(app)` SIN `with` (el `with`
dispara el lifespan real y choca con otros archivos por "Event loop is
closed") y `app.state` a mano.

`ScreenshotStorageService` con las 4 vars presentes (credenciales/endpoint
FALSOS pero no-None) da `enabled=True` sin abrir ningún socket real:
`generate_presigned_url` firma localmente (HMAC-SHA256), no hace un round-trip
a R2 — ver design.md Decision 1, "cómputo local". No hace falta un R2 de test.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock
from urllib.parse import parse_qs, urlparse
from uuid import UUID

import asyncpg
import psycopg2
import pytest
from fastapi.testclient import TestClient

from src.main import app
from src.models.user import CurrentUser, UserRole
from src.services.auth_service import UserAuthState
from src.services.feedback_service import FeedbackService
from src.services.screenshot_storage import ScreenshotStorageService

BASE = "/feedback"
MISSING_ID = "00000000-0000-0000-0000-000000000000"

_FAKE_R2 = {
    "endpoint_url": "https://fake-account.r2.cloudflarestorage.com",
    "bucket": "feedback-screenshots-test",
    "access_key_id": "fake-access-key-id",
    "secret_access_key": "fake-secret-access-key",
}


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_app_state():
    yield
    for key in ("auth_service", "feedback_service", "screenshot_storage"):
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
    row = {
        "user_id": str(user_id),
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
                "SELECT user_id, screenshot_key FROM feedback_reports WHERE id = %s",
                (report_id,),
            )
            fetched = cur.fetchone()
            assert fetched is not None, f"no hay fila {report_id}"
            row = dict(zip(("user_id", "screenshot_key"), fetched))
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
    people = {
        "viewer": _insert_user(_migrated, "shot-viewer@example.com", UserRole.VIEWER),
        "admin": _insert_user(_migrated, "shot-admin@example.com", UserRole.ADMIN),
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


def _enable_storage() -> None:
    app.state.screenshot_storage = ScreenshotStorageService(**_FAKE_R2)


def _disable_storage() -> None:
    app.state.screenshot_storage = ScreenshotStorageService(None, None, None, None)


def _auth_service_mock(active: bool = True) -> MagicMock:
    fake = MagicMock()
    fake.is_user_active = AsyncMock(return_value=active)

    async def _auth_state(user_id) -> UserAuthState:
        if not active:
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


_VALID_KEY = "feedback-screenshots/3fa85f64-5717-4562-b3fc-2c963f66afa6.png"


# =============================================================================
# POST /feedback/upload-url (2.8)
# =============================================================================


def test_upload_url_sesion_valida_devuelve_201_con_key_valida(client, users):
    people, _ = users
    _enable_storage()
    _login_as(people["viewer"], client)

    resp = client.post(f"{BASE}/upload-url")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert set(body) == {"key", "upload_url", "expires_at"}
    assert body["upload_url"]
    assert body["key"].startswith("feedback-screenshots/")
    assert body["key"].endswith(".png")


def test_upload_url_dos_llamadas_sucesivas_devuelven_keys_distintas(client, users):
    people, _ = users
    _enable_storage()
    _login_as(people["viewer"], client)

    first = client.post(f"{BASE}/upload-url").json()
    second = client.post(f"{BASE}/upload-url").json()
    assert first["key"] != second["key"]


def test_upload_url_sin_sesion_da_401(client, users):
    _enable_storage()
    _no_session(client)
    resp = client.post(f"{BASE}/upload-url")
    assert resp.status_code == 401
    assert "detail" in resp.json()


def test_upload_url_cuenta_desactivada_da_401(client, users):
    people, _ = users
    _enable_storage()
    _login_as(people["viewer"], client, active=False)
    resp = client.post(f"{BASE}/upload-url")
    assert resp.status_code == 401


# =============================================================================
# Degradación con R2 sin configurar (2.9)
# =============================================================================


def test_upload_url_r2_sin_configurar_da_503(client, users):
    people, _ = users
    _disable_storage()
    _login_as(people["viewer"], client)
    resp = client.post(f"{BASE}/upload-url")
    assert resp.status_code == 503
    assert "detail" in resp.json()


def test_create_sin_screenshot_key_sigue_201_con_r2_deshabilitado(client, users):
    people, dsn = users
    _disable_storage()
    _login_as(people["viewer"], client)
    resp = client.post(BASE, json=_payload())
    assert resp.status_code == 201, resp.text
    assert _row(dsn, resp.json()["id"])["screenshot_key"] is None


def test_create_con_key_valida_sigue_201_con_r2_deshabilitado(client, users):
    people, dsn = users
    _disable_storage()
    _login_as(people["viewer"], client)
    resp = client.post(BASE, json=_payload(screenshot_key=_VALID_KEY))
    assert resp.status_code == 201, resp.text
    assert _row(dsn, resp.json()["id"])["screenshot_key"] == _VALID_KEY


def test_get_list_y_puts_siguen_su_codigo_normal_con_r2_deshabilitado(client, users):
    people, dsn = users
    _disable_storage()
    report_id = _seed_report(dsn, people["viewer"].id)

    _login_as(people["viewer"], client)
    assert client.get(BASE).status_code == 200

    _login_as(people["admin"], client)
    assert (
        client.put(f"{BASE}/{report_id}/status", json={"status": "in_progress"}).status_code == 200
    )
    assert client.put(f"{BASE}/{report_id}/comment", json={"comment": "ok"}).status_code == 200


# =============================================================================
# Create con/sin key y lectura de screenshot-url (2.10)
# =============================================================================


def test_create_sin_screenshot_key_201_select_confirma_null(client, users):
    people, dsn = users
    _enable_storage()
    _login_as(people["viewer"], client)
    resp = client.post(BASE, json=_payload())
    assert resp.status_code == 201, resp.text
    assert _row(dsn, resp.json()["id"])["screenshot_key"] is None


def test_create_con_key_valida_201_se_persiste_sin_llamar_r2(client, users, monkeypatch):
    people, dsn = users
    _enable_storage()
    _login_as(people["viewer"], client)

    calls = {"n": 0}
    original = ScreenshotStorageService.create_download_url

    def _counting(self, *args, **kwargs):
        calls["n"] += 1
        return original(self, *args, **kwargs)

    monkeypatch.setattr(ScreenshotStorageService, "create_download_url", _counting)

    resp = client.post(BASE, json=_payload(screenshot_key=_VALID_KEY))
    assert resp.status_code == 201, resp.text
    assert _row(dsn, resp.json()["id"])["screenshot_key"] == _VALID_KEY
    assert calls["n"] == 0


@pytest.mark.parametrize(
    "value",
    [
        pytest.param("../../etc/passwd", id="path-traversal"),
        pytest.param("otro-bucket/imagen.jpg", id="bucket-ajeno"),
        pytest.param("feedback-screenshots/no-es-un-uuid.png", id="uuid-invalido"),
    ],
)
def test_create_con_key_invalida_422_cero_filas(client, users, value):
    people, dsn = users
    _enable_storage()
    _login_as(people["viewer"], client)
    resp = client.post(BASE, json=_payload(screenshot_key=value))
    assert resp.status_code == 422, resp.text
    assert _count(dsn) == 0


def _screenshot_url(report_id: str) -> str:
    return f"{BASE}/{report_id}/screenshot-url"


def test_screenshot_url_reporte_con_key_devuelve_200(client, users):
    people, dsn = users
    _enable_storage()
    report_id = _seed_report(dsn, people["viewer"].id, screenshot_key=_VALID_KEY)
    _login_as(people["viewer"], client)

    resp = client.get(_screenshot_url(report_id))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"url", "expires_at"}
    assert body["url"]


def test_screenshot_url_reporte_sin_key_da_404(client, users):
    people, dsn = users
    _enable_storage()
    report_id = _seed_report(dsn, people["viewer"].id)
    _login_as(people["viewer"], client)

    resp = client.get(_screenshot_url(report_id))
    assert resp.status_code == 404
    # El 404 es del ENDPOINT (screenshot_key IS NULL), no el "Not Found"
    # genérico de una ruta sin registrar: sin esta distinción el test pasa
    # con el router ausente (mismo criterio que test_feedback_api.py).
    assert resp.json()["detail"] != "Not Found"


def test_screenshot_url_uuid_inexistente_da_404(client, users):
    people, _ = users
    _enable_storage()
    _login_as(people["viewer"], client)
    resp = client.get(_screenshot_url(MISSING_ID))
    assert resp.status_code == 404
    assert resp.json()["detail"] != "Not Found"


def test_screenshot_url_sin_sesion_da_401(client, users):
    people, dsn = users
    _enable_storage()
    report_id = _seed_report(dsn, people["viewer"].id, screenshot_key=_VALID_KEY)
    _no_session(client)
    resp = client.get(_screenshot_url(report_id))
    assert resp.status_code == 401


# =============================================================================
# Mutación M7 — screenshot_key expuesto con su VALOR real en GET/PUT (2.12)
# =============================================================================


def test_get_list_expone_el_valor_real_de_screenshot_key(client, users):
    people, dsn = users
    _seed_report(dsn, people["viewer"].id, screenshot_key=_VALID_KEY)
    _login_as(people["viewer"], client)

    reports = client.get(BASE).json()["reports"]
    assert reports[0]["screenshot_key"] == _VALID_KEY


def test_put_status_expone_el_valor_real_de_screenshot_key(client, users):
    people, dsn = users
    report_id = _seed_report(dsn, people["viewer"].id, screenshot_key=_VALID_KEY)
    _login_as(people["admin"], client)

    resp = client.put(f"{BASE}/{report_id}/status", json={"status": "in_progress"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["screenshot_key"] == _VALID_KEY


def test_put_comment_expone_el_valor_real_de_screenshot_key(client, users):
    people, dsn = users
    report_id = _seed_report(dsn, people["viewer"].id, screenshot_key=_VALID_KEY)
    _login_as(people["admin"], client)

    resp = client.put(f"{BASE}/{report_id}/comment", json={"comment": "ok"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["screenshot_key"] == _VALID_KEY


# =============================================================================
# Mutación M4 — contrato del SDK: ExpiresIn=300 en la URL firmada (2.12)
# =============================================================================


def test_upload_url_firma_con_expires_in_300(client, users):
    """No requiere R2 real: la URL firmada localmente lleva el parámetro de
    expiración como querystring (X-Amz-Expires), verificable inspeccionando
    la URL devuelta."""
    people, _ = users
    _enable_storage()
    _login_as(people["viewer"], client)

    resp = client.post(f"{BASE}/upload-url")
    assert resp.status_code == 201, resp.text
    query = parse_qs(urlparse(resp.json()["upload_url"]).query)
    assert query.get("X-Amz-Expires") == ["300"]
