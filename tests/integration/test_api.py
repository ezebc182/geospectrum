"""Tests de integración para la API."""

import pytest
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient
from src.main import app
from src.models.event import SeismicEvent
from src.services import cache


@pytest.fixture(autouse=True)
def clear_cache_between_tests():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def client():
    """Cliente de prueba para la API."""
    return TestClient(app)


def emsc_only_event() -> SeismicEvent:
    """
    Fixture compartido (Fase 1, change "unify-dashboard-events-source"):
    evento reportado únicamente por EMSC, sin match temporal/geográfico con
    ningún evento USGS/INPRES usado en los tests de esta suite. Pensado para
    reutilizarse en los tests de Fase 5 que verifican que `/report`,
    `/events` y `/alerts` incluyen eventos exclusivos de EMSC tras migrar a
    `report_service.build_report` con `CANONICAL_SOURCES`.

    Coordenadas deliberadamente lejos (~1500km) de los fixtures USGS/INPRES
    usados en `test_search_events_uses_merge_all_sources` para garantizar
    que nunca matchea por accidente (Δt≤120s, distancia≤30km).
    """
    return SeismicEvent(
        id="emsc_only1",
        fuentes=["EMSC"],
        hora_utc="2025-10-28T22:05:00Z",
        lat=-38.0,
        lon=-72.0,
        prof_km=15.0,
        mag=4.5,
        mag_tipo="mb",
        lugar="EMSC-only test event",
        sentido=False,
        revisado=False,
    )


def test_health_endpoint(client):
    """Test endpoint /health."""
    response = client.get("/health")

    assert response.status_code == 200
    assert response.text == "ok"


def test_root_endpoint(client):
    """Test endpoint raíz."""
    response = client.get("/")

    assert response.status_code == 200
    data = response.json()
    assert data["service"] == "GeoSpectrum"
    assert "endpoints" in data


def test_metrics_endpoint(client):
    """Test endpoint /metrics (Prometheus)."""
    response = client.get("/metrics")

    assert response.status_code == 200
    assert "geospectrum_" in response.text


def test_cors_allows_configured_origins(client):
    """Test que CORS responde Access-Control-Allow-Origin para un origen
    configurado en settings.cors_origins_list (fix: antes el middleware
    ignoraba settings y usaba una lista hardcodeada)."""
    response = client.get(
        "/health",
        headers={"Origin": "http://localhost:3008"},
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3008"


def test_report_endpoint_structure(client):
    """Test estructura del endpoint /report (Fase 5: mockea explícitamente
    las 3 fuentes vía report_service, en vez de pegar a red real/vacía)."""
    with (
        patch("src.services.report_service.fetch_usgs_events", new_callable=AsyncMock) as mock_usgs,
        patch(
            "src.services.report_service.fetch_inpres_events", new_callable=AsyncMock
        ) as mock_inpres,
        patch("src.services.report_service.fetch_emsc_events", new_callable=AsyncMock) as mock_emsc,
    ):
        mock_usgs.return_value = ([], None)
        mock_inpres.return_value = ([], None)
        mock_emsc.return_value = ([], "emsc_timeout")

        response = client.get("/report")

        assert response.status_code == 200
        data = response.json()

        # Verificar estructura básica
        assert "timestamp_utc_generacion" in data
        assert "region_monitorizada" in data
        assert "kpis" in data
        assert "alertas" in data
        assert "eventos" in data

        # Verificar KPIs
        kpis = data["kpis"]
        assert "total_eventos" in kpis
        assert "tasa_eventos_por_hora" in kpis
        assert "magnitud_max" in kpis

        # data_source_errors puede incluir errores de EMSC (Requirement
        # "/report con fuente EMSC caída no rompe la respuesta")
        assert "emsc_timeout" in data["data_source_errors"]


def test_report_includes_emsc_only_event(client):
    """/report incluye eventos exclusivos de EMSC tras migrar a
    report_service.build_report con CANONICAL_SOURCES (Fase 5, análogo a
    test_search_events_uses_merge_all_sources pero apuntando a /report)."""
    with (
        patch("src.services.report_service.fetch_usgs_events", new_callable=AsyncMock) as mock_usgs,
        patch(
            "src.services.report_service.fetch_inpres_events", new_callable=AsyncMock
        ) as mock_inpres,
        patch("src.services.report_service.fetch_emsc_events", new_callable=AsyncMock) as mock_emsc,
    ):
        mock_usgs.return_value = ([], None)
        mock_inpres.return_value = ([], None)
        mock_emsc.return_value = ([emsc_only_event()], None)

        response = client.get("/report")

        assert response.status_code == 200
        data = response.json()
        eventos = data["eventos"]
        assert any(e["id"] == "emsc_only1" for e in eventos)
        emsc_event = next(e for e in eventos if e["id"] == "emsc_only1")
        assert "EMSC" in emsc_event["fuentes"]


def test_events_endpoint(client):
    """Test endpoint /events — incluye evento EMSC-only (Fase 5)."""
    with (
        patch("src.services.report_service.fetch_usgs_events", new_callable=AsyncMock) as mock_usgs,
        patch(
            "src.services.report_service.fetch_inpres_events", new_callable=AsyncMock
        ) as mock_inpres,
        patch("src.services.report_service.fetch_emsc_events", new_callable=AsyncMock) as mock_emsc,
    ):
        mock_usgs.return_value = ([], None)
        mock_inpres.return_value = ([], None)
        mock_emsc.return_value = ([emsc_only_event()], None)

        response = client.get("/events")

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert any(e["id"] == "emsc_only1" for e in data)


def test_alerts_endpoint(client):
    """Test endpoint /alerts — incluye alerta evento_significativo que
    depende exclusivamente de un evento EMSC (M>=5.0, prof<70km) (Fase 5)."""
    emsc_significant_event = SeismicEvent(
        id="emsc_significant1",
        fuentes=["EMSC"],
        hora_utc="2025-10-28T22:05:00Z",
        lat=-38.0,
        lon=-72.0,
        prof_km=15.0,
        mag=5.5,
        mag_tipo="mb",
        lugar="EMSC-only significant event",
        sentido=False,
        revisado=False,
    )

    with (
        patch("src.services.report_service.fetch_usgs_events", new_callable=AsyncMock) as mock_usgs,
        patch(
            "src.services.report_service.fetch_inpres_events", new_callable=AsyncMock
        ) as mock_inpres,
        patch("src.services.report_service.fetch_emsc_events", new_callable=AsyncMock) as mock_emsc,
    ):
        mock_usgs.return_value = ([], None)
        mock_inpres.return_value = ([], None)
        mock_emsc.return_value = ([emsc_significant_event], None)

        response = client.get("/alerts")

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert any(
            a["tipo"] == "evento_significativo" and "emsc_significant1" in a["eventos_relacionados"]
            for a in data
        )


def test_search_events_returns_list(client):
    """Test que /events/search devuelve lista."""
    response = client.get("/events/search")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_search_events_source_filter(client):
    """/events/search con sources=usgs sólo llama a USGS."""
    with (
        patch("src.main.fetch_usgs_events", new_callable=AsyncMock) as mock_usgs,
        patch("src.main.fetch_inpres_events", new_callable=AsyncMock) as mock_inpres,
        patch("src.main.fetch_emsc_events", new_callable=AsyncMock) as mock_emsc,
    ):
        mock_usgs.return_value = ([], None)
        mock_inpres.return_value = ([], None)
        mock_emsc.return_value = ([], None)

        response = client.get("/events/search?sources=usgs")
        assert response.status_code == 200

        mock_usgs.assert_called_once()
        mock_inpres.assert_not_called()
        mock_emsc.assert_not_called()


def test_search_events_uses_merge_all_sources(client):
    """/events/search con 3 fuentes aplica dedup inter-fuente."""
    from src.models.event import SeismicEvent

    shared_event_usgs = SeismicEvent(
        id="u1",
        fuentes=["USGS"],
        hora_utc="2025-10-28T22:00:00Z",
        lat=-31.5,
        lon=-68.5,
        prof_km=10.0,
        mag=4.0,
        mag_tipo="Mw",
        lugar="Test",
        sentido=False,
        revisado=False,
    )
    shared_event_inpres = SeismicEvent(
        id="i1",
        fuentes=["INPRES"],
        hora_utc="2025-10-28T22:00:20Z",
        lat=-31.51,
        lon=-68.51,
        prof_km=10.0,
        mag=4.2,
        mag_tipo="ML",
        lugar="Test",
        sentido=False,
        revisado=False,
    )

    with (
        patch("src.main.fetch_usgs_events", new_callable=AsyncMock) as mock_usgs,
        patch("src.main.fetch_inpres_events", new_callable=AsyncMock) as mock_inpres,
        patch("src.main.fetch_emsc_events", new_callable=AsyncMock) as mock_emsc,
    ):
        mock_usgs.return_value = ([shared_event_usgs], None)
        mock_inpres.return_value = ([shared_event_inpres], None)
        mock_emsc.return_value = ([], None)

        response = client.get("/events/search?sources=usgs,inpres,emsc")
        assert response.status_code == 200
        data = response.json()
        # Los dos eventos son el mismo → deben fusionarse en 1
        assert len(data) == 1
        assert data[0]["mag"] == 4.2


def test_cache_serves_second_request(client):
    """Segunda llamada a /events usa caché, no hace fetch externo dos veces."""
    call_count = {"n": 0}

    async def fake_usgs(window, min_magnitude=None):
        call_count["n"] += 1
        return [], None

    async def fake_inpres(window):
        return [], None

    async def fake_emsc(window, min_magnitude=None):
        return [], None

    # NOTA (Fase 3/4, change "unify-dashboard-events-source"): /events migró
    # a report_service.build_report, que fusiona usgs+emsc+inpres y resuelve
    # sus fetchers en el namespace de src.services.report_service (no
    # src.main). Se agrega el mock de fetch_emsc_events (antes ausente) para
    # que la 3ra fuente no pegue a red real; se ajustan los paths de patch al
    # módulo donde build_report realmente los invoca.
    with (
        patch("src.services.report_service.fetch_usgs_events", side_effect=fake_usgs),
        patch("src.services.report_service.fetch_inpres_events", side_effect=fake_inpres),
        patch("src.services.report_service.fetch_emsc_events", side_effect=fake_emsc),
    ):
        from src.config.settings import settings

        original_ttl = settings.cache_ttl_seconds
        settings.__dict__["cache_ttl_seconds"] = 30

        try:
            client.get("/events")
            client.get("/events")
            assert call_count["n"] == 1
        finally:
            settings.__dict__["cache_ttl_seconds"] = original_ttl


def test_report_events_alerts_parity(client):
    """Fase 5, tarea 5.6: con el mismo mock de 3 fuentes activo, /report,
    /events y /alerts deben ser consistentes entre sí — los ids de
    /report.eventos coinciden con /events, y /report.alertas coincide con
    /alerts (Requirement "Nuevo test cubre paridad /report vs /events vs
    /alerts" del spec)."""
    emsc_significant_event = SeismicEvent(
        id="emsc_significant1",
        fuentes=["EMSC"],
        hora_utc="2025-10-28T22:05:00Z",
        lat=-38.0,
        lon=-72.0,
        prof_km=15.0,
        mag=5.5,
        mag_tipo="mb",
        lugar="EMSC-only significant event",
        sentido=False,
        revisado=False,
    )

    with (
        patch("src.services.report_service.fetch_usgs_events", new_callable=AsyncMock) as mock_usgs,
        patch(
            "src.services.report_service.fetch_inpres_events", new_callable=AsyncMock
        ) as mock_inpres,
        patch("src.services.report_service.fetch_emsc_events", new_callable=AsyncMock) as mock_emsc,
    ):
        mock_usgs.return_value = ([], None)
        mock_inpres.return_value = ([], None)
        mock_emsc.return_value = ([emsc_only_event(), emsc_significant_event], None)

        report_data = client.get("/report").json()
        events_data = client.get("/events").json()
        alerts_data = client.get("/alerts").json()

        report_event_ids = {e["id"] for e in report_data["eventos"]}
        events_ids = {e["id"] for e in events_data}
        assert report_event_ids == events_ids

        report_alert_keys = {
            (a["tipo"], tuple(a["eventos_relacionados"])) for a in report_data["alertas"]
        }
        alerts_keys = {(a["tipo"], tuple(a["eventos_relacionados"])) for a in alerts_data}
        assert report_alert_keys == alerts_keys
