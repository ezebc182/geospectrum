"""Tests para filtrado por región y validación de presets."""
import pytest
from src.config.regions import (
    REGION_PRESETS,
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


def test_global_preset_matches_everything():
    bbox = REGION_PRESETS["global"]["bbox"]
    assert bbox is None
    event = {"lat": 35.5, "lon": 139.7}
    assert event_in_bbox(event, None) is True


def test_validate_presets_passes():
    validate_presets()  # no raise


def test_validate_invalid_bbox_raises():
    bad = {"bad": {"name": "Bad", "bbox": {"minlat": 10, "maxlat": -10, "minlon": 0, "maxlon": 1}}}
    with pytest.raises(AssertionError):
        validate_presets(bad)


def test_get_bbox_for_regions_multiple():
    bboxes = get_bbox_for_regions(["andes_argentina_chile", "japan"])
    assert len(bboxes) == 2


def test_get_bbox_for_regions_with_global_returns_empty_meaning_match_all():
    bboxes = get_bbox_for_regions(["global"])
    assert bboxes == []  # caller debe interpretar [] como "match all"
