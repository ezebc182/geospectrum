"""Muro default "Global" estilo SPECTRONET.

El agrupamiento por región no existe como dato en los catálogos (solo como
comentarios en spectrogram_service.py): acá se materializa. Una tira por
ciudad = su canal primario (LIVE_CANDIDATES_BY_CITY[city][0]); el failover
en vivo lo sigue resolviendo live-channels por debajo.
"""

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


import re

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
