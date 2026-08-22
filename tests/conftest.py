"""Fixtures compartidas por toda la suite (unit + integration).

Acá viven los fixtures de Postgres REAL. Estaban en tests/integration/conftest.py
y se subieron un nivel porque los tests de email-invitations (Fase 4) los
necesitan desde tests/unit/: la lección documentada del proyecto es que los
mocks de asyncpg son CIEGOS a los errores de SQL y de concurrencia (validan que
se llame al pool, no que la query corra contra un motor real), y el consumo
single-use de invitaciones es exactamente el tipo de invariante que sólo se
puede verificar con un Postgres de verdad serializando dos transacciones.

pytest resuelve conftest.py por jerarquía de directorios: al estar en tests/,
estos fixtures quedan visibles tanto para tests/unit/ como para
tests/integration/ sin duplicar el container (scope de sesión: uno solo para
toda la corrida).
"""

import json
import sys
from pathlib import Path

import asyncpg
import pytest
from testcontainers.postgres import PostgresContainer

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "deploy" / "sql" / "migrations"


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
    """Corre TODAS las migraciones y siembra el catálogo de áreas, una vez.

    Sincrónico y con psycopg2 (ya pineado en requirements.txt, no se agrega
    una dependencia nueva sólo para esto): los archivos .sql traen varias
    sentencias cada uno y psycopg2 los ejecuta de una sin partirlos a mano.
    Las migraciones se aplican en orden alfabético, que es el orden numérico
    con el que están nombradas (001_..., 002_...) — la 007 de invitaciones
    entra sola por estar en el mismo directorio.
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

    Limpia usuarios e invitaciones al terminar cada test (y las áreas NO del
    sistema, que cuelgan de los usuarios por owner_id). Los presets del
    sistema se conservan: los siembra _migrated una sola vez por sesión.

    `invitations` se limpia ANTES que `users` por las FKs invited_by/
    accepted_by (ON DELETE SET NULL no exige el orden, pero borrar primero lo
    que cuelga deja el estado explícito y no depende de la política de la FK).
    """
    pool = await asyncpg.create_pool(_migrated, min_size=1, max_size=8)
    try:
        yield pool
    finally:
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM invitations")
            await conn.execute("DELETE FROM walls")
            await conn.execute("DELETE FROM areas_of_interest WHERE NOT is_system")
            await conn.execute("DELETE FROM users")
            # seismic_events no cuelga de users (los eventos son globales y
            # públicos, sin owner), pero se limpia igual: un test que persiste
            # sismos no debe filtrarlos al siguiente.
            await conn.execute("DELETE FROM seismic_events")
        await pool.close()


@pytest.fixture
async def event_store(_migrated):
    """EventStore contra la base real (PR-W4).

    Store propio y no `db_pool`: EventStore administra su pool con connect()/
    close(), que es justo lo que hay que ejercitar. La limpieza va al final
    porque el store crea filas sin owner y no las alcanza ningún CASCADE.
    """
    from src.services.event_store import EventStore

    store = EventStore(_migrated)
    await store.connect()
    try:
        yield store
    finally:
        await store.pool.execute("DELETE FROM seismic_events")
        await store.close()
