"""Tests de integración para la API."""
import pytest
from fastapi.testclient import TestClient
from src.main import app


@pytest.fixture
def client():
    """Cliente de prueba para la API."""
    return TestClient(app)


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
    assert data["service"] == "Seismic Monitor"
    assert "endpoints" in data


def test_metrics_endpoint(client):
    """Test endpoint /metrics (Prometheus)."""
    response = client.get("/metrics")

    assert response.status_code == 200
    assert "seismic_monitor" in response.text


def test_report_endpoint_structure(client):
    """Test estructura del endpoint /report."""
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


def test_events_endpoint(client):
    """Test endpoint /events."""
    response = client.get("/events")

    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)


def test_alerts_endpoint(client):
    """Test endpoint /alerts."""
    response = client.get("/alerts")

    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
