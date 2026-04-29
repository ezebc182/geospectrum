"""Tests para servicio de KPIs."""
import pytest
from src.models.event import SeismicEvent
from src.services.kpi_service import compute_kpis_and_alerts


def test_kpis_empty_events():
    """Test KPIs con lista vacía."""
    kpis, alerts = compute_kpis_and_alerts([], window_minutes=60)

    assert kpis.total_eventos == 0
    assert kpis.tasa_eventos_por_hora == 0.0
    assert kpis.magnitud_max is None
    assert len(alerts) == 0


def test_kpis_basic():
    """Test KPIs básicos con eventos."""
    events = [
        SeismicEvent(
            id="e1",
            fuentes=["USGS"],
            hora_utc="2025-10-28T22:00:00Z",
            lat=-31.5,
            lon=-68.5,
            prof_km=100.0,
            mag=4.2,
            mag_tipo="Mw",
            lugar="Test 1",
            sentido=True,
            revisado=True,
        ),
        SeismicEvent(
            id="e2",
            fuentes=["USGS"],
            hora_utc="2025-10-28T22:10:00Z",
            lat=-31.6,
            lon=-68.6,
            prof_km=50.0,
            mag=3.5,
            mag_tipo="ML",
            lugar="Test 2",
            sentido=False,
            revisado=True,
        ),
    ]

    kpis, alerts = compute_kpis_and_alerts(events, window_minutes=60)

    assert kpis.total_eventos == 2
    assert kpis.tasa_eventos_por_hora == 2.0
    assert kpis.magnitud_max == 4.2
    assert kpis.eventos_sentidos == 1
    assert kpis.porcentaje_eventos_sentidos == 0.5


def test_alert_evento_significativo():
    """Test alerta de evento significativo M≥5 somero."""
    events = [
        SeismicEvent(
            id="e_big",
            fuentes=["USGS"],
            hora_utc="2025-10-28T22:00:00Z",
            lat=-31.5,
            lon=-68.5,
            prof_km=50.0,  # Somero (<70km)
            mag=5.2,
            mag_tipo="Mw",
            lugar="Test Big",
            sentido=True,
            revisado=True,
        ),
    ]

    kpis, alerts = compute_kpis_and_alerts(events, window_minutes=60)

    assert len(alerts) > 0
    assert any(a.tipo == "evento_significativo" for a in alerts)


def test_alert_actividad_sentida():
    """Test alerta de actividad sentida >50%."""
    events = [
        SeismicEvent(
            id=f"e{i}",
            fuentes=["USGS"],
            hora_utc="2025-10-28T22:00:00Z",
            lat=-31.5,
            lon=-68.5,
            prof_km=100.0,
            mag=3.5,
            mag_tipo="ML",
            lugar=f"Test {i}",
            sentido=True,  # Todos sentidos
            revisado=True,
        )
        for i in range(3)
    ]

    kpis, alerts = compute_kpis_and_alerts(events, window_minutes=60)

    assert any(a.tipo == "actividad_sentida" for a in alerts)
