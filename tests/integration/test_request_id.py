"""Tests del middleware X-Request-ID (M1.5)."""
import pytest
from fastapi.testclient import TestClient
from src.main import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def test_response_contains_request_id(client):
    """Toda response debe incluir X-Request-ID aunque el cliente no lo envíe."""
    response = client.get("/health")

    assert response.status_code == 200
    assert "x-request-id" in response.headers
    assert response.headers["x-request-id"] != ""


def test_request_ids_differ_between_requests(client):
    """Dos requests sin X-Request-ID deben recibir IDs distintos (UUID4 generado)."""
    r1 = client.get("/health")
    r2 = client.get("/health")

    id1 = r1.headers["x-request-id"]
    id2 = r2.headers["x-request-id"]

    assert id1 != id2, f"Expected different request IDs but got same: {id1}"


def test_client_provided_request_id_is_echoed(client):
    """Si el cliente envía X-Request-ID, el server debe devolver el mismo valor."""
    custom_id = "abc123-test-trace"
    response = client.get("/health", headers={"X-Request-ID": custom_id})

    assert response.status_code == 200
    assert response.headers["x-request-id"] == custom_id
