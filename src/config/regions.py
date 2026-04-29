"""
Region presets para suscripciones multi-región del stream SSE.

El sistema acepta que un cliente se suscriba a uno o más presets nombrados
en lugar de bboxes crudos: así garantizamos que los filtros estén validados
y curados, y evitamos que cualquiera pida "todo el planeta" inadvertidamente.

Convención central: bbox=None representa el preset 'global' (sin filtro).
La misma convención se propaga a get_bbox_for_regions, que devuelve [] cuando
'global' está en la suscripción, lo que el caller debe interpretar como
"match all". Esto evita que el caller tenga que ramificar entre "filtrar"
y "no filtrar".
"""
from typing import Optional, TypedDict


class Bbox(TypedDict):
    """Bounding box geográfico en grados decimales."""

    minlat: float
    maxlat: float
    minlon: float
    maxlon: float


class RegionPreset(TypedDict):
    """Preset nombrado de región. bbox=None significa 'global' (sin filtro)."""

    name: str
    bbox: Optional[Bbox]


REGION_PRESETS: dict[str, RegionPreset] = {
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


class InvalidPresetError(ValueError):
    """Preset con bbox inválido detectado en startup."""


class UnknownRegionError(ValueError):
    """Cliente pidió un preset que no existe."""


def event_in_bbox(event: dict, bbox: Optional[Bbox]) -> bool:
    """Convención: bbox=None ⇒ preset global ⇒ siempre matchea.

    Esta función espera que el evento ya tenga lat/lon validados por la
    capa upstream (Pydantic SeismicEvent). No defiende contra eventos
    malformados acá para evitar duplicar validaciones.
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
    """Valida bboxes en startup. Excepción real, no assert.

    Usar excepción y no assert es deliberado: con `python -O` los assert
    se desactivan, dejando presets rotos pasar silenciosos en producción.
    """
    presets = presets if presets is not None else REGION_PRESETS
    for name, preset in presets.items():
        bbox = preset.get("bbox")
        if bbox is None:
            continue
        if not (bbox["minlat"] < bbox["maxlat"]):
            raise InvalidPresetError(f"{name}: minlat >= maxlat")
        if not (bbox["minlon"] < bbox["maxlon"]):
            raise InvalidPresetError(f"{name}: minlon >= maxlon")
        if not (-90 <= bbox["minlat"] <= 90):
            raise InvalidPresetError(f"{name}: minlat out of range")
        if not (-90 <= bbox["maxlat"] <= 90):
            raise InvalidPresetError(f"{name}: maxlat out of range")
        if not (-180 <= bbox["minlon"] <= 180):
            raise InvalidPresetError(f"{name}: minlon out of range")
        if not (-180 <= bbox["maxlon"] <= 180):
            raise InvalidPresetError(f"{name}: maxlon out of range")


def get_bbox_for_regions(region_names: list[str]) -> list[Bbox]:
    """Convención: si 'global' está en la lista, devuelve [] (= match all).

    Falla con UnknownRegionError ante presets desconocidos. La alternativa
    de ignorar silenciosamente es peligrosa: un typo del caller resultaría
    en [] interpretado como global, ampliando el filtro sin querer.
    """
    bboxes: list[Bbox] = []
    for name in region_names:
        if name not in REGION_PRESETS:
            raise UnknownRegionError(
                f"Unknown region preset: {name!r}. "
                f"Available: {sorted(REGION_PRESETS.keys())}"
            )
        bbox = REGION_PRESETS[name]["bbox"]
        if bbox is None:
            return []  # "global" cortocircuita
        bboxes.append(bbox)
    return bboxes
