"""Tests de /ws/spectrogram: fan-out y suscripción efímera.

Contrato bajo prueba: un canal FUERA del catálogo fijo (LIVE_CANDIDATES_BY_CITY)
debe disparar request_channel_async contra Redis — sin eso, el ingestor nunca
llamó select_stream() para ese canal y el WebSocket queda mudo para siempre,
sin error (ver ephemeral_channels.py). Un canal DEL catálogo no debe pedir
nada: el ingestor ya lo suscribe al arrancar.

Nota de infraestructura de test: a propósito NO se usa `with TestClient(app)`
(que dispara el lifespan real, abriendo un asyncpg.Pool contra Postgres).
test_ws_events.py sí lo hace, y es el único otro archivo de tests/unit/ que lo
hace — corriendo los dos en la misma sesión de pytest, el Pool de un lifespan
puede ser recolectado por el GC en medio del lifespan del otro y disparar su
callback de cierre contra un event loop ya cerrado (RuntimeError: Event loop
is closed, en asyncpg.pool.Pool.close). El endpoint bajo prueba (ws_spectrogram)
no toca app.state.db_pool para nada, así que el lifespan real es innecesario
acá: TestClient(app) sin `with` (mismo patrón que test_deps.py) evita el
problema de raíz en vez de parchearlo.
"""

from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from src.services.spectrogram_service import LIVE_CANDIDATES_BY_CITY


class _FakeBus:
    """Mismo espíritu que el _FakeBus de test_ws_events.py: superficie mínima
    (connect/close/subscribe/client) para no depender de Redis real."""

    def __init__(self, columns=None):
        self._columns = columns or []
        self.subscribed_channel = None
        self.client = AsyncMock()

    async def connect(self) -> None:
        return None

    async def close(self) -> None:
        return None

    def subscribe(self, channel):
        self.subscribed_channel = channel
        columns = self._columns

        async def gen():
            for c in columns:
                yield c

        return gen()


@pytest.fixture
def client(monkeypatch):
    import src.main as main

    bus = _FakeBus()
    monkeypatch.setattr(main, "event_bus", bus, raising=False)
    return main, bus


def _un_canal_del_catalogo() -> str:
    return next(iter(next(iter(LIVE_CANDIDATES_BY_CITY.values()))))


def test_canal_del_catalogo_no_pide_suscripcion_efimera(client, monkeypatch):
    main, bus = client
    bus._columns = [{"channel": "x", "freqs": [], "power_db": []}]
    request_mock = AsyncMock()
    monkeypatch.setattr(main, "request_channel_async", request_mock)

    channel = _un_canal_del_catalogo()
    tc = TestClient(main.app)  # SIN `with`: no dispara el lifespan real, ver nota del módulo
    with tc.websocket_connect(f"/ws/spectrogram/{channel}") as ws:
        ws.receive_json()

    request_mock.assert_not_called()


def test_canal_fuera_del_catalogo_pide_suscripcion_efimera(client, monkeypatch):
    main, bus = client
    bus._columns = [{"channel": "x", "freqs": [], "power_db": []}]
    request_mock = AsyncMock()
    monkeypatch.setattr(main, "request_channel_async", request_mock)
    # El ciclo de renovación duerme _EPHEMERAL_RENEWAL_INTERVAL_SECONDS entre
    # pedidos — para el test alcanza con que el primero haya salido antes de
    # cerrar la conexión.
    monkeypatch.setattr(main, "_EPHEMERAL_RENEWAL_INTERVAL_SECONDS", 999)

    channel = "ZZ.NOEXISTE.00.ZZZ"  # inventado a propósito, no puede colisionar
    assert channel not in {
        seed_id for cs in LIVE_CANDIDATES_BY_CITY.values() for seed_id in cs
    }

    tc = TestClient(main.app)  # SIN `with`: no dispara el lifespan real, ver nota del módulo
    with tc.websocket_connect(f"/ws/spectrogram/{channel}") as ws:
        ws.receive_json()

    request_mock.assert_awaited()
    args, _ = request_mock.call_args
    assert args[1] == channel
