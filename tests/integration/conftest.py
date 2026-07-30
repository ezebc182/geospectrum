"""Fixtures compartidas para tests de integracion."""
import json
import sys
from pathlib import Path

import asyncpg
import pytest
import redis.asyncio as aioredis
from testcontainers.postgres import PostgresContainer
from testcontainers.redis import RedisContainer

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "deploy" / "sql" / "migrations"


@pytest.fixture(scope="session")
def redis_container():
    container = RedisContainer("redis:7-alpine")
    container.start()
    yield container
    container.stop()


@pytest.fixture(scope="session")
def redis_url(redis_container):
    host = redis_container.get_container_host_ip()
    port = redis_container.get_exposed_port(6379)
    return f"redis://{host}:{port}/0"


@pytest.fixture
async def redis_client(redis_url):
    client = aioredis.from_url(redis_url, decode_responses=True)
    await client.flushdb()
    yield client
    await client.flushdb()
    await client.aclose()


# ---------------------------------------------------------------------------
# Postgres (AOI-1)
#
# Hasta acá el proyecto mockeaba Postgres siempre y usaba testcontainers sólo
# para Redis. Los mocks resultaron CIEGOS para los errores de SQL: validan que
# se llame al pool, no que la query sea correcta contra un motor real. Estos
# fixtures levantan Postgres de verdad, corren las migraciones y siembran el
# catálogo, que es la única forma de que un test note un nombre de columna mal
# escrito o un JOIN que no devuelve lo que uno cree.
#
# La imagen es postgres a secas, no timescaledb: las tablas de AOI-1 y de auth
# son relacionales comunes y no usan hypertables. Traer TimescaleDB acá sería
# una imagen mucho más pesada por features que estos tests no ejercitan.
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def postgres_container():
    """Postgres real para los tests que tocan SQL. Scope de sesión: arrancar un
    container por test haría la suite inusablemente lenta."""
    container = PostgresContainer("postgres:16-alpine")
    container.start()
    yield container
    container.stop()


@pytest.fixture(scope="session")
def postgres_dsn(postgres_container):
    """DSN en el formato que espera asyncpg.

    testcontainers arma la URL con el driver de SQLAlchemy
    (postgresql+psycopg2://), que asyncpg no entiende: hay que normalizarla.
    """
    url = postgres_container.get_connection_url()
    return url.replace("postgresql+psycopg2://", "postgresql://")


@pytest.fixture(scope="session")
def _migrated(postgres_dsn):
    """Corre las migraciones 001-006 y siembra el catálogo de áreas, una vez.

    Sincrónico y con psycopg2 (ya pineado en requirements.txt, no se agrega
    una dependencia nueva sólo para esto): los archivos .sql traen varias
    sentencias cada uno y psycopg2 los ejecuta de una sin partirlos a mano.
    Las migraciones se aplican en orden alfabético, que es el orden numérico
    con el que están nombradas (001_..., 002_...).
    """
    import psycopg2

    conn = psycopg2.connect(postgres_dsn)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
                cur.execute(path.read_text())
    finally:
        conn.close()

    # El catálogo se importa del script real (no se duplica acá) para que el
    # día que cambien las áreas, los tests usen el mismo catálogo que la base
    # de producción y no una copia que quedó vieja.
    sys.path.insert(0, str(REPO_ROOT))
    from scripts.seed_areas_of_interest import UPSERT_SQL, load_catalog

    catalog = load_catalog()
    # UPSERT_SQL trae placeholders de asyncpg ($1..$7) y psycopg2 espera %s.
    # Se reemplaza de mayor a menor para que $1 no coma el prefijo de un $1x
    # si el día de mañana la query pasa de 9 parámetros.
    upsert_pg2 = UPSERT_SQL
    for n in range(9, 0, -1):
        upsert_pg2 = upsert_pg2.replace(f"${n}", "%s")

    conn = psycopg2.connect(postgres_dsn)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            for area in catalog["areas"]:
                bbox = area["bbox"]
                cur.execute(
                    upsert_pg2,
                    (
                        area["slug"],
                        area["name"],
                        json.dumps(area["geometry"]),
                        bbox["minlat"],
                        bbox["maxlat"],
                        bbox["minlon"],
                        bbox["maxlon"],
                    ),
                )
    finally:
        conn.close()
    return postgres_dsn


@pytest.fixture
async def db_pool(_migrated):
    """Pool de asyncpg contra la base ya migrada y sembrada.

    Limpia los usuarios al terminar cada test (y las áreas NO del sistema, que
    cuelgan de ellos por owner_id). Los presets del sistema se conservan: los
    siembra _migrated una sola vez por sesión.
    """
    pool = await asyncpg.create_pool(_migrated, min_size=1, max_size=4)
    try:
        yield pool
    finally:
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM areas_of_interest WHERE NOT is_system")
            await conn.execute("DELETE FROM users")
        await pool.close()
