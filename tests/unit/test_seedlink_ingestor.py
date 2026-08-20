"""
Tests del arranque del ingestor SeedLink.

El bug que motivó estos tests: `run()` corre en un hilo daemon y no tenía
try/except. Si reventaba al conectar, la excepción moría dentro del hilo, el
proceso principal salía del `while thread.is_alive()` y terminaba con código 0.
Railway marcaba el deploy `SUCCESS` sobre un ingestor que no ingestaba nada, y
sin PYTHONUNBUFFERED los logs se perdían en el buffer: silencio total.
"""

import threading
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import numpy as np
import pytest
from obspy import Trace

from src.services.seedlink_ingestor import SeedLinkIngestor


class _BoomClient:
    """Cliente de SeedLink que revienta al correr, como un servidor caído."""

    def __init__(self, *args, **kwargs):
        pass

    def select_stream(self, *args, **kwargs):
        pass

    def run(self):
        raise ConnectionError("no se pudo conectar al servidor SeedLink")


def test_run_registra_la_excepcion_en_failure(monkeypatch):
    """Un fallo en el hilo tiene que quedar accesible desde afuera."""
    monkeypatch.setattr(
        "src.services.seedlink_ingestor.create_client",
        lambda *a, **kw: _BoomClient(),
    )
    ingestor = SeedLinkIngestor(bus=MagicMock())

    with pytest.raises(ConnectionError):
        ingestor.run([("IU", "MAJO", "BHZ")])

    # Sin esto el proceso principal no tiene forma de distinguir un cierre
    # ordenado de un arranque fallido.
    assert isinstance(ingestor.failure, ConnectionError)


def test_la_excepcion_del_hilo_no_llega_sola_al_proceso_principal(monkeypatch):
    """
    Fija el MECANISMO del bug, no sólo el síntoma: correr `run()` en un hilo
    hace que la excepción no se propague al principal. Es la razón por la que
    `failure` y el exit code explícito son necesarios; si algún día Python
    cambiara esto, el test avisa.
    """
    monkeypatch.setattr(
        "src.services.seedlink_ingestor.create_client",
        lambda *a, **kw: _BoomClient(),
    )
    ingestor = SeedLinkIngestor(bus=MagicMock())

    thread = threading.Thread(
        target=lambda: ingestor.run([("IU", "MAJO", "BHZ")]), daemon=True
    )
    thread.start()
    thread.join(timeout=5)

    assert not thread.is_alive(), "el hilo debería haber terminado por la excepción"
    # El hilo murió sin que nadie afuera se enterara por vía de excepción: la
    # única señal es `failure`.
    assert ingestor.failure is not None


# ---------------------------------------------------------------------------
# Watchdog de reconexión por canal (memoria: los streams se caen de a uno,
# la conexión TCP sigue viva y la única cura era un redeploy).
# ---------------------------------------------------------------------------


class _FakeConn:
    """Imita SeedLinkConnection: terminate() hace salir a run() limpio."""

    def __init__(self, client: "_FakeClient"):
        self._client = client

    def terminate(self):
        self._client.terminated.set()


class _FakeClient:
    """Cliente cuyo run() bloquea hasta que el watchdog llama terminate()."""

    def __init__(self):
        self.terminated = threading.Event()
        self.conn = _FakeConn(self)
        self.selected: list[tuple] = []

    def select_stream(self, net, sta, cha):
        self.selected.append((net, sta, cha))

    def run(self):
        self.terminated.wait(timeout=10)


def _trace(net="UW", sta="LON", cha="HHZ") -> Trace:
    # 2 muestras: no alcanza para una columna (npts < fs*4), así _on_data
    # registra actividad y corta antes de publicar al bus.
    return Trace(
        data=np.zeros(2),
        header={"network": net, "station": sta, "channel": cha, "sampling_rate": 1.0},
    )


def _ingestor_rapido(**kwargs) -> "SeedLinkIngestor":
    defaults = dict(
        stale_after_s=0.15,
        check_interval_s=0.03,
        give_up_after_s=30,
        reconnect_delay_s=0.01,
    )
    defaults.update(kwargs)
    return SeedLinkIngestor(bus=MagicMock(), **defaults)


def test_on_data_registra_actividad_en_el_watchdog():
    # Umbral holgado a propósito: este test verifica el CABLEADO (_on_data →
    # watchdog), no el timing. Con 0.15s el primer _compute_column en frío
    # tardaba más que el umbral y el test flaqueaba bajo coverage.
    ingestor = _ingestor_rapido(stale_after_s=60)
    hace_rato = datetime.now(timezone.utc) - timedelta(seconds=600)
    ingestor.watchdog.note_connected(["UW.LON.HHZ"], now=hace_rato)

    ingestor._on_data(_trace())

    ahora = datetime.now(timezone.utc)
    assert ingestor.watchdog.stale_channels(now=ahora) == []


def test_canal_mudo_fuerza_reconexion_y_resuscribe(monkeypatch):
    """Sin datos, todos los canales se vuelven stale: el watchdog termina el
    cliente y el loop de supervisión crea uno nuevo con las mismas streams."""
    creados: list[_FakeClient] = []

    def _factory(*args, **kwargs):
        client = _FakeClient()
        creados.append(client)
        return client

    monkeypatch.setattr("src.services.seedlink_ingestor.create_client", _factory)
    ingestor = _ingestor_rapido()

    thread = threading.Thread(
        target=lambda: ingestor.run([("UW", "LON", "HHZ")]), daemon=True
    )
    thread.start()
    deadline = time.monotonic() + 5
    while len(creados) < 2 and time.monotonic() < deadline:
        time.sleep(0.02)
    ingestor.stop()
    thread.join(timeout=5)

    assert len(creados) >= 2, "el watchdog debió forzar al menos una reconexión"
    assert creados[1].selected == [("UW", "LON", "HHZ")]


def test_sin_ningun_dato_en_give_up_after_el_proceso_muere(monkeypatch):
    """Reconectar para siempre sin recibir NADA sería el viejo deploy verde y
    mudo con otro disfraz: pasado give_up_after el proceso tiene que morir
    con error para que Railway lo reinicie y el fallo quede visible."""
    monkeypatch.setattr(
        "src.services.seedlink_ingestor.create_client", lambda *a, **kw: _FakeClient()
    )
    ingestor = _ingestor_rapido(give_up_after_s=0.4)

    with pytest.raises(RuntimeError):
        ingestor.run([("UW", "LON", "HHZ")])

    assert isinstance(ingestor.failure, RuntimeError)


def test_error_tras_haber_recibido_datos_reconecta_en_vez_de_morir(monkeypatch):
    """Un corte del servidor después de haber estado transmitiendo no es un
    arranque fallido: se reintenta con backoff en vez de matar el proceso."""
    creados: list = []

    class _ClientQueEmiteYMuere(_FakeClient):
        def __init__(self, on_data):
            super().__init__()
            self._on_data = on_data

        def run(self):
            self._on_data(_trace())
            raise ConnectionError("el servidor cortó la conexión")

    def _factory(server, on_data):
        client = (
            _ClientQueEmiteYMuere(on_data) if len(creados) == 0 else _FakeClient()
        )
        creados.append(client)
        return client

    monkeypatch.setattr("src.services.seedlink_ingestor.create_client", _factory)
    ingestor = _ingestor_rapido()

    thread = threading.Thread(
        target=lambda: ingestor.run([("UW", "LON", "HHZ")]), daemon=True
    )
    thread.start()
    deadline = time.monotonic() + 5
    while len(creados) < 2 and time.monotonic() < deadline:
        time.sleep(0.02)
    ingestor.stop()
    thread.join(timeout=5)

    assert len(creados) >= 2, "tras el ConnectionError debió reconectar"
    assert ingestor.failure is None


class _ClienteSordo(_FakeClient):
    """Cliente cuyo conn ignora terminate(): simula la carrera real de ObsPy
    donde collect() resetea terminate_flag al reentrar y la señal se pierde."""

    def __init__(self):
        super().__init__()
        self.terminates = 0
        self.conn = self  # el propio cliente hace de conn

    def terminate(self):
        self.terminates += 1  # ignora la señal: run() sigue bloqueado


def test_terminate_perdido_se_reintenta_sin_quemar_strikes(monkeypatch):
    """La señal de terminate puede perderse (collect() la pisa al reentrar).
    El watchdog debe reintentar en cada chequeo, y NO quemar strikes hasta
    que la reconexión ocurra de verdad — si no, tres terminates perdidos
    dejan al canal en cuarentena sin haber reconectado ni una vez."""
    cliente = _ClienteSordo()
    monkeypatch.setattr(
        "src.services.seedlink_ingestor.create_client", lambda *a, **kw: cliente
    )
    ingestor = _ingestor_rapido()  # max_strikes default = 3

    thread = threading.Thread(
        target=lambda: ingestor.run([("UW", "LON", "HHZ")]), daemon=True
    )
    thread.start()
    deadline = time.monotonic() + 5
    # Con strikes quemados por intento, el watchdog se rinde en 3 terminates.
    while cliente.terminates < 5 and time.monotonic() < deadline:
        time.sleep(0.02)
    ingestor.stop()
    cliente.terminated.set()
    thread.join(timeout=5)

    assert cliente.terminates >= 5, (
        "el watchdog dejó de reintentar: quemó strikes por terminates perdidos"
    )


def test_canal_muerto_permanente_quema_strikes_solo_al_reconectar(monkeypatch):
    """Con reconexiones REALES, un canal que nunca revive queda en cuarentena
    tras max_strikes ciclos y las reconexiones paran: exactamente 1 cliente
    inicial + max_strikes reconexiones, ni una más."""
    creados: list[_FakeClient] = []

    def _factory(*args, **kwargs):
        client = _FakeClient()
        creados.append(client)
        return client

    monkeypatch.setattr("src.services.seedlink_ingestor.create_client", _factory)
    ingestor = _ingestor_rapido(give_up_after_s=30)

    thread = threading.Thread(
        target=lambda: ingestor.run([("UW", "LON", "HHZ")]), daemon=True
    )
    thread.start()
    deadline = time.monotonic() + 5
    while len(creados) < 4 and time.monotonic() < deadline:
        time.sleep(0.02)
    # Tiempo de sobra para una quinta conexión que NO debe ocurrir.
    time.sleep(0.5)
    ingestor.stop()
    thread.join(timeout=5)

    assert len(creados) == 4, (
        f"esperaba 1 conexión + 3 reconexiones (cuarentena), hubo {len(creados)}"
    )
