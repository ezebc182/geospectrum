"""Tests para servicio de fusión de eventos."""
import pytest
from src.models.event import SeismicEvent
from src.services.merge_service import merge_events


def test_merge_no_overlap():
    """Test fusión sin eventos solapados."""
    usgs = [
        SeismicEvent(
            id="usgs1",
            fuentes=["USGS"],
            hora_utc="2025-10-28T22:00:00Z",
            lat=-31.5,
            lon=-68.5,
            prof_km=100.0,
            mag=4.0,
            mag_tipo="Mw",
            lugar="Event 1",
            sentido=False,
            revisado=True,
        ),
    ]

    inpres = [
        SeismicEvent(
            id="inpres1",
            fuentes=["INPRES"],
            hora_utc="2025-10-28T23:00:00Z",  # 1 hora después
            lat=-32.5,
            lon=-69.5,
            prof_km=80.0,
            mag=3.5,
            mag_tipo="ML",
            lugar="Event 2",
            sentido=True,
            revisado=True,
        ),
    ]

    merged = merge_events(usgs, inpres)

    assert len(merged) == 2  # No overlap → ambos eventos


def test_merge_with_overlap():
    """Test fusión con eventos solapados (mismo evento reportado por ambas fuentes)."""
    usgs = [
        SeismicEvent(
            id="usgs1",
            fuentes=["USGS"],
            hora_utc="2025-10-28T22:00:00Z",
            lat=-31.5,
            lon=-68.5,
            prof_km=100.0,
            mag=4.0,
            mag_tipo="Mw",
            lugar="Same event",
            sentido=False,
            revisado=True,
        ),
    ]

    inpres = [
        SeismicEvent(
            id="inpres1",
            fuentes=["INPRES"],
            hora_utc="2025-10-28T22:00:30Z",  # 30 seg después
            lat=-31.51,  # Muy cerca
            lon=-68.51,
            prof_km=105.0,
            mag=4.1,  # Mag ligeramente diferente
            mag_tipo="ML",
            lugar="Same event (INPRES)",
            sentido=True,
            revisado=True,
        ),
    ]

    merged = merge_events(usgs, inpres)

    assert len(merged) == 1  # Fusionados
    assert "USGS" in merged[0].fuentes
    assert "INPRES" in merged[0].fuentes
    assert merged[0].mag == 4.1  # Mayor magnitud (conservador)
    assert merged[0].sentido is True  # OR lógico
