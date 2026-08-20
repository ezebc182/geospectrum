"""
Tests para el servicio interno único de fusión (report_service.build_report).

Change "unify-dashboard-events-source", Fase 2 (tasks 2.5, 2.6, 2.7).
"""

from unittest.mock import AsyncMock, patch

import pytest

from src.config.settings import settings
from src.models.event import SeismicEvent
from src.services import cache
from src.services.report_service import CANONICAL_SOURCES, build_report, count_by_source


@pytest.fixture(autouse=True)
def clear_cache_between_tests():
    cache.clear()
    yield
    cache.clear()


def _event(
    event_id: str, source: str, lat: float, lon: float, hora: str, mag: float = 4.0
) -> SeismicEvent:
    return SeismicEvent(
        id=event_id,
        fuentes=[source],
        hora_utc=hora,
        lat=lat,
        lon=lon,
        prof_km=10.0,
        mag=mag,
        mag_tipo="ML",
        lugar=f"Lugar {event_id}",
        sentido=False,
        revisado=False,
    )


def test_canonical_sources_is_usgs_emsc_inpres():
    """CANONICAL_SOURCES fija el orden confirmado en la Fase 0 (gate)."""
    assert CANONICAL_SOURCES == ["usgs", "emsc", "inpres"]


@pytest.mark.asyncio
async def test_build_report_merges_three_sources():
    """
    Task 2.5: build_report(sources=CANONICAL_SOURCES) devuelve MonitorReport
    con eventos fusionados de las 3 fuentes, kpis consistentes, y
    region_monitorizada == settings.bbox.
    """
    usgs_event = _event("u1", "USGS", -31.5, -68.5, "2025-10-28T22:00:00Z")
    emsc_event = _event("e1", "EMSC", -35.0, -70.0, "2025-10-28T21:00:00Z")
    inpres_event = _event("i1", "INPRES", -28.0, -65.0, "2025-10-28T20:00:00Z")

    with (
        patch("src.services.report_service.fetch_usgs_events", new_callable=AsyncMock) as mock_usgs,
        patch("src.services.report_service.fetch_emsc_events", new_callable=AsyncMock) as mock_emsc,
        patch(
            "src.services.report_service.fetch_inpres_events", new_callable=AsyncMock
        ) as mock_inpres,
    ):
        mock_usgs.return_value = ([usgs_event], None)
        mock_emsc.return_value = ([emsc_event], None)
        mock_inpres.return_value = ([inpres_event], None)

        report = await build_report(sources=CANONICAL_SOURCES)

    mock_usgs.assert_called_once()
    mock_emsc.assert_called_once()
    mock_inpres.assert_called_once()

    assert {e.id for e in report.eventos} == {"u1", "e1", "i1"}
    assert report.kpis.total_eventos == 3
    assert report.region_monitorizada == settings.bbox
    assert report.data_source_errors == []


@pytest.mark.asyncio
async def test_build_report_subset_sources_skips_emsc_fetch():
    """
    Task 2.6: sources=["usgs","inpres"] (sin EMSC) no invoca fetch_emsc_events
    y el resultado es idéntico al comportamiento actual de merge_events de 2
    fuentes (Requirement "El servicio interno es invocable con subconjuntos
    de fuentes").
    """
    usgs_event = _event("u1", "USGS", -31.5, -68.5, "2025-10-28T22:00:00Z", mag=4.0)
    inpres_event = _event("i1", "INPRES", -31.51, -68.51, "2025-10-28T22:00:30Z", mag=4.2)

    with (
        patch("src.services.report_service.fetch_usgs_events", new_callable=AsyncMock) as mock_usgs,
        patch("src.services.report_service.fetch_emsc_events", new_callable=AsyncMock) as mock_emsc,
        patch(
            "src.services.report_service.fetch_inpres_events", new_callable=AsyncMock
        ) as mock_inpres,
    ):
        mock_usgs.return_value = ([usgs_event], None)
        mock_inpres.return_value = ([inpres_event], None)

        report = await build_report(sources=["usgs", "inpres"])

    mock_usgs.assert_called_once()
    mock_inpres.assert_called_once()
    mock_emsc.assert_not_called()

    # Mismo criterio de match que merge_events de 2 fuentes: se fusionan.
    assert len(report.eventos) == 1
    assert report.eventos[0].mag == 4.2
    assert "USGS" in report.eventos[0].fuentes
    assert "INPRES" in report.eventos[0].fuentes


@pytest.mark.asyncio
async def test_build_report_source_down_keeps_200_equivalent_response():
    """
    Task 2.7: si una fuente falla (EMSC caída), build_report no lanza
    excepción, data_source_errors incluye el identificador de EMSC, y
    eventos contiene la fusión de las fuentes que sí respondieron.
    """
    usgs_event = _event("u1", "USGS", -31.5, -68.5, "2025-10-28T22:00:00Z")
    inpres_event = _event("i1", "INPRES", -28.0, -65.0, "2025-10-28T20:00:00Z")

    with (
        patch("src.services.report_service.fetch_usgs_events", new_callable=AsyncMock) as mock_usgs,
        patch("src.services.report_service.fetch_emsc_events", new_callable=AsyncMock) as mock_emsc,
        patch(
            "src.services.report_service.fetch_inpres_events", new_callable=AsyncMock
        ) as mock_inpres,
    ):
        mock_usgs.return_value = ([usgs_event], None)
        mock_emsc.return_value = ([], "emsc_timeout")
        mock_inpres.return_value = ([inpres_event], None)

        report = await build_report(sources=CANONICAL_SOURCES)

    assert any("emsc" in err.lower() for err in report.data_source_errors)
    assert {e.id for e in report.eventos} == {"u1", "i1"}


@pytest.mark.asyncio
async def test_build_report_uses_settings_window_minutes_by_default():
    """window_minutes=None usa settings.window_minutes (mismo default que
    /events/search)."""
    with (
        patch("src.services.report_service.fetch_usgs_events", new_callable=AsyncMock) as mock_usgs,
        patch("src.services.report_service.fetch_emsc_events", new_callable=AsyncMock) as mock_emsc,
        patch(
            "src.services.report_service.fetch_inpres_events", new_callable=AsyncMock
        ) as mock_inpres,
    ):
        mock_usgs.return_value = ([], None)
        mock_emsc.return_value = ([], None)
        mock_inpres.return_value = ([], None)

        await build_report(sources=CANONICAL_SOURCES)

        # USGS/EMSC llevan además el piso de magnitud del fetch; INPRES no
        # (el proxy no lo acepta, se filtra post-merge).
        mock_usgs.assert_called_once_with(
            settings.window_minutes, min_magnitude=settings.source_min_magnitude
        )
        mock_emsc.assert_called_once_with(
            settings.window_minutes, min_magnitude=settings.source_min_magnitude
        )
        mock_inpres.assert_called_once_with(settings.window_minutes)


@pytest.mark.asyncio
async def test_build_report_respects_explicit_window_minutes():
    with (
        patch("src.services.report_service.fetch_usgs_events", new_callable=AsyncMock) as mock_usgs,
        patch("src.services.report_service.fetch_emsc_events", new_callable=AsyncMock) as mock_emsc,
        patch(
            "src.services.report_service.fetch_inpres_events", new_callable=AsyncMock
        ) as mock_inpres,
    ):
        mock_usgs.return_value = ([], None)
        mock_emsc.return_value = ([], None)
        mock_inpres.return_value = ([], None)

        await build_report(sources=CANONICAL_SOURCES, window_minutes=15)

        mock_usgs.assert_called_once_with(15, min_magnitude=settings.source_min_magnitude)
        mock_emsc.assert_called_once_with(15, min_magnitude=settings.source_min_magnitude)
        mock_inpres.assert_called_once_with(15)


def test_count_by_source_counts_pre_merge_lists():
    """
    Task 2.4: count_by_source refleja lo que cada fuente reportó ANTES de
    fusionar (no el conteo post-dedup), para que events_fetched por fuente
    en Prometheus no pierda observabilidad de EMSC al migrar a build_report.
    """
    usgs_events = [_event("u1", "USGS", -31.5, -68.5, "2025-10-28T22:00:00Z")]
    emsc_events = [
        _event("e1", "EMSC", -35.0, -70.0, "2025-10-28T21:00:00Z"),
        _event("e2", "EMSC", -35.1, -70.1, "2025-10-28T21:05:00Z"),
    ]
    inpres_events: list[SeismicEvent] = []

    counts = count_by_source(usgs_events, emsc_events, inpres_events)

    assert counts == {"USGS": 1, "EMSC": 2, "INPRES": 0}
