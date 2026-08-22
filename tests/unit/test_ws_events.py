"""
Tests de /ws/events y /events/recent (PR-W4, T7-T8).

Estrenan `TestClient.websocket_connect` en este repo: hasta acá el
/ws/spectrogram existente no tenía ni un test (`rg -l websocket tests/` daba
cero). Por eso valen doble — fijan el contrato del endpoint nuevo y dejan el
patrón para cubrir el viejo.

Lo que se fija:
- el snapshot llega PRIMERO y con su sobre `type`
- sin base, el cliente igual recibe un snapshot vacío en vez de un cierre
- /events/recent devuelve 503 (no lista vacía) cuando no hay histórico
"""

from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from src.models.event import SeismicEvent


def build_event(event_id: str = "emsc_1", mag: float = 4.5) -> SeismicEvent:
    return SeismicEvent(
        id=event_id,
        fuentes=["EMSC"],
        hora_utc="2026-08-21T12:00:00Z",
        lat=-23.5,
        lon=-68.2,
        prof_km=110.0,
        mag=mag,
        mag_tipo="mb",
        lugar="Antofagasta, Chile",
    )


class _FakeBus:
    """
    Bus en memoria con la superficie que usa el lifespan (connect/close) más
    subscribe. Implementa las tres a propósito: sin connect/close el lifespan
    revienta con AttributeError y el error real queda tapado por ese ruido.
    """

    def __init__(self, eventos=None):
        self._eventos = eventos or []
        self.subscribed_channel = None

    async def connect(self) -> None:
        return None

    async def close(self) -> None:
        return None

    def subscribe(self, channel):
        self.subscribed_channel = channel
        eventos = self._eventos

        async def gen():
            for e in eventos:
                yield e

        return gen()


@pytest.fixture
def client(monkeypatch):
    """
    TestClient con el bus reemplazado por uno falso.

    El bus real intentaría conectarse a Redis en el lifespan; acá lo que se
    testea es el endpoint, no el transporte (que ya tiene sus tests de
    integración contra un Redis real en test_redis_pubsub_bus.py).
    """
    import src.main as main

    monkeypatch.setattr(main, "event_bus", _FakeBus(), raising=False)
    return main


class TestSnapshot:
    def test_el_snapshot_llega_primero_y_con_su_sobre(self, client, monkeypatch):
        """
        El sobre con `type` es lo que deja al cliente distinguir "acá está todo
        lo de las últimas 24 h" de "llegó uno nuevo". Sin él trataría el
        snapshot como 300 sismos recién ocurridos y dispararía 300 alertas.
        """
        store = AsyncMock()
        store.recent = AsyncMock(return_value=[build_event("a"), build_event("b")])

        with TestClient(client.app) as tc:
            tc.app.state.event_store = store
            with tc.websocket_connect("/ws/events") as ws:
                mensaje = ws.receive_json()

        assert mensaje["type"] == "snapshot"
        assert [e["id"] for e in mensaje["events"]] == ["a", "b"]

    def test_sin_base_manda_un_snapshot_vacio_en_vez_de_cerrar(self, client):
        """
        Degradación, no error: el cliente arranca vacío y se llena con lo que
        llegue por el stream. Cerrarle la conexión lo dejaría reintentando en
        loop contra un servidor que funciona.
        """
        with TestClient(client.app) as tc:
            tc.app.state.event_store = None
            with tc.websocket_connect("/ws/events") as ws:
                mensaje = ws.receive_json()

        assert mensaje == {"type": "snapshot", "events": []}

    def test_un_fallo_del_snapshot_no_tumba_la_conexion(self, client):
        """
        Si la consulta del histórico explota, el cliente igual queda conectado
        al stream: mejor sin histórico que sin push.
        """
        store = AsyncMock()
        store.recent = AsyncMock(side_effect=RuntimeError("base caída"))

        with TestClient(client.app) as tc:
            tc.app.state.event_store = store
            with tc.websocket_connect("/ws/events") as ws:
                mensaje = ws.receive_json()

        assert mensaje == {"type": "snapshot", "events": []}


class TestStream:
    def test_los_eventos_nuevos_llegan_con_su_propio_sobre(self, client, monkeypatch):
        import src.main as main

        bus = _FakeBus([build_event("nuevo").model_dump()])
        monkeypatch.setattr(main, "event_bus", bus, raising=False)

        store = AsyncMock()
        store.recent = AsyncMock(return_value=[])

        with TestClient(main.app) as tc:
            tc.app.state.event_store = store
            with tc.websocket_connect("/ws/events") as ws:
                snapshot = ws.receive_json()
                evento = ws.receive_json()

        assert snapshot["type"] == "snapshot"
        assert evento["type"] == "event"
        assert evento["event"]["id"] == "nuevo"

    def test_se_suscribe_al_canal_del_worker(self, client, monkeypatch):
        """
        Si el endpoint escuchara otro canal, el worker publicaría al vacío y
        nadie vería un solo evento — con todo en verde.
        """
        import src.main as main
        from src.services.events_ingestor import EVENTS_CHANNEL

        bus = _FakeBus([])
        monkeypatch.setattr(main, "event_bus", bus, raising=False)

        store = AsyncMock()
        store.recent = AsyncMock(return_value=[])

        with TestClient(main.app) as tc:
            tc.app.state.event_store = store
            with tc.websocket_connect("/ws/events") as ws:
                ws.receive_json()

        assert bus.subscribed_channel == EVENTS_CHANNEL


class TestEventsRecent:
    def test_devuelve_los_eventos_de_la_tabla(self, client):
        store = AsyncMock()
        store.recent = AsyncMock(return_value=[build_event("a"), build_event("b")])

        with TestClient(client.app) as tc:
            tc.app.state.event_store = store
            resp = tc.get("/events/recent")

        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 2
        assert body["ventana_horas"] == 24
        assert [e["id"] for e in body["eventos"]] == ["a", "b"]

    def test_sin_base_devuelve_503_y_NO_lista_vacia(self, client):
        """
        Una lista vacía haría que el frontend muestre "no hay sismos" cuando lo
        cierto es "no sabemos". Mentir por omisión es peor que fallar.
        """
        with TestClient(client.app) as tc:
            tc.app.state.event_store = None
            resp = tc.get("/events/recent")

        assert resp.status_code == 503

    def test_pasa_los_filtros_al_store(self, client):
        store = AsyncMock()
        store.recent = AsyncMock(return_value=[])

        with TestClient(client.app) as tc:
            tc.app.state.event_store = store
            tc.get("/events/recent?hours=6&min_magnitude=5&limit=10")

        store.recent.assert_awaited_once_with(hours=6, min_magnitude=5.0, limit=10)

    def test_rechaza_una_ventana_absurda(self, client):
        """168 h (7 días) es el tope: sin él un `hours=100000` barrería la tabla."""
        store = AsyncMock()
        store.recent = AsyncMock(return_value=[])

        with TestClient(client.app) as tc:
            tc.app.state.event_store = store
            assert tc.get("/events/recent?hours=99999").status_code == 422
