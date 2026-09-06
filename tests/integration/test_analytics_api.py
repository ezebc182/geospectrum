"""Router `/analytics` (b-value, hipocentros, uptime) contra Postgres REAL (3.5).

Moldes: `test_feedback_api.py` (`TestClient(app)` SIN `with`, `app.state` a
mano, `_LazyPool` por loop, sesión mockeada SOLO en el round-trip de la
cookie), `test_areas_api.py` (catálogo de áreas sembrado por `_migrated`) y
`test_api.py::test_report_*` (área default para el anónimo).

Todo lo que se afirma sobre datos sale de filas sembradas por SQL directo
(psycopg2 `executemany`), NUNCA por `EventStore.upsert`: el upsert dedupea
por ±120 s y 30 km, y un catálogo sintético de 483 eventos en el mismo
punto quedaría fusionado en uno.

Por qué `_LazyPool` también para `EventStore`: el store usa
`self.pool.fetch(...)` sobre un asyncpg.Pool atado al loop donde se creó, y
`TestClient` sin `with` corre cada request en un loop nuevo. El proxy crea
un pool por loop y delega; la query que corre es la REAL.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import asyncpg
import psycopg2
import pytest
from fastapi.testclient import TestClient

from src.main import app
from src.models.user import CurrentUser, UserRole
from src.services.area_service import DEFAULT_AREA_SLUG, AreaService
from src.services.auth_service import UserAuthState
from src.services.event_store import EventStore
from src.services.gutenberg_richter import MIN_EVENTS
from src.services.station_uptime import EXPECTED_COLUMNS_PER_HOUR

# Área custom "Andes": un TRIÁNGULO a propósito (los presets del seed son
# rectángulos, donde polígono == bbox y la etapa 2 del filtro nunca decide
# distinto que la etapa 1 — no habría mutación de `point_in_area` falsable).
ANDES_TRIANGLE = {
    "type": "Polygon",
    "coordinates": [[[-72.0, -35.0], [-64.0, -35.0], [-68.0, -25.0], [-72.0, -35.0]]],
}
ANDES = (-30.0, -68.0)  # dentro del triángulo (a lat −30 abarca lon −70..−66)
# Dentro del bbox del triángulo (lat −35..−25, lon −72..−64) pero FUERA del
# polígono (a lat −26 el triángulo abarca solo lon −68.4..−67.6): pasa la
# etapa 1 en SQL y la tiene que descartar la etapa 2 en Python.
BBOX_CORNER = (-26.0, -71.5)

KBU = "GE.KBU..BHZ"
MAJO = "IU.MAJO.00.BHZ"


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_app_state():
    yield
    for key in ("event_store", "db_pool", "area_service", "auth_service"):
        if hasattr(app.state, key):
            del app.state._state[key]
    app.dependency_overrides.clear()


class _LazyPool:
    """Proxy de asyncpg.Pool creado en el PRIMER uso, uno por loop (ver
    test_feedback_api.py). Además de `acquire()` expone `fetch()` porque
    `EventStore` consulta el pool directo, sin `acquire`."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pools: dict[int, asyncpg.Pool] = {}

    async def _pool(self) -> asyncpg.Pool:
        key = id(asyncio.get_running_loop())
        pool = self._pools.get(key)
        if pool is None:
            pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=4)
            self._pools[key] = pool
        return pool

    async def fetch(self, sql: str, *args):
        return await (await self._pool()).fetch(sql, *args)

    async def fetchrow(self, sql: str, *args):
        return await (await self._pool()).fetchrow(sql, *args)

    async def execute(self, sql: str, *args):
        return await (await self._pool()).execute(sql, *args)

    def acquire(self):
        outer = self

        class _AcquireCtx:
            def __init__(ctx_self):
                ctx_self._inner = None

            async def __aenter__(ctx_self):
                ctx_self._inner = (await outer._pool()).acquire()
                return await ctx_self._inner.__aenter__()

            async def __aexit__(ctx_self, *exc):
                return await ctx_self._inner.__aexit__(*exc)

        return _AcquireCtx()


def _store(dsn: str) -> EventStore:
    """EventStore real con el pool por loop: `connect()` crearía un pool atado
    al loop del fixture, inservible desde los requests del TestClient."""
    store = EventStore(dsn)
    store._pool = _LazyPool(dsn)  # type: ignore[assignment]
    return store


# --- helpers de base ---------------------------------------------------------


def _connect(dsn: str):
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    return conn


def _event(
    id_: str,
    mag: float,
    hours_ago: float,
    latlon: tuple[float, float] = ANDES,
    prof_km=10.0,
    mag_tipo="ML",
) -> tuple:
    hora = datetime.now(timezone.utc) - timedelta(hours=hours_ago)
    return (id_, ["USGS"], hora, latlon[0], latlon[1], prof_km, mag, mag_tipo, "sembrado")


def _insert_events(dsn: str, rows: list[tuple]) -> None:
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO seismic_events "
                "(id, fuentes, hora_utc, lat, lon, prof_km, mag, mag_tipo, lugar) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                rows,
            )
    finally:
        conn.close()


def _synthetic_catalog(latlon=ANDES, a: float = 4.0, b: float = 1.0) -> dict[float, int]:
    """El catálogo `round(10^(a − b·M))` por bin de 0.1 entre M 2.0 y 4.0 (R31:
    483 eventos). Devuelve `{m: count}`; los eventos se reparten en el tiempo
    dentro de 30 días para que ninguno caiga fuera de la ventana."""
    counts = {round(2.0 + i * 0.1, 1): round(10 ** (a - b * (2.0 + i * 0.1))) for i in range(21)}
    return counts


def _seed_synthetic_catalog(dsn: str, latlon=ANDES) -> dict[float, int]:
    counts = _synthetic_catalog(latlon)
    rows = []
    i = 0
    for m, n in counts.items():
        for _ in range(n):
            rows.append(_event(f"syn-{i}", m, hours_ago=1 + i * 1.4, latlon=latlon))
            i += 1
    _insert_events(dsn, rows)
    return counts


def _insert_user(dsn: str, email: str) -> CurrentUser:
    conn = _connect(dsn)
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


def _create_active_area(dsn: str, user: CurrentUser, name: str, geometry: dict) -> str:
    """Crea un área propia del usuario con el service REAL (deriva bbox y slug
    como en producción) y la deja activa. Devuelve el slug. `asyncio.run` con
    un pool propio: el test es sincrónico y el TestClient corre en otro loop."""

    async def _go() -> str:
        pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
        try:
            service = AreaService(pool)
            area = await service.create(user.id, name, geometry)
            await service.set_active(user.id, area.id)
            return area.slug
        finally:
            await pool.close()

    return asyncio.run(_go())


def _insert_uptime(dsn: str, rows: list[tuple[str, datetime, int]]) -> None:
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO station_uptime_hourly (channel, bucket_start, columns_count) "
                "VALUES (%s, %s, %s)",
                rows,
            )
    finally:
        conn.close()


def _auth_service_mock(active: bool = True) -> MagicMock:
    fake = MagicMock()
    fake.is_user_active = AsyncMock(return_value=active)

    async def _auth_state(user_id) -> UserAuthState:
        decoded = fake.decode_access_token.return_value
        role = decoded.role if isinstance(decoded, CurrentUser) else UserRole.VIEWER
        return UserAuthState(is_active=active, role=role)

    fake.get_user_auth_state = _auth_state
    return fake


def _login_as(user: CurrentUser, client: TestClient) -> None:
    fake_auth_service = _auth_service_mock()
    fake_auth_service.decode_access_token = MagicMock(return_value=user)
    app.state.auth_service = fake_auth_service
    client.cookies.set("session", "fake-session-jwt")


def _parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _hour(offset_hours: int, now: datetime) -> datetime:
    return now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=offset_hours)


# --- fixtures ----------------------------------------------------------------


@pytest.fixture
def catalog(_migrated):
    """`event_store` y `area_service` reales en app.state; limpia eventos,
    áreas custom y usuarios al salir (las del sistema las siembra `_migrated`)."""
    app.state.event_store = _store(_migrated)
    app.state.area_service = AreaService(_LazyPool(_migrated))
    yield _migrated
    conn = _connect(_migrated)
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM seismic_events")
            cur.execute("DELETE FROM areas_of_interest WHERE NOT is_system")
            cur.execute("DELETE FROM users")
    finally:
        conn.close()


@pytest.fixture
def uptime_db(_migrated):
    app.state.db_pool = _LazyPool(_migrated)
    yield _migrated
    conn = _connect(_migrated)
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM station_uptime_hourly")
    finally:
        conn.close()


# =============================================================================
# GET /analytics/b-value
# =============================================================================


def test_b_value_sin_event_store_da_503(client):
    resp = client.get("/analytics/b-value")
    assert resp.status_code == 503
    assert resp.json()["detail"] != "Not Found"


def test_b_value_catalogo_sintetico_devuelve_b_cerca_de_1(client, catalog):
    counts = _seed_synthetic_catalog(catalog)
    total = sum(counts.values())
    assert total == 483  # R31, verificado con Python

    resp = client.get("/analytics/b-value?days=30&mc=2.0")

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["method"] == "aki-utsu-mle"
    assert 0.90 <= body["b"] <= 1.10  # esperado a mano: 0.9963 (R29)
    assert body["sigma_b"] > 0
    assert body["n_total"] == total
    assert body["n_above_mc"] == total
    assert body["mc"] == 2.0
    assert body["min_events"] == MIN_EVENTS
    assert {(bin_["m"], bin_["count"]) for bin_ in body["bins"]} == set(counts.items())
    assert body["bins"][0]["cumulative"] == total
    assert body["mag_type_counts"] == {"ML": total}
    assert body["area_slug"] == DEFAULT_AREA_SLUG


def test_b_value_min_mag_recorta_el_catalogo_en_sql(client, catalog):
    counts = _seed_synthetic_catalog(catalog)
    esperado = sum(n for m, n in counts.items() if m >= 3.0)

    resp = client.get("/analytics/b-value?days=30&mc=3.0&min_mag=3.0")

    assert resp.status_code == 200
    assert resp.json()["n_total"] == esperado


def test_b_value_catalogo_chico_es_insuficiente_sin_b(client, catalog):
    _insert_events(
        catalog,
        [
            _event(f"chico-{i}", 2.0 + (i % 10) * 0.1, hours_ago=1 + i)
            for i in range(MIN_EVENTS - 1)
        ],
    )

    resp = client.get("/analytics/b-value?mc=2.0")

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "insufficient"
    assert "b" not in body  # ni siquiera null [R8]
    assert "a" not in body
    assert "sigma_b" not in body
    assert body["n_above_mc"] == MIN_EVENTS - 1
    assert body["min_events"] == MIN_EVENTS
    assert body["bins"]  # el histograma viaja igual: dato honesto


def test_b_value_eventos_fuera_del_area_activa_no_cuentan(client, catalog):
    """Área activa "Andes" (triángulo): MIN_EVENTS+100 en la esquina del
    bbox que queda FUERA del polígono y MIN_EVENTS−10 adentro. Sin la etapa
    2 (`point_in_area`) daría `ok` con 2·MIN_EVENTS+90: el bbox de SQL deja
    pasar la esquina."""
    user = _insert_user(catalog, "analytics-andes@example.com")
    slug = _create_active_area(catalog, user, "Andes", ANDES_TRIANGLE)
    _login_as(user, client)
    rows = [
        _event(f"esquina-{i}", 2.0 + (i % 10) * 0.1, hours_ago=1 + i * 0.5, latlon=BBOX_CORNER)
        for i in range(MIN_EVENTS + 100)
    ]
    rows += [
        _event(f"andes-{i}", 2.0 + (i % 10) * 0.1, hours_ago=1 + i * 0.5, latlon=ANDES)
        for i in range(MIN_EVENTS - 10)
    ]
    _insert_events(catalog, rows)

    resp = client.get("/analytics/b-value?mc=2.0")

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "insufficient"
    assert body["n_above_mc"] == MIN_EVENTS - 10
    assert body["n_total"] == MIN_EVENTS - 10
    assert body["area_slug"] == slug


def test_b_value_sin_cookie_usa_el_area_default_y_no_da_401(client, catalog):
    app.state.auth_service = _auth_service_mock()
    client.cookies.clear()

    resp = client.get("/analytics/b-value")

    assert resp.status_code == 200
    body = resp.json()
    assert body["area_slug"] == DEFAULT_AREA_SLUG
    assert body["status"] == "insufficient"
    assert body["n_total"] == 0
    assert body["mc"] is None


@pytest.mark.parametrize("days", [0, 366])
def test_b_value_days_fuera_de_rango_da_422(client, catalog, days):
    resp = client.get(f"/analytics/b-value?days={days}")
    assert resp.status_code == 422
    assert "detail" in resp.json()


# =============================================================================
# GET /analytics/hypocenters
# =============================================================================


def test_hypocenters_sin_event_store_da_503(client):
    resp = client.get("/analytics/hypocenters")
    assert resp.status_code == 503
    assert resp.json()["detail"] != "Not Found"


def test_hypocenters_ventana_de_30_dias_recortada_al_area(client, catalog):
    """10 adentro del triángulo, 5 en la esquina del bbox (afuera del
    polígono) y 3 adentro pero de hace 40 días."""
    user = _insert_user(catalog, "analytics-hipo@example.com")
    slug = _create_active_area(catalog, user, "Andes", ANDES_TRIANGLE)
    _login_as(user, client)
    rows = [_event(f"in-{i}", 3.0 + i * 0.1, hours_ago=2 + i, latlon=ANDES) for i in range(10)]
    rows += [
        _event(f"out-{i}", 3.0 + i * 0.1, hours_ago=2 + i, latlon=BBOX_CORNER) for i in range(5)
    ]
    rows += [
        _event(f"old-{i}", 3.0 + i * 0.1, hours_ago=40 * 24 + i, latlon=ANDES) for i in range(3)
    ]
    _insert_events(catalog, rows)

    resp = client.get("/analytics/hypocenters?days=30")

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 10
    assert body["truncated"] is False
    assert len(body["eventos"]) == 10
    assert {e["id"] for e in body["eventos"]} == {f"in-{i}" for i in range(10)}
    assert body["area_slug"] == slug


def test_hypocenters_limit_trunca_lo_declara_y_se_queda_con_los_grandes(client, catalog):
    """[R18] / M4: los más GRANDES son los más VIEJOS a propósito (el M7.0
    hace 85 h, el M3.5 hace 1 h), así un `ORDER BY hora_utc DESC` recortado
    devolvería [3.5, 4.0, 4.5, 5.0, 5.5] — la mentira de truncado."""
    mags = [7.0, 6.5, 6.0, 5.5, 5.0, 4.5, 4.0, 3.5]
    _insert_events(
        catalog,
        [_event(f"m-{mag}", mag, hours_ago=1 + (mag - 3.5) * 24) for mag in mags],
    )

    resp = client.get("/analytics/hypocenters?limit=5")

    assert resp.status_code == 200
    body = resp.json()
    assert len(body["eventos"]) == 5
    assert body["total"] == 8
    assert body["truncated"] is True
    assert [e["mag"] for e in body["eventos"]] == [7.0, 6.5, 6.0, 5.5, 5.0]


def test_hypocenters_evento_sin_profundidad_viaja_con_null(client, catalog):
    _insert_events(catalog, [_event("sin-prof", 4.2, hours_ago=3, prof_km=None)])

    resp = client.get("/analytics/hypocenters")

    assert resp.status_code == 200
    (evento,) = resp.json()["eventos"]
    assert evento["id"] == "sin-prof"
    assert "prof_km" in evento
    assert evento["prof_km"] is None


@pytest.mark.parametrize("query", ["limit=0", "limit=5001", "days=0", "days=366"])
def test_hypocenters_bordes_dan_422(client, catalog, query):
    resp = client.get(f"/analytics/hypocenters?{query}")
    assert resp.status_code == 422
    assert "detail" in resp.json()


def test_hypocenters_no_consulta_fuentes_externas(client, catalog):
    _insert_events(catalog, [_event("tabla", 4.0, hours_ago=1)])
    boom = AsyncMock(side_effect=RuntimeError("fuente caída"))
    with (
        patch("src.main.fetch_usgs_events", boom),
        patch("src.main.fetch_emsc_events", boom),
        patch("src.main.fetch_inpres_events", boom),
        patch("src.services.report_service.build_report", boom),
    ):
        resp = client.get("/analytics/hypocenters")

    assert resp.status_code == 200
    assert [e["id"] for e in resp.json()["eventos"]] == ["tabla"]
    boom.assert_not_awaited()


# =============================================================================
# GET /analytics/station-uptime
# =============================================================================


def test_station_uptime_sin_db_pool_da_503(client):
    resp = client.get("/analytics/station-uptime?days=7")
    assert resp.status_code == 503
    assert resp.json()["detail"] != "Not Found"


def _full_week(now: datetime, channel: str = KBU, skip_day: datetime | None = None):
    """900 columnas en TODAS las horas desde hace 8 días hasta la hora en
    curso (opcionalmente sin NINGUNA fila en `skip_day`)."""
    first = (now - timedelta(days=8)).replace(hour=0, minute=0, second=0, microsecond=0)
    rows = []
    hour = first
    while hour <= now:
        if skip_day is None or hour.replace(hour=0) != skip_day:
            rows.append((channel, hour, EXPECTED_COLUMNS_PER_HOUR))
        hour += timedelta(hours=1)
    return rows


def test_station_uptime_ventana_de_7_dias_con_buckets_diarios(client, uptime_db):
    now = datetime.now(timezone.utc)
    _insert_uptime(uptime_db, _full_week(now))

    resp = client.get(f"/analytics/station-uptime?days=7&bucket=day&channel={KBU}")

    assert resp.status_code == 200
    body = resp.json()
    assert body["bucket"] == "day"
    assert body["expected_columns_per_hour"] == EXPECTED_COLUMNS_PER_HOUR
    buckets = body["stations"][KBU]
    assert len(buckets) == 8  # 7 cerrados + el día en curso
    closed, current = buckets[:-1], buckets[-1]
    assert all(b["ratio"] == 1.0 for b in closed)
    assert all(b["expected"] == EXPECTED_COLUMNS_PER_HOUR * 24 for b in closed)
    assert all(b["in_progress"] is False for b in closed)
    assert current["in_progress"] is True
    assert current["ratio"] == 1.0
    assert body["overall"][KBU] == 1.0


def test_station_uptime_dia_sin_observaciones_es_null(client, uptime_db):
    now = datetime.now(timezone.utc)
    third_day = (now - timedelta(days=5)).replace(hour=0, minute=0, second=0, microsecond=0)
    _insert_uptime(uptime_db, _full_week(now, skip_day=third_day))

    resp = client.get(f"/analytics/station-uptime?days=7&bucket=day&channel={KBU}")

    assert resp.status_code == 200
    buckets = resp.json()["stations"][KBU]
    hueco = next(b for b in buckets if _parse_ts(b["bucket_start"]) == third_day)
    assert hueco["ratio"] is None
    assert hueco["observed_hours"] == 0
    assert all(b["ratio"] == 1.0 for b in buckets if b is not hueco)


def test_station_uptime_canal_mudo_en_hora_observada_es_cero_no_null(client, uptime_db):
    now = datetime.now(timezone.utc)
    h = _hour(-2, now)
    h1 = _hour(-1, now)
    _insert_uptime(
        uptime_db,
        [
            (MAJO, h, EXPECTED_COLUMNS_PER_HOUR),
            (MAJO, h1, EXPECTED_COLUMNS_PER_HOUR),
            (KBU, h, EXPECTED_COLUMNS_PER_HOUR),
        ],
    )

    resp = client.get("/analytics/station-uptime?days=1&bucket=hour")

    assert resp.status_code == 200
    body = resp.json()
    assert body["bucket"] == "hour"
    kbu = {_parse_ts(b["bucket_start"]): b for b in body["stations"][KBU]}
    assert kbu[h]["ratio"] == 1.0
    assert kbu[h1]["ratio"] == 0.0  # otro canal entregó: se miró y KBU estaba mudo
    assert kbu[h1]["observed_hours"] == 1
    assert kbu[_hour(-3, now)]["ratio"] is None  # nadie entregó: no se miró


def test_station_uptime_el_filtro_de_canal_no_cambia_que_es_hora_observada(client, uptime_db):
    """Pedir SOLO GE.KBU..BHZ no puede convertir el 0.0 de arriba en null: la
    hora sigue observada porque OTRO canal (no pedido) entregó."""
    now = datetime.now(timezone.utc)
    h = _hour(-2, now)
    h1 = _hour(-1, now)
    _insert_uptime(
        uptime_db,
        [(MAJO, h, 900), (MAJO, h1, 900), (KBU, h, 900)],
    )

    resp = client.get(f"/analytics/station-uptime?days=1&bucket=hour&channel={KBU}")

    assert resp.status_code == 200
    body = resp.json()
    assert set(body["stations"]) == {KBU}
    kbu = {_parse_ts(b["bucket_start"]): b for b in body["stations"][KBU]}
    assert kbu[h1]["ratio"] == 0.0


def test_station_uptime_canal_pedido_sin_filas_viene_todo_null(client, uptime_db):
    now = datetime.now(timezone.utc)
    _insert_uptime(uptime_db, [(MAJO, _hour(-1, now), 900)])

    resp = client.get("/analytics/station-uptime?days=1&channel=XX.NOPE..BHZ")

    assert resp.status_code == 200
    body = resp.json()
    assert all(b["ratio"] is None for b in body["stations"]["XX.NOPE..BHZ"])
    assert body["overall"]["XX.NOPE..BHZ"] is None


def test_station_uptime_days_mayor_a_14_fuerza_bucket_day(client, uptime_db):
    resp = client.get("/analytics/station-uptime?days=30&bucket=hour")
    assert resp.status_code == 200
    assert resp.json()["bucket"] == "day"


@pytest.mark.parametrize("days", [0, 366])
def test_station_uptime_days_fuera_de_rango_da_422(client, uptime_db, days):
    resp = client.get(f"/analytics/station-uptime?days={days}")
    assert resp.status_code == 422
    assert "detail" in resp.json()


def test_station_uptime_bucket_invalido_da_422(client, uptime_db):
    resp = client.get("/analytics/station-uptime?days=7&bucket=week")
    assert resp.status_code == 422


def test_station_uptime_la_historia_sobrevive_a_la_retencion(client, uptime_db):
    """Filas de hace 10 días (ya sin raw en spectrogram_columns): el ratio es
    numérico igual, porque la tabla plana no tiene retención."""
    now = datetime.now(timezone.utc)
    old_hour = _hour(-10 * 24, now)
    _insert_uptime(uptime_db, [(KBU, old_hour, EXPECTED_COLUMNS_PER_HOUR // 2)])

    resp = client.get(f"/analytics/station-uptime?days=14&bucket=day&channel={KBU}")

    assert resp.status_code == 200
    buckets = resp.json()["stations"][KBU]
    old_day = old_hour.replace(hour=0)
    viejo = next(b for b in buckets if _parse_ts(b["bucket_start"]) == old_day)
    assert viejo["ratio"] == 0.5
    assert viejo["observed_hours"] == 1
    assert viejo["expected"] == EXPECTED_COLUMNS_PER_HOUR
