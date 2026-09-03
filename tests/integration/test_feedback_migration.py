"""Migración 019 (`feedback_reports`), contra Postgres REAL.

El fixture `_migrated` (tests/conftest.py) aplica el glob real de
`deploy/sql/migrations/`, así que la 019 entra por el mismo camino que en
producción — no por un `CREATE TABLE` copiado a mano al test. Los `CHECK` se
prueban con SQL directo (psycopg2): es la base la que tiene que rechazar, no
la API, que todavía no existe en esta fase.

La idempotencia se prueba con una SEGUNDA ejecución del aplicador de verdad
(`scripts/apply_migrations.apply_migrations`), no re-leyendo el .sql a mano.
Se lo apunta solo a `deploy/sql/migrations/`: el otro directorio del aplicador
(`db/migrations/`) crea hypertables con `create_hypertable`, que exige la
extensión TimescaleDB y el testcontainer es `postgres:16-alpine` pelado. Ese
recorte no cambia lo que se verifica acá: la 019 vive en el directorio que sí
se aplica dos veces.
"""

import uuid
from pathlib import Path

import psycopg2
import psycopg2.errors
import pytest

from scripts import apply_migrations as applier

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPLOY_MIGRATIONS_DIR = REPO_ROOT / "deploy" / "sql" / "migrations"

EXPECTED_COLUMNS = {
    "id",
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
}

VALID_STATUSES = ("new", "in_analysis", "in_progress", "done", "discarded")


def _connect(dsn: str):
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    return conn


def _insert_user(dsn: str, email: str) -> uuid.UUID:
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (email, password_hash, role) VALUES (%s, %s, 'viewer') "
                "RETURNING id",
                (email, "$2b$12$hash-irrelevante"),
            )
            return cur.fetchone()[0]
    finally:
        conn.close()


def _insert_report(dsn: str, user_id: uuid.UUID, **overrides) -> uuid.UUID:
    """INSERT directo con una fila válida por defecto; `overrides` pisa columnas
    para provocar cada violación de CHECK."""
    row = {
        "user_id": user_id,
        "type": "bug",
        "body": "El helicorder no carga",
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
            return cur.fetchone()[0]
    finally:
        conn.close()


def _fetch_one(dsn: str, sql: str, params=()):
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone()
    finally:
        conn.close()


@pytest.fixture
def reporter(_migrated):
    """Un usuario para colgar reportes; limpia reportes y usuarios al salir."""
    user_id = _insert_user(_migrated, "feedback-mig@example.com")
    yield user_id, _migrated
    conn = _connect(_migrated)
    try:
        with conn.cursor() as cur:
            # Primero los usuarios (la cascada se lleva sus reportes) y después
            # la tabla de reportes, solo si existe: en el RED de la 1.2 todavía
            # no está creada y la limpieza no puede dejar el usuario colgado para
            # el test siguiente (UniqueViolation por email repetido).
            cur.execute("DELETE FROM users")
            cur.execute("SELECT to_regclass('feedback_reports') IS NOT NULL")
            if cur.fetchone()[0]:
                cur.execute("DELETE FROM feedback_reports")
    finally:
        conn.close()


# --- (a) shape --------------------------------------------------------------


def test_la_tabla_existe_con_las_doce_columnas_del_design(_migrated):
    conn = _connect(_migrated)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'feedback_reports'"
            )
            columns = {row[0] for row in cur.fetchall()}
    finally:
        conn.close()
    assert columns == EXPECTED_COLUMNS


# --- (b) defaults y nullabilidad reconciliados -------------------------------


def test_status_tiene_default_new_y_status_changed_at_nace_null_sin_default(_migrated):
    conn = _connect(_migrated)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT column_name, column_default, is_nullable "
                "FROM information_schema.columns "
                "WHERE table_name = 'feedback_reports' "
                "AND column_name IN ('status', 'status_changed_at', 'created_at')"
            )
            meta = {row[0]: (row[1], row[2]) for row in cur.fetchall()}
    finally:
        conn.close()

    assert meta["status"][1] == "NO"
    assert meta["status"][0] == "'new'::text"
    # Punto 3 de la reconciliación: nullable y SIN default (nace null, el
    # primer movimiento lo setea).
    assert meta["status_changed_at"] == (None, "YES")
    assert meta["created_at"] == ("now()", "NO")


def test_una_fila_recien_insertada_nace_en_new_sin_comentario_ni_movimiento(reporter):
    user_id, dsn = reporter
    report_id = _insert_report(dsn, user_id)
    row = _fetch_one(
        dsn,
        "SELECT status, status_changed_at, admin_comment, admin_comment_updated_at, "
        "created_at IS NOT NULL FROM feedback_reports WHERE id = %s",
        (report_id,),
    )
    assert row == ("new", None, None, None, True)


# --- (c) idempotencia REAL: segunda corrida del aplicador ---------------------


async def test_segunda_ejecucion_del_aplicador_es_no_op_y_conserva_las_filas(reporter, monkeypatch):
    user_id, dsn = reporter
    report_id = _insert_report(dsn, user_id, body="sobrevive a la segunda corrida")

    monkeypatch.setattr(applier, "MIGRATION_DIRS", (DEPLOY_MIGRATIONS_DIR,))
    assert any(p.name.startswith("019_") for p in applier.collect_migration_files())

    await applier.apply_migrations(dsn)

    row = _fetch_one(dsn, "SELECT body, status FROM feedback_reports WHERE id = %s", (report_id,))
    assert row == ("sobrevive a la segunda corrida", "new")


# --- (d) los CHECK rechazan por SQL directo ----------------------------------


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param({"type": "question"}, id="type-fuera-del-enum"),
        pytest.param({"body": ""}, id="body-vacio"),
        pytest.param({"body": "x" * 2001}, id="body-2001"),
        pytest.param({"route": "/" + "r" * 300}, id="route-301"),
        pytest.param({"url": "https://" + "u" * 1993}, id="url-2001"),
        pytest.param({"user_agent": "a" * 401}, id="user-agent-401"),
        pytest.param({"status": "pending"}, id="status-pending"),
        pytest.param(
            {"admin_comment": "c" * 2001, "admin_comment_updated_at": "2026-09-03T00:00:00Z"},
            id="admin-comment-2001",
        ),
        pytest.param({"admin_comment": "texto sin timestamp"}, id="par-roto-sin-timestamp"),
        pytest.param(
            {"admin_comment_updated_at": "2026-09-03T00:00:00Z"},
            id="par-roto-sin-texto",
        ),
    ],
)
def test_los_check_rechazan_la_fila_invalida(reporter, overrides):
    user_id, dsn = reporter
    # Sanidad del caso: el valor mutado excede el límite de verdad.
    for key, limit in (("route", 300), ("url", 2000), ("user_agent", 400)):
        if key in overrides:
            assert len(overrides[key]) == limit + 1
    with pytest.raises(psycopg2.errors.CheckViolation):
        _insert_report(dsn, user_id, **overrides)
    assert _fetch_one(dsn, "SELECT count(*) FROM feedback_reports") == (0,)


def test_un_update_a_un_estado_fuera_de_los_cinco_es_rechazado(reporter):
    user_id, dsn = reporter
    report_id = _insert_report(dsn, user_id)
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur, pytest.raises(psycopg2.errors.CheckViolation):
            cur.execute(
                "UPDATE feedback_reports SET status = 'pending' WHERE id = %s", (report_id,)
            )
    finally:
        conn.close()
    assert _fetch_one(dsn, "SELECT status FROM feedback_reports WHERE id = %s", (report_id,)) == (
        "new",
    )


def test_los_cinco_estados_validos_son_aceptados(reporter):
    user_id, dsn = reporter
    for status in VALID_STATUSES:
        _insert_report(dsn, user_id, status=status)
    assert _fetch_one(dsn, "SELECT count(*) FROM feedback_reports") == (len(VALID_STATUSES),)


def test_los_valores_en_el_limite_son_aceptados(reporter):
    user_id, dsn = reporter
    _insert_report(
        dsn,
        user_id,
        body="b" * 2000,
        route="r" * 300,
        url="u" * 2000,
        user_agent="a" * 400,
        admin_comment="c" * 2000,
        admin_comment_updated_at="2026-09-03T00:00:00Z",
    )
    assert _fetch_one(dsn, "SELECT count(*) FROM feedback_reports") == (1,)


# --- (1.4) cascada -----------------------------------------------------------


def test_borrar_usuario_borra_sus_reportes_en_cascada(reporter):
    user_id, dsn = reporter
    other_id = _insert_user(dsn, "feedback-mig-otro@example.com")
    _insert_report(dsn, user_id, body="primero")
    _insert_report(dsn, user_id, body="segundo")
    survivor_id = _insert_report(dsn, other_id, body="de otro usuario")
    assert _fetch_one(dsn, "SELECT count(*) FROM feedback_reports") == (3,)

    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (user_id,))
    finally:
        conn.close()

    assert _fetch_one(
        dsn, "SELECT count(*) FROM feedback_reports WHERE user_id = %s", (user_id,)
    ) == (0,)
    # La cascada es por usuario, no un TRUNCATE encubierto: el reporte ajeno sigue.
    assert _fetch_one(dsn, "SELECT id FROM feedback_reports") == (survivor_id,)
    # Sin huérfanos: toda fila restante apunta a un usuario que existe.
    assert _fetch_one(
        dsn,
        "SELECT count(*) FROM feedback_reports r "
        "LEFT JOIN users u ON u.id = r.user_id WHERE u.id IS NULL",
    ) == (0,)
