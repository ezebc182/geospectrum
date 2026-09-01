"""Muro default "Global" estilo SPECTRONET.

El agrupamiento por región no existe como dato en los catálogos (solo como
comentarios en spectrogram_service.py): acá se materializa. Una tira por
ciudad = su canal primario (LIVE_CANDIDATES_BY_CITY[city][0]); el failover
en vivo lo sigue resolviendo live-channels por debajo.
"""

import json
import re
from uuid import UUID

import asyncpg

from src.models.wall import WallPublic
from src.services.spectrogram_service import LIVE_CANDIDATES_BY_CITY

# city_id -> región (títulos en mayúsculas, como las etiquetas de SPECTRONET)
CITY_REGIONS: dict[str, str] = {
    "tokyo": "ASIA-PACÍFICO", "osaka": "ASIA-PACÍFICO", "taipei": "ASIA-PACÍFICO",
    "guam": "ASIA-PACÍFICO", "kathmandu": "ASIA-PACÍFICO",
    "lima": "SUDAMÉRICA", "arequipa": "SUDAMÉRICA", "santiago": "SUDAMÉRICA",
    "valparaiso": "SUDAMÉRICA", "antofagasta": "SUDAMÉRICA",
    "quito": "SUDAMÉRICA", "bogota": "SUDAMÉRICA",
    "mexicocity": "CENTROAMÉRICA Y CARIBE", "sanjose": "CENTROAMÉRICA Y CARIBE",
    "managua": "CENTROAMÉRICA Y CARIBE", "portauprince": "CENTROAMÉRICA Y CARIBE",
    "losangeles": "NORTEAMÉRICA", "sandiego": "NORTEAMÉRICA",
    "sanfrancisco": "NORTEAMÉRICA", "portland": "NORTEAMÉRICA",
    "seattle": "NORTEAMÉRICA", "vancouver": "NORTEAMÉRICA", "anchorage": "NORTEAMÉRICA",
    "istanbul": "EUROPA-MEDITERRÁNEO",
    "wellington": "OCEANÍA", "auckland": "OCEANÍA", "christchurch": "OCEANÍA",
    # Mega wall (Fase 4, 2026-09-01): las tres zonas GEOFON ya deployadas más
    # el subconjunto de prueba de humo. santaelena y madagascar van a "OTROS"
    # EXPLÍCITO: no hay región que les quepa y dejarlas caer al fallback
    # escondería la decisión.
    "salta": "SUDAMÉRICA", "sanjuan": "SUDAMÉRICA", "ushuaia": "SUDAMÉRICA",
    "merida": "SUDAMÉRICA",
    "aguadilla": "CENTROAMÉRICA Y CARIBE", "santarosalia": "CENTROAMÉRICA Y CARIBE",
    "tuxtla": "CENTROAMÉRICA Y CARIBE",
    "mountshasta": "NORTEAMÉRICA", "longvalley": "NORTEAMÉRICA",
    "mountrainier": "NORTEAMÉRICA", "sthelens": "NORTEAMÉRICA",
    "yellowstone": "NORTEAMÉRICA", "texas": "NORTEAMÉRICA",
    "redoubt": "NORTEAMÉRICA", "maunaloa": "NORTEAMÉRICA", "kilauea": "NORTEAMÉRICA",
    "trieste": "EUROPA-MEDITERRÁNEO", "cartagena": "EUROPA-MEDITERRÁNEO",
    "naxos": "EUROPA-MEDITERRÁNEO", "casablanca": "EUROPA-MEDITERRÁNEO",
    "kabul": "ASIA-PACÍFICO", "sharjah": "ASIA-PACÍFICO",
    "magadan": "ASIA-PACÍFICO", "davao": "ASIA-PACÍFICO", "palembang": "ASIA-PACÍFICO",
    "santaelena": "OTROS", "madagascar": "OTROS",
}

# Nombres de ciudad para la etiqueta (el frontend tiene su catálogo, pero el
# muro default se sirve completo para no acoplar el render al city_id)
CITY_LABELS: dict[str, str] = {
    "tokyo": "Tokyo", "osaka": "Osaka", "taipei": "Taipei", "guam": "Guam",
    "kathmandu": "Kathmandu", "lima": "Lima", "arequipa": "Arequipa",
    "santiago": "Santiago", "valparaiso": "Valparaíso", "antofagasta": "Antofagasta",
    "quito": "Quito", "bogota": "Bogotá", "mexicocity": "México DF",
    "sanjose": "San José", "managua": "Managua", "portauprince": "Port-au-Prince",
    "losangeles": "Los Angeles", "sandiego": "San Diego", "sanfrancisco": "San Francisco",
    "portland": "Portland", "seattle": "Seattle", "vancouver": "Vancouver",
    "anchorage": "Anchorage", "istanbul": "Istanbul", "wellington": "Wellington",
    "auckland": "Auckland", "christchurch": "Christchurch",
    # Mega wall (Fase 4, 2026-09-01)
    "salta": "Salta", "sanjuan": "San Juan", "ushuaia": "Ushuaia",
    "merida": "Mérida", "aguadilla": "Aguadilla", "santarosalia": "Santa Rosalía",
    "tuxtla": "Tuxtla Gutiérrez", "mountshasta": "Mount Shasta",
    "longvalley": "Long Valley", "mountrainier": "Mount Rainier",
    "sthelens": "St. Helens", "yellowstone": "Yellowstone", "texas": "Texas",
    "redoubt": "Volcán Redoubt", "maunaloa": "Mauna Loa", "kilauea": "Kilauea",
    "trieste": "Trieste", "cartagena": "Cartagena", "naxos": "Naxos",
    "casablanca": "Casablanca", "kabul": "Kabul", "sharjah": "Sharjah",
    "magadan": "Magadán", "davao": "Davao", "palembang": "Palembang",
    "santaelena": "Santa Elena", "madagascar": "Madagascar",
}

GLOBAL_WALL_COLUMNS = 5  # como el muro de SPECTRONET: columnas verticales densas


def pack_groups_into_columns(groups: list[dict], n_columns: int) -> list[list[dict]]:
    """Greedy: cada grupo (entero, nunca partido) va a la columna más liviana."""
    ordered = sorted(groups, key=lambda g: len(g["channels"]), reverse=True)
    columns: list[list[dict]] = [[] for _ in range(n_columns)]
    sizes = [0] * n_columns
    for group in ordered:
        target = sizes.index(min(sizes))
        columns[target].append(group)
        sizes[target] += len(group["channels"])
    return [col for col in columns if col]


def build_global_wall() -> dict:
    by_region: dict[str, list[dict]] = {}
    for city_id, candidates in LIVE_CANDIDATES_BY_CITY.items():
        region = CITY_REGIONS.get(city_id, "OTROS")
        by_region.setdefault(region, []).append(
            {"channel": candidates[0], "label": CITY_LABELS.get(city_id, city_id)}
        )
    groups = [
        {"title": region, "channels": sorted(chs, key=lambda c: c["label"])}
        for region, chs in sorted(by_region.items())
    ]
    return {
        "id": "global",
        "name": "Global",
        "layout": {
            "columns": [
                {"groups": col} for col in pack_groups_into_columns(groups, GLOBAL_WALL_COLUMNS)
            ],
            "showMetrics": False,
        },
    }


# --- Validación de layouts de muros guardados (PR-W2, spec §2) ---

MAX_WALL_COLUMNS = 8
MAX_WALL_CHANNELS = 120
MAX_WALL_TEXT_LEN = 40  # títulos de grupo y labels de tira

# SCNL del catálogo real: NET 1-2, STA 1-5, LOC 0-2 (frecuentemente vacío), CHA 3
_SCNL_RE = re.compile(r"^[A-Z0-9]{1,2}\.[A-Z0-9]{1,5}\.[A-Z0-9]{0,2}\.[A-Z0-9]{3}$")


class InvalidWallLayoutError(ValueError):
    """Layout que no cumple el contrato: forma, límites o canales no SCNL."""


def _valid_text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= MAX_WALL_TEXT_LEN


def validate_wall_layout(layout: object) -> None:
    if not isinstance(layout, dict):
        raise InvalidWallLayoutError("layout debe ser un objeto")
    columns = layout.get("columns")
    if not isinstance(columns, list) or not columns:
        raise InvalidWallLayoutError("layout.columns debe ser una lista no vacía")
    if len(columns) > MAX_WALL_COLUMNS:
        raise InvalidWallLayoutError(f"máximo {MAX_WALL_COLUMNS} columnas por muro")
    if not isinstance(layout.get("showMetrics"), bool):
        raise InvalidWallLayoutError("layout.showMetrics debe ser booleano")
    total_channels = 0
    for column in columns:
        if not isinstance(column, dict) or not isinstance(column.get("groups"), list):
            raise InvalidWallLayoutError("cada columna debe tener una lista groups")
        for group in column["groups"]:
            if not isinstance(group, dict) or not isinstance(group.get("channels"), list):
                raise InvalidWallLayoutError("cada grupo debe tener una lista channels")
            if not _valid_text(group.get("title")):
                raise InvalidWallLayoutError("título de grupo inválido")
            for channel in group["channels"]:
                if not isinstance(channel, dict):
                    raise InvalidWallLayoutError("cada canal debe ser un objeto {channel, label}")
                scnl = channel.get("channel")
                if not isinstance(scnl, str) or not _SCNL_RE.match(scnl):
                    raise InvalidWallLayoutError(f"canal no SCNL: {scnl!r}")
                if not _valid_text(channel.get("label")):
                    raise InvalidWallLayoutError("label de canal inválido")
                total_channels += 1
    if total_channels > MAX_WALL_CHANNELS:
        raise InvalidWallLayoutError(f"máximo {MAX_WALL_CHANNELS} canales por muro")


# --- CRUD de muros guardados por usuario (PR-W2) ---


class WallNotFoundError(Exception):
    """El muro no existe o pertenece a otro usuario (404 unificado, patrón AOI)."""


class WallNameConflictError(Exception):
    """Ya existe un muro con ese nombre para este usuario (UNIQUE user_id+name)."""


_WALL_COLUMNS = "id, name, layout, created_at, updated_at"


def _row_to_public(row: asyncpg.Record) -> WallPublic:
    layout = row["layout"]
    # asyncpg no decodifica JSONB a dict (a diferencia de psycopg)
    if isinstance(layout, str):
        layout = json.loads(layout)
    return WallPublic(
        id=row["id"],
        name=row["name"],
        layout=layout,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


class WallService:
    """CRUD de muros. El pool es prestado: lo abre y cierra el lifespan."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def list_for_user(self, user_id: UUID) -> list[WallPublic]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                f"SELECT {_WALL_COLUMNS} FROM walls WHERE user_id = $1 ORDER BY name",
                user_id,
            )
        return [_row_to_public(row) for row in rows]

    async def create(self, user_id: UUID, name: str, layout: dict) -> WallPublic:
        validate_wall_layout(layout)
        try:
            async with self._pool.acquire() as conn:
                row = await conn.fetchrow(
                    f"INSERT INTO walls (user_id, name, layout) VALUES ($1, $2, $3::jsonb) "
                    f"RETURNING {_WALL_COLUMNS}",
                    user_id,
                    name,
                    json.dumps(layout),
                )
        except asyncpg.UniqueViolationError as exc:
            raise WallNameConflictError(f"Wall '{name}' already exists") from exc
        return _row_to_public(row)

    async def update(self, wall_id: UUID, user_id: UUID, name: str, layout: dict) -> WallPublic:
        validate_wall_layout(layout)
        try:
            async with self._pool.acquire() as conn:
                # Ownership en el WHERE: un muro ajeno devuelve row None → 404,
                # indistinguible de inexistente a propósito.
                row = await conn.fetchrow(
                    f"UPDATE walls SET name = $3, layout = $4::jsonb, updated_at = now() "
                    f"WHERE id = $1 AND user_id = $2 RETURNING {_WALL_COLUMNS}",
                    wall_id,
                    user_id,
                    name,
                    json.dumps(layout),
                )
        except asyncpg.UniqueViolationError as exc:
            raise WallNameConflictError(f"Wall '{name}' already exists") from exc
        if row is None:
            raise WallNotFoundError(f"Wall {wall_id} not found")
        return _row_to_public(row)

    async def delete(self, wall_id: UUID, user_id: UUID) -> None:
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM walls WHERE id = $1 AND user_id = $2",
                wall_id,
                user_id,
            )
        if result == "DELETE 0":
            raise WallNotFoundError(f"Wall {wall_id} not found")
