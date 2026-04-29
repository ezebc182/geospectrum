"""Tests para filtrado por región y validación de presets."""
import pytest
from src.config.regions import (
    REGION_PRESETS,
    InvalidPresetError,
    UnknownRegionError,
    event_in_bbox,
    validate_presets,
    get_bbox_for_regions,
)


def test_andes_preset_exists():
    assert "andes_argentina_chile" in REGION_PRESETS


def test_event_in_andes_bbox():
    bbox = REGION_PRESETS["andes_argentina_chile"]["bbox"]
    event = {"lat": -32.9, "lon": -68.8}  # Mendoza
    assert event_in_bbox(event, bbox) is True


def test_event_outside_andes_bbox():
    bbox = REGION_PRESETS["andes_argentina_chile"]["bbox"]
    event = {"lat": 35.5, "lon": 139.7}  # Tokyo
    assert event_in_bbox(event, bbox) is False


def test_global_preset_uses_real_bbox_value():
    """El bbox del preset global se acepta tal cual (no None hardcodeado)."""
    bbox = REGION_PRESETS["global"]["bbox"]
    assert bbox is None
    event = {"lat": 35.5, "lon": 139.7}
    assert event_in_bbox(event, bbox) is True


def test_event_on_bbox_edge_is_inclusive():
    """Convención: el bbox es inclusivo en los bordes (minlat <= lat <= maxlat)."""
    bbox = REGION_PRESETS["andes_argentina_chile"]["bbox"]
    assert event_in_bbox({"lat": -40, "lon": -75}, bbox) is True
    assert event_in_bbox({"lat": -20, "lon": -60}, bbox) is True


def test_validate_presets_passes():
    validate_presets()  # no raise


def test_validate_invalid_bbox_raises_invalid_preset_error():
    bad = {"bad": {"name": "Bad", "bbox": {"minlat": 10, "maxlat": -10, "minlon": 0, "maxlon": 1}}}
    with pytest.raises(InvalidPresetError):
        validate_presets(bad)


def test_validate_out_of_range_lat_raises():
    bad = {"bad": {"name": "Bad", "bbox": {"minlat": 0, "maxlat": 100, "minlon": 0, "maxlon": 1}}}
    with pytest.raises(InvalidPresetError):
        validate_presets(bad)


def test_get_bbox_for_regions_returns_correct_bboxes_in_order():
    """Verifica contenido y orden, no solo longitud."""
    bboxes = get_bbox_for_regions(["andes_argentina_chile", "japan"])
    assert bboxes == [
        REGION_PRESETS["andes_argentina_chile"]["bbox"],
        REGION_PRESETS["japan"]["bbox"],
    ]


def test_get_bbox_for_regions_with_global_returns_empty_meaning_match_all():
    bboxes = get_bbox_for_regions(["global"])
    assert bboxes == []


def test_get_bbox_for_regions_global_short_circuits_at_any_position():
    """'global' en cualquier posición de la lista cortocircuita a []."""
    assert get_bbox_for_regions(["andes_argentina_chile", "global", "japan"]) == []
    assert get_bbox_for_regions(["global", "andes_argentina_chile"]) == []
    assert get_bbox_for_regions(["andes_argentina_chile", "global"]) == []


def test_get_bbox_for_regions_empty_list():
    """Lista vacia devuelve [] (= match all por convencion).

    Documenta explicitamente la decision: pedir cero regiones equivale
    a no filtrar. La misma convencion que 'global'.
    """
    assert get_bbox_for_regions([]) == []


def test_get_bbox_for_regions_unknown_raises():
    """Preset desconocido falla fast en lugar de degradar a []."""
    with pytest.raises(UnknownRegionError) as exc_info:
        get_bbox_for_regions(["andess_argentina_chile"])  # typo
    assert "andess_argentina_chile" in str(exc_info.value)
