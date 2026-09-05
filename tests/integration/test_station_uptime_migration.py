"""Migración 021 (`station_uptime_hourly`), contra Postgres REAL.

Molde: `tests/integration/test_feedback_screenshot_migration.py`. El fixture
`_migrated` (tests/conftest.py) aplica el glob completo de
`deploy/sql/migrations/` (…020 + 021), así que la tabla entra por el mismo
camino que en producción. La idempotencia se prueba con una SEGUNDA
ejecución real de `apply_migrations` con una fila sembrada entre corridas,
no releyendo el .sql a mano — mismo criterio que la 019 y la 020.
"""

from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2
import pytest

from scripts import apply_migrations as applier

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPLOY_MIGRATIONS_DIR = REPO_ROOT / "deploy" / "sql" / "migrations"

TABLE = "station_uptime_hourly"


def _connect(dsn: str):
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    return conn


def _fetch_all(dsn: str, sql: str, params=()):
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    finally:
        conn.close()


def _execute(dsn: str, sql: str, params=()):
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
    finally:
        conn.close()


@pytest.fixture
def clean_table(_migrated):
    """Deja la tabla vacía al entrar y al salir: el rollup (otro test) y este
    comparten la base de sesión y ninguno debe heredar filas del otro."""
    _execute(_migrated, f"DELETE FROM {TABLE}")
    yield _migrated
    _execute(_migrated, f"DELETE FROM {TABLE}")


# --- (a) shape: columnas NOT NULL con sus tipos y PK compuesta ---------------


def test_tabla_con_columnas_y_tipos_exactos(_migrated):
    rows = _fetch_all(
        _migrated,
        "SELECT column_name, data_type, is_nullable "
        "FROM information_schema.columns WHERE table_name = %s "
        "ORDER BY ordinal_position",
        (TABLE,),
    )
    assert rows, f"la tabla {TABLE} no existe"
    assert rows == [
        ("channel", "text", "NO"),
        ("bucket_start", "timestamp with time zone", "NO"),
        ("columns_count", "integer", "NO"),
    ]


def test_primary_key_es_channel_y_bucket_start(_migrated):
    rows = _fetch_all(
        _migrated,
        "SELECT kcu.column_name "
        "FROM information_schema.table_constraints tc "
        "JOIN information_schema.key_column_usage kcu "
        "  ON tc.constraint_name = kcu.constraint_name "
        " AND tc.table_schema = kcu.table_schema "
        "WHERE tc.table_name = %s AND tc.constraint_type = 'PRIMARY KEY' "
        "ORDER BY kcu.ordinal_position",
        (TABLE,),
    )
    assert [r[0] for r in rows] == ["channel", "bucket_start"]


# --- (b) CHECK: un conteo negativo no entra ----------------------------------


def test_columns_count_negativo_viola_el_check(clean_table):
    dsn = clean_table
    with pytest.raises(psycopg2.errors.CheckViolation):
        _execute(
            dsn,
            f"INSERT INTO {TABLE} (channel, bucket_start, columns_count) VALUES (%s, %s, %s)",
            ("GE.KBU..BHZ", datetime(2026, 9, 4, 12, tzinfo=timezone.utc), -1),
        )
    assert _fetch_all(dsn, f"SELECT count(*) FROM {TABLE}") == [(0,)]


# --- (c) índice por bucket_start para la lectura por rango --------------------


def test_existe_el_indice_por_bucket_start(_migrated):
    rows = _fetch_all(
        _migrated,
        "SELECT indexname FROM pg_indexes WHERE tablename = %s AND indexname = %s",
        (TABLE, "idx_station_uptime_hourly_bucket"),
    )
    assert rows == [("idx_station_uptime_hourly_bucket",)]


# --- (d) segunda aplicación de la migración 021 es no-op ---------------------


async def test_segunda_aplicacion_de_la_migracion_021_es_no_op(clean_table, monkeypatch):
    dsn = clean_table
    bucket = datetime(2026, 9, 1, 3, tzinfo=timezone.utc)
    _execute(
        dsn,
        f"INSERT INTO {TABLE} (channel, bucket_start, columns_count) VALUES (%s, %s, %s)",
        ("GE.KBU..BHZ", bucket, 900),
    )

    monkeypatch.setattr(applier, "MIGRATION_DIRS", (DEPLOY_MIGRATIONS_DIR,))
    assert any(p.name.startswith("021_") for p in applier.collect_migration_files())

    await applier.apply_migrations(dsn)

    rows = _fetch_all(dsn, f"SELECT channel, bucket_start, columns_count FROM {TABLE}")
    assert rows == [("GE.KBU..BHZ", bucket, 900)]
    # La segunda corrida tampoco duplica el índice ni cambia la PK.
    assert _fetch_all(
        dsn,
        "SELECT count(*) FROM pg_indexes WHERE tablename = %s",
        (TABLE,),
    ) == [(2,)]  # PK + idx_station_uptime_hourly_bucket


# --- (e) la PK compuesta admite dos horas distintas del mismo canal ----------


def test_dos_horas_del_mismo_canal_conviven(clean_table):
    dsn = clean_table
    h = datetime(2026, 9, 4, 10, tzinfo=timezone.utc)
    for offset, count in ((0, 900), (1, 450)):
        _execute(
            dsn,
            f"INSERT INTO {TABLE} (channel, bucket_start, columns_count) VALUES (%s, %s, %s)",
            ("GE.KBU..BHZ", h + timedelta(hours=offset), count),
        )
    rows = _fetch_all(dsn, f"SELECT bucket_start, columns_count FROM {TABLE} ORDER BY 1")
    assert rows == [(h, 900), (h + timedelta(hours=1), 450)]
