"""
Tests del arranque del ingestor SeedLink.

El bug que motivó estos tests: `run()` corre en un hilo daemon y no tenía
try/except. Si reventaba al conectar, la excepción moría dentro del hilo, el
proceso principal salía del `while thread.is_alive()` y terminaba con código 0.
Railway marcaba el deploy `SUCCESS` sobre un ingestor que no ingestaba nada, y
sin PYTHONUNBUFFERED los logs se perdían en el buffer: silencio total.
"""

import threading
from unittest.mock import MagicMock

import pytest

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
