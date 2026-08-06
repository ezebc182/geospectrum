"""
Runner de migraciones SQL — idempotente por diseño, seguro de correr siempre.

La convención del proyecto (ver deploy/sql/migrations/007) es que TODA
migración es idempotente (CREATE ... IF NOT EXISTS, backfills condicionales),
sin Alembic ni tabla de versiones. Eso permite el mecanismo más simple que
existe: aplicar TODOS los archivos en orden en cada arranque/deploy — las ya
aplicadas son no-ops.

Concurrencia: pg_advisory_lock a nivel sesión. Si Railway levanta dos
réplicas (o un redeploy solapa contenedores), una espera a la otra en vez de
ejecutar el mismo DDL en paralelo. El lock se libera al cerrar la conexión.

Usos:
- En el arranque de la API (src/main.py, gateado por RUN_MIGRATIONS_ON_STARTUP).
- Manual: `python -m scripts.apply_migrations` (usa TIMESCALEDB_* del entorno,
  igual que la API).
"""

import asyncio
import logging
from pathlib import Path

import asyncpg

logger = logging.getLogger(__name__)

# Raíz del repo (y del contenedor: /app). Los dos directorios de migraciones
# se aplican en este orden: el schema de producto/auth primero, el de
# spectrogramas después — no tienen dependencias cruzadas, pero un orden
# determinístico hace los deploys reproducibles.
_ROOT = Path(__file__).resolve().parent.parent
MIGRATION_DIRS = (
    _ROOT / "deploy" / "sql" / "migrations",
    _ROOT / "db" / "migrations",
)

# Clave arbitraria pero FIJA del advisory lock: identifica "migraciones de
# geospectrum" en toda la base. Cambiarla rompería la exclusión mutua entre
# versiones viejas y nuevas del código durante un redeploy.
_MIGRATIONS_LOCK_KEY = 0x6E05_5E15


def collect_migration_files() -> list[Path]:
    """Archivos .sql en orden de aplicación (por directorio, luego por nombre)."""
    files: list[Path] = []
    for directory in MIGRATION_DIRS:
        if directory.is_dir():
            files.extend(sorted(directory.glob("*.sql")))
    return files


async def apply_migrations(dsn: str) -> None:
    """Aplica todas las migraciones. Lanza si alguna falla: el caller decide
    si eso aborta el arranque (la API lo hace — fail-fast, como con
    AUTH_SECRET_KEY)."""
    files = collect_migration_files()
    if not files:
        logger.warning("No se encontraron archivos de migración en %s", MIGRATION_DIRS)
        return

    conn = await asyncpg.connect(dsn)
    try:
        await conn.execute("SELECT pg_advisory_lock($1)", _MIGRATIONS_LOCK_KEY)
        for path in files:
            logger.info("Aplicando migración %s", path.name)
            await conn.execute(path.read_text(encoding="utf-8"))
        logger.info("Migraciones al día (%d archivos)", len(files))
    finally:
        # Cerrar la conexión libera el advisory lock de sesión.
        await conn.close()


def _main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    # Import local para que el módulo sea importable sin settings cargados
    # (la API ya tiene su propio settings cuando llama a apply_migrations()).
    from src.config.settings import settings

    dsn = settings.timescaledb_dsn
    if dsn is None:
        raise SystemExit("TIMESCALEDB_HOST/USER/PASSWORD no configurados — no hay DSN")

    asyncio.run(apply_migrations(dsn))


if __name__ == "__main__":
    _main()
