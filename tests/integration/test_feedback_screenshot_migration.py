"""Migración 020 (`screenshot_key` en `feedback_reports`), contra Postgres REAL.

Molde: `tests/integration/test_feedback_migration.py`. El fixture `_migrated`
(tests/conftest.py) aplica el glob real de `deploy/sql/migrations/`, así que
la 020 entra por el mismo camino que en producción. La idempotencia se prueba
con una SEGUNDA ejecución real de `apply_migrations`, no releyendo el .sql a
mano — mismo criterio que la 019.
"""

import uuid
from pathlib import Path

import psycopg2
import pytest

from scripts import apply_migrations as applier

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPLOY_MIGRATIONS_DIR = REPO_ROOT / "deploy" / "sql" / "migrations"


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
    """INSERT directo con una fila válida por defecto; `overrides` pisa columnas."""
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
    user_id = _insert_user(_migrated, "feedback-screenshot-mig@example.com")
    yield user_id, _migrated
    conn = _connect(_migrated)
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM users")
            cur.execute("SELECT to_regclass('feedback_reports') IS NOT NULL")
            if cur.fetchone()[0]:
                cur.execute("DELETE FROM feedback_reports")
    finally:
        conn.close()


# --- (a) shape: columna text, nullable, sin default --------------------------


def test_screenshot_key_es_text_nullable_sin_default(_migrated):
    conn = _connect(_migrated)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT data_type, is_nullable, column_default "
                "FROM information_schema.columns "
                "WHERE table_name = 'feedback_reports' AND column_name = 'screenshot_key'"
            )
            row = cur.fetchone()
    finally:
        conn.close()
    assert row is not None, "la columna screenshot_key no existe"
    data_type, is_nullable, column_default = row
    assert data_type == "text"
    assert is_nullable == "YES"
    assert column_default is None


# --- (b) INSERT sin screenshot_key deja la columna en NULL -------------------


def test_insert_sin_screenshot_key_queda_null(reporter):
    user_id, dsn = reporter
    report_id = _insert_report(dsn, user_id)
    row = _fetch_one(dsn, "SELECT screenshot_key FROM feedback_reports WHERE id = %s", (report_id,))
    assert row == (None,)


# --- (c) INSERT con screenshot_key la persiste tal cual -----------------------


def test_insert_con_screenshot_key_la_persiste_tal_cual(reporter):
    user_id, dsn = reporter
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT gen_random_uuid()")
            generated_uuid = cur.fetchone()[0]
    finally:
        conn.close()
    key = f"feedback-screenshots/{generated_uuid}.png"
    report_id = _insert_report(dsn, user_id, screenshot_key=key)
    row = _fetch_one(dsn, "SELECT screenshot_key FROM feedback_reports WHERE id = %s", (report_id,))
    assert row == (key,)


# --- (d) segunda aplicación de la migración 020 es no-op ---------------------


async def test_segunda_aplicacion_de_la_migracion_020_es_no_op(reporter, monkeypatch):
    user_id, dsn = reporter
    report_id = _insert_report(dsn, user_id, screenshot_key="feedback-screenshots/sobrevive.png")

    monkeypatch.setattr(applier, "MIGRATION_DIRS", (DEPLOY_MIGRATIONS_DIR,))
    assert any(p.name.startswith("020_") for p in applier.collect_migration_files())

    await applier.apply_migrations(dsn)

    row = _fetch_one(dsn, "SELECT screenshot_key FROM feedback_reports WHERE id = %s", (report_id,))
    assert row == ("feedback-screenshots/sobrevive.png",)
