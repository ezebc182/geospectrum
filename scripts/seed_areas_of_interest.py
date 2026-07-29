#!/usr/bin/env python3
"""
Carga el catálogo curado de áreas de interés en la base (AOI-1).

    venv/bin/python scripts/seed_areas_of_interest.py            # aplica
    venv/bin/python scripts/seed_areas_of_interest.py --dry-run  # sólo muestra

Lee deploy/sql/seeds/areas_of_interest.json, que genera
scripts/build_areas_of_interest.py. Correr el build primero si se tocó el
catálogo: este script NO regenera el JSON, sólo lo carga.

Requisitos: migración 006 aplicada y TimescaleDB corriendo (puerto 5433 en el
docker-compose de deploy/, no el 5432 del Postgres nativo de macOS).

Idempotente
-----------
UPSERT por slug sobre el índice parcial idx_aoi_system_slug (que sólo cubre
`WHERE is_system`). Re-ejecutarlo actualiza geometría y bbox de los presets
existentes en vez de duplicarlos, así que es seguro correrlo cada vez que
cambia el catálogo.

Lo que NO hace, a propósito:

  - No borra presets que ya no estén en el JSON. Un preset puede ser el
    `active_area_id` de un usuario; borrarlo en silencio le cambiaría el área
    activa por debajo. Si hay que retirar uno, se hace deliberadamente y
    mirando quién lo tiene activo, no como efecto colateral de un seed.
  - No toca áreas de usuario (`is_system = false`). El WHERE de todas las
    queries lo garantiza.

Por qué UPSERT y no DELETE + INSERT: un DELETE dispararía el ON DELETE SET NULL
de users.active_area_id y resetearía la selección de todos los usuarios que
tuvieran un preset activo, en cada corrida del seed.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

import asyncpg  # noqa: E402  (después del sys.path para que src/ sea importable)

from src.config.settings import settings  # noqa: E402
from src.services.area_service import DEFAULT_AREA_SLUG  # noqa: E402

SEED_PATH = REPO_ROOT / "deploy" / "sql" / "seeds" / "areas_of_interest.json"

UPSERT_SQL = """
INSERT INTO areas_of_interest
    (slug, name, owner_id, is_system, geometry,
     bbox_minlat, bbox_maxlat, bbox_minlon, bbox_maxlon)
VALUES ($1, $2, NULL, true, $3::jsonb, $4, $5, $6, $7)
ON CONFLICT (slug) WHERE is_system DO UPDATE SET
    name        = EXCLUDED.name,
    geometry    = EXCLUDED.geometry,
    bbox_minlat = EXCLUDED.bbox_minlat,
    bbox_maxlat = EXCLUDED.bbox_maxlat,
    bbox_minlon = EXCLUDED.bbox_minlon,
    bbox_maxlon = EXCLUDED.bbox_maxlon,
    updated_at  = now()
RETURNING (xmax = 0) AS inserted
"""


def load_catalog() -> dict:
    """Lee el JSON generado, verificando que el default declarado sea el que
    espera el service.

    Si `default_slug` del catálogo y DEFAULT_AREA_SLUG de area_service.py se
    desincronizan, get_default() levanta DefaultAreaMissingError en runtime y
    el feature entero deja de funcionar. Detectarlo acá es infinitamente más
    barato que en un 500 en producción.
    """
    if not SEED_PATH.exists():
        raise SystemExit(
            f"no existe {SEED_PATH.relative_to(REPO_ROOT)}\n"
            "generalo con: python3 scripts/build_areas_of_interest.py"
        )

    catalog = json.loads(SEED_PATH.read_text())

    declared = catalog.get("default_slug")
    if declared != DEFAULT_AREA_SLUG:
        raise SystemExit(
            f"el catálogo declara default_slug={declared!r} pero "
            f"src/services/area_service.py espera {DEFAULT_AREA_SLUG!r}.\n"
            "Los dos tienen que coincidir o get_default() falla en runtime."
        )

    slugs = {area["slug"] for area in catalog["areas"]}
    if DEFAULT_AREA_SLUG not in slugs:
        raise SystemExit(
            f"el catálogo no incluye el preset por defecto {DEFAULT_AREA_SLUG!r}"
        )

    return catalog


async def seed(dry_run: bool) -> None:
    catalog = load_catalog()
    areas = catalog["areas"]
    print(f"catálogo: {len(areas)} áreas (default: {DEFAULT_AREA_SLUG})")

    if dry_run:
        for area in areas:
            bbox = area["bbox"]
            print(
                f"  {area['slug']:28} {area['geometry']['type']:13} "
                f"lat[{bbox['minlat']:>7.2f},{bbox['maxlat']:>7.2f}] "
                f"lon[{bbox['minlon']:>8.2f},{bbox['maxlon']:>8.2f}]"
            )
        print("\n--dry-run: no se escribió nada")
        return

    dsn = settings.timescaledb_dsn
    if dsn is None:
        raise SystemExit(
            "falta la config de TimescaleDB — configurá "
            "TIMESCALEDB_HOST/USER/PASSWORD (ver src/config/settings.py)"
        )

    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
    try:
        inserted = updated = 0
        # Una transacción para todo el catálogo: si un área falla, no queda un
        # seed a medias con presets inconsistentes.
        async with pool.acquire() as conn, conn.transaction():
            for area in areas:
                bbox = area["bbox"]
                row = await conn.fetchrow(
                    UPSERT_SQL,
                    area["slug"],
                    area["name"],
                    json.dumps(area["geometry"]),
                    bbox["minlat"],
                    bbox["maxlat"],
                    bbox["minlon"],
                    bbox["maxlon"],
                )
                if row["inserted"]:
                    inserted += 1
                    print(f"  + {area['slug']}")
                else:
                    updated += 1
                    print(f"  ~ {area['slug']}")

        print(f"\n{inserted} insertadas, {updated} actualizadas")

        total = await pool.fetchval(
            "SELECT count(*) FROM areas_of_interest WHERE is_system"
        )
        print(f"presets del sistema en la base: {total}")
    finally:
        await pool.close()


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    asyncio.run(seed(dry_run))


if __name__ == "__main__":
    main()
