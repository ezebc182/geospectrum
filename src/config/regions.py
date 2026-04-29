"""
Region presets para suscripciones multi-región del stream SSE.

Cada preset tiene un bbox (bounding box) que define qué eventos pertenecen
a esa región. El preset 'global' tiene bbox None, lo que significa "todos".
"""
from typing import Optional

REGION_PRESETS: dict[str, dict] = {
    "andes_argentina_chile": {
        "name": "Andes Argentina-Chile",
        "bbox": {"minlat": -40, "maxlat": -20, "minlon": -75, "maxlon": -60},
    },
    "pacific_ring_south_america": {
        "name": "Pacific Ring (South America)",
        "bbox": {"minlat": -56, "maxlat": 12, "minlon": -82, "maxlon": -65},
    },
    "japan": {
        "name": "Japan",
        "bbox": {"minlat": 24, "maxlat": 46, "minlon": 122, "maxlon": 146},
    },
    "mediterranean": {
        "name": "Mediterranean",
        "bbox": {"minlat": 30, "maxlat": 47, "minlon": -10, "maxlon": 40},
    },
    "global": {
        "name": "Global (sin filtro)",
        "bbox": None,
    },
}


def event_in_bbox(event: dict, bbox: Optional[dict]) -> bool:
    """Devuelve True si el evento cae dentro del bbox.

    Si bbox es None (preset global), siempre devuelve True.
    """
    if bbox is None:
        return True
    lat = event["lat"]
    lon = event["lon"]
    return (
        bbox["minlat"] <= lat <= bbox["maxlat"]
        and bbox["minlon"] <= lon <= bbox["maxlon"]
    )


def validate_presets(presets: Optional[dict] = None) -> None:
    """Valida que todos los bboxes tengan rangos coherentes.

    Llamado en startup. Crashea si hay preset roto.
    """
    presets = presets if presets is not None else REGION_PRESETS
    for name, preset in presets.items():
        bbox = preset.get("bbox")
        if bbox is None:
            continue
        assert bbox["minlat"] < bbox["maxlat"], f"{name}: minlat >= maxlat"
        assert bbox["minlon"] < bbox["maxlon"], f"{name}: minlon >= maxlon"
        assert -90 <= bbox["minlat"] <= 90, f"{name}: minlat out of range"
        assert -90 <= bbox["maxlat"] <= 90, f"{name}: maxlat out of range"
        assert -180 <= bbox["minlon"] <= 180, f"{name}: minlon out of range"
        assert -180 <= bbox["maxlon"] <= 180, f"{name}: maxlon out of range"


def get_bbox_for_regions(region_names: list[str]) -> list[dict]:
    """Devuelve la lista de bboxes correspondientes a los presets pedidos.

    Si alguno es 'global' (bbox=None), devuelve [] (caller debe interpretar
    como "match all"). Ignora presets desconocidos.
    """
    bboxes: list[dict] = []
    for name in region_names:
        preset = REGION_PRESETS.get(name)
        if preset is None:
            continue
        bbox = preset["bbox"]
        if bbox is None:
            return []  # "global" cortocircuita
        bboxes.append(bbox)
    return bboxes
