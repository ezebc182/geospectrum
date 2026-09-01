"""Siembra los walls temáticos del mega wall (change mega-wall-estaciones-cuaderno).

Dos modos:

- `--smoke-test`: arma UN solo wall ("Prueba de humo — Mega Wall") con el
  subconjunto acotado de la Fase 4. Es el wall que se OBSERVA en producción
  antes de decidir si se avanza al catálogo completo (tarea 4.7/4.8).
- sin flag: arma un wall por región según `REGION_WALL_NAMES`, con TODAS las
  ciudades de ambos catálogos (Fase 5/6).

Los dos modos leen los DOS catálogos —`LIVE_CANDIDATES_BY_CITY` (rtserve) y
`LIVE_CANDIDATES_GEOFON_BY_CITY` (GEOFON)— y los mezclan en el mismo wall a
propósito: para el usuario del muro el servidor de origen es un detalle de
implementación, y la prueba de humo necesita ejercitar ambos ingestores bajo
la misma vista.

El agrupamiento y el empaquetado NO se reimplementan: se reusan `CITY_REGIONS`,
`CITY_LABELS` y `pack_groups_into_columns()` de wall_service, que son los
mismos que ya arman el wall "Global". Si un día cambia el criterio de
agrupamiento, cambia en un solo lugar.

Uso:
    python -m scripts.seed_thematic_walls --smoke-test --dry-run
    python -m scripts.seed_thematic_walls --smoke-test --owner <uuid>
    python -m scripts.seed_thematic_walls --owner <uuid>
"""

import argparse
import asyncio
import sys
from uuid import UUID

from src.services.spectrogram_service import (
    LIVE_CANDIDATES_BY_CITY,
    LIVE_CANDIDATES_GEOFON_BY_CITY,
)
from src.services.wall_service import (
    CITY_LABELS,
    CITY_REGIONS,
    MAX_WALL_CHANNELS,
    WallService,
    pack_groups_into_columns,
    validate_wall_layout,
)

SMOKE_TEST_WALL_NAME = "Prueba de humo — Mega Wall"

# Región (la de CITY_REGIONS) -> nombre del wall temático que la contiene.
#
# Arranca desglosado por continente en vez de agrupar "América" entera: las
# regiones de CITY_REGIONS ya vienen separadas en NORTEAMÉRICA /
# CENTROAMÉRICA Y CARIBE / SUDAMÉRICA, y unificarlas obligaría a volver a
# partirlas apenas el catálogo crezca (MAX_WALL_CHANNELS = 120). La Open
# Question del design.md se resuelve con el conteo real, y el conteo lo
# verifica `test_el_catalogo_real_produce_walls_validos`: si una agrupación
# se pasa de 120, ese test se pone rojo antes del deploy.
REGION_WALL_NAMES: dict[str, str] = {
    "NORTEAMÉRICA": "Mega Wall — Norteamérica",
    "CENTROAMÉRICA Y CARIBE": "Mega Wall — Centroamérica y Caribe",
    "SUDAMÉRICA": "Mega Wall — Sudamérica",
    "EUROPA-MEDITERRÁNEO": "Mega Wall — Europa y Mediterráneo",
    "ASIA-PACÍFICO": "Mega Wall — Asia-Pacífico",
    "OCEANÍA": "Mega Wall — Oceanía",
    "ÁFRICA Y MEDIO ORIENTE": "Mega Wall — África y Medio Oriente",
    # Toda ciudad sin región mapeada cae acá en vez de descartarse en
    # silencio: un wall visiblemente raro se arregla, una tira que nunca
    # aparece no se nota.
    "OTROS": "Mega Wall — Otros",
}

WALL_COLUMNS = 5  # mismo criterio denso que GLOBAL_WALL_COLUMNS


def _strips(catalogs: tuple[dict[str, list[str]], ...]) -> dict[str, list[dict]]:
    """Agrupa las ciudades de todos los catálogos por región.

    Una tira por ciudad = su canal PRIMARIO (candidates[0]), igual que
    `build_global_wall()`: el failover en vivo lo resuelve live-channels por
    debajo, no el layout guardado.
    """
    by_region: dict[str, list[dict]] = {}
    for catalog in catalogs:
        for city_id, candidates in catalog.items():
            if not candidates:
                continue
            region = CITY_REGIONS.get(city_id, "OTROS")
            by_region.setdefault(region, []).append(
                {"channel": candidates[0], "label": CITY_LABELS.get(city_id, city_id)}
            )
    return by_region


def _layout(groups: list[dict]) -> dict:
    return {
        "columns": [
            {"groups": col} for col in pack_groups_into_columns(groups, WALL_COLUMNS)
        ],
        "showMetrics": False,
    }


def build_smoke_test_wall(
    rtserve_catalog: dict[str, list[str]],
    geofon_catalog: dict[str, list[str]],
) -> dict:
    """UN wall con el subconjunto de humo, mezclando ambos servidores."""
    by_region = _strips((rtserve_catalog, geofon_catalog))
    if not by_region:
        raise ValueError(
            "el subconjunto de humo está vacío: no hay ninguna ciudad que sembrar"
        )
    groups = [
        {"title": region, "channels": sorted(chs, key=lambda c: c["label"])}
        for region, chs in sorted(by_region.items())
    ]
    return {"name": SMOKE_TEST_WALL_NAME, "layout": _layout(groups)}


def build_region_walls(
    rtserve_catalog: dict[str, list[str]],
    geofon_catalog: dict[str, list[str]],
) -> list[dict]:
    """Un wall por región según REGION_WALL_NAMES (Fase 5)."""
    by_region = _strips((rtserve_catalog, geofon_catalog))

    by_wall: dict[str, list[dict]] = {}
    for region, chs in by_region.items():
        wall_name = REGION_WALL_NAMES.get(region, REGION_WALL_NAMES["OTROS"])
        by_wall.setdefault(wall_name, []).append(
            {"title": region, "channels": sorted(chs, key=lambda c: c["label"])}
        )

    walls = []
    for wall_name, groups in sorted(by_wall.items()):
        total = sum(len(g["channels"]) for g in groups)
        if total > MAX_WALL_CHANNELS:
            raise ValueError(
                f"{wall_name} tiene {total} canales y el máximo es "
                f"{MAX_WALL_CHANNELS}: desglosar REGION_WALL_NAMES antes de sembrar"
            )
        walls.append({"name": wall_name, "layout": _layout(sorted(groups, key=lambda g: g["title"]))})
    return walls


def _print_layout(wall: dict) -> None:
    total = sum(
        len(g["channels"]) for col in wall["layout"]["columns"] for g in col["groups"]
    )
    print(f"\n=== {wall['name']}  ({total} canales, "
          f"{len(wall['layout']['columns'])} columnas)")
    for i, col in enumerate(wall["layout"]["columns"], 1):
        for group in col["groups"]:
            labels = ", ".join(c["label"] for c in group["channels"])
            print(f"  col{i}  {group['title']:28s} {len(group['channels']):2d}  {labels}")


async def _create(walls: list[dict], owner: UUID) -> None:
    import asyncpg

    # La INSTANCIA, no el módulo src.config.settings — el módulo no tiene
    # timescaledb_dsn y revienta con AttributeError (pasó en producción).
    from src.config.settings import settings

    pool = await asyncpg.create_pool(settings.timescaledb_dsn, min_size=1, max_size=2)
    try:
        service = WallService(pool)
        for wall in walls:
            created = await service.create(owner, wall["name"], wall["layout"])
            print(f"creado: {created.name}  id={created.id}")
    finally:
        await pool.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--smoke-test",
        action="store_true",
        help="arma solo el wall de prueba de humo (Fase 4) en vez de los "
             "walls por región (Fase 5/6)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="imprime el layout generado y NO escribe en la base",
    )
    parser.add_argument(
        "--owner",
        help="UUID del usuario dueño de los walls creados (obligatorio salvo "
             "en --dry-run)",
    )
    args = parser.parse_args(argv)

    if args.smoke_test:
        walls = [build_smoke_test_wall(LIVE_CANDIDATES_BY_CITY, LIVE_CANDIDATES_GEOFON_BY_CITY)]
    else:
        walls = build_region_walls(LIVE_CANDIDATES_BY_CITY, LIVE_CANDIDATES_GEOFON_BY_CITY)

    # Validar SIEMPRE, incluso en --dry-run: el sentido del dry-run es
    # descubrir acá lo que si no aparecería recién al insertar en producción.
    for wall in walls:
        validate_wall_layout(wall["layout"])
        _print_layout(wall)

    if args.dry_run:
        print(f"\n--dry-run: {len(walls)} wall(s) validados, nada escrito.")
        return 0

    if not args.owner:
        parser.error("--owner es obligatorio salvo con --dry-run")

    asyncio.run(_create(walls, UUID(args.owner)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
